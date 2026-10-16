import type { Request, Response, NextFunction } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

import { asyncHandler } from '../middleware.js';
import type { ApiError } from '../middleware.js';
import { autoAcceptScanDetections } from '../ai/bin-acceptance-service.js';
import {
  insertScan,
  getScanById,
  getAllScans,
  getStats,
  isValidBinId,
} from '../queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve project root: prefer explicit env var (container-safe), fall back
// to relative resolution from this source file (dev on host machine).
const PROJECT_ROOT = process.env.APP_PROJECT_ROOT ||
  path.resolve(__dirname, '..', '..', '..');

// In containers, Python is available on PATH as `python3`. Locally, a
// venv may exist; prefer it when present.
const LOCAL_PYTHON = path.join(
  PROJECT_ROOT,
  'waste-cv-engine',
  '.venv',
  'bin',
  'python'
);
const PYTHON_EXECUTABLE = fs.existsSync(LOCAL_PYTHON) ? LOCAL_PYTHON : 'python3';
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'waste-cv-engine', 'main.py');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIMETYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const TEMP_DIR = path.join(PROJECT_ROOT, 'backend', 'temp');

// Maximum time (ms) to wait for the Python CV engine to finish inference.
const PYTHON_ENGINE_TIMEOUT_MS = 120_000;

function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function validateFile(file: Express.Multer.File): void {
  if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
    throw Object.assign(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'), { statusCode: 400 } as ApiError);
  }

  if (file.size > MAX_FILE_SIZE) {
    throw Object.assign(new Error('File too large. Maximum size is 5 MB.'), { statusCode: 400 } as ApiError);
  }
}

function validateBinId(binId: string | undefined): string {
  if (!binId) {
    throw Object.assign(new Error('bin_id is required. Must be one of: bin-01, bin-02.'), { statusCode: 400 } as ApiError);
  }

  if (!isValidBinId(binId)) {
    throw Object.assign(new Error(`Invalid bin_id "${binId}". Must be one of: bin-01, bin-02.`), { statusCode: 400 } as ApiError);
  }

  return binId;
}

function runPythonEngine(imagePath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn(PYTHON_EXECUTABLE, [PYTHON_SCRIPT, '--image', imagePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: path.join(PROJECT_ROOT, 'waste-cv-engine', 'src'),
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Hard timeout so a hung inference cannot block the request indefinitely.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        pythonProcess.kill('SIGTERM');
      } catch {
        // Ignore kill errors
      }
      reject(
        Object.assign(
          new Error(`Python engine timed out after ${PYTHON_ENGINE_TIMEOUT_MS}ms`),
          { statusCode: 504 } as ApiError
        )
      );
    }, PYTHON_ENGINE_TIMEOUT_MS);

    pythonProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });

    pythonProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    pythonProcess.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      reject(
        Object.assign(new Error(`Failed to spawn Python engine: ${err.message}`), { statusCode: 500 } as ApiError)
      );
    });

    pythonProcess.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      if (timedOut) {
        return; // Already rejected via timeout
      }
      if (code !== 0) {
        reject(
          Object.assign(
            new Error(`Python engine exited with code ${code}. Stderr: ${stderr.trim() || 'No error output'}`),
            { statusCode: 500 } as ApiError
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch {
        reject(
          Object.assign(
            new Error(`Failed to parse Python engine output. Stderr: ${stderr.trim() || 'No error output'}`),
            { statusCode: 500 } as ApiError
          )
        );
      }
    });
  });
}

export const createScan = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  ensureTempDir();

  // Validate bin_id BEFORE running the Python engine
  const binId = validateBinId(req.body.bin_id);

  if (!req.file) {
    throw Object.assign(new Error('No image file provided.'), { statusCode: 400 } as ApiError);
  }

  validateFile(req.file);

  const tempFilename = `scan_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const tempPath = path.join(TEMP_DIR, tempFilename);

  // Write uploaded buffer to temp file
  fs.writeFileSync(tempPath, req.file.buffer);

  try {
    const result = await runPythonEngine(tempPath);

    // Generate canonical scan ID (used both in response and persisted record)
    const canonicalScanId = crypto.randomUUID();

    // Insert into database with bin_id (non-fatal if DB is unavailable)
    let dbScanId: string | undefined;
    try {
      dbScanId = await insertScan(result, req.file.originalname, req.file.size, binId);
    } catch (dbErr) {
      // eslint-disable-next-line no-console
      console.error('[db] Failed to insert scan:', (dbErr as Error).message);
    }

    // Use the canonical scan ID consistently: prefer DB-generated, fall back to local
    const finalScanId = dbScanId || canonicalScanId;
    let acceptance = null;
    if (dbScanId) {
      try {
        acceptance = await autoAcceptScanDetections(dbScanId);
      } catch (acceptanceError) {
        console.error('[bin] Automatic capacity update failed:', (acceptanceError as Error).message);
      }
    }

    // Attach bin_id to the engine result for consistency in the response
    const resultWithBin = {
      ...(result && typeof result === 'object' ? result : {}),
      bin_id: binId,
      scan_id: finalScanId,
    };

    res.status(201).json({
      success: true,
      scan_id: finalScanId,
      bin_id: binId,
      data: resultWithBin,
      acceptance,
    });
  } finally {
    // Always remove the temp file
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
});

export const listScans = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const binId = req.query.bin_id as string | undefined;

  if (binId && !isValidBinId(binId)) {
    throw Object.assign(new Error(`Invalid bin_id "${binId}". Must be one of: bin-01, bin-02.`), { statusCode: 400 } as ApiError);
  }

  const limitParam = req.query.limit as string | undefined;
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 100) : 50;

  const scans = await getAllScans(binId, limit);

  res.status(200).json({
    success: true,
    bin_id: binId || null,
    count: scans.length,
    data: scans,
  });
});

export const getScan = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const scanId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const scan = await getScanById(scanId);
  if (!scan) {
    throw Object.assign(new Error('Scan not found'), { statusCode: 404 } as ApiError);
  }
  res.status(200).json({
    success: true,
    data: scan,
  });
});

export const getScanStats = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const binId = req.query.bin_id as string | undefined;

  if (binId && !isValidBinId(binId)) {
    throw Object.assign(new Error(`Invalid bin_id "${binId}". Must be one of: bin-01, bin-02.`), { statusCode: 400 } as ApiError);
  }

  const stats = await getStats(binId);

  const response: Record<string, unknown> = {
    success: true,
    bin_id: binId || null,
    data: {
      total_scans: stats.total_scans,
      total_detections: stats.total_detections,
      detections_by_label: stats.detections_by_label,
    },
  };

  // Document whether unassigned scans are included in all-bin stats
  if (!binId && stats.includes_unassigned) {
    (response.data as Record<string, unknown>).includes_unassigned = true;
    (response.data as Record<string, unknown>).unassigned_scans = stats.unassigned_scans;
  }

  res.status(200).json(response);
});
