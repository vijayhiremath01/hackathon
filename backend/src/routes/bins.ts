import type { Request, Response, NextFunction } from 'express';

import { asyncHandler } from '../middleware.js';
import type { ApiError } from '../middleware.js';
import { getBins, getBinById, isValidBinId } from '../queries.js';

export const listBins = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const bins = await getBins();
  res.status(200).json({
    success: true,
    count: bins.length,
    data: bins,
  });
});

export const getBinDetails = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const binId = Array.isArray(req.params.binId) ? req.params.binId[0] : req.params.binId;

  if (!isValidBinId(binId)) {
    throw Object.assign(new Error(`Unknown bin "${binId}". Valid bins: bin-01, bin-02.`), { statusCode: 404 } as ApiError);
  }

  const bin = await getBinById(binId);
  if (!bin) {
    throw Object.assign(new Error(`Bin "${binId}" not found`), { statusCode: 404 } as ApiError);
  }

  res.status(200).json({
    success: true,
    data: bin,
  });
});
