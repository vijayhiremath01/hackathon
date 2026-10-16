import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import multer from 'multer';

import { errorHandler, notFoundHandler } from './middleware.js';
import { initDb } from './queries.js';
import { sql } from './db.js';
import {
  createScan,
  listScans,
  getScan,
  getScanStats,
} from './routes/scans.js';
import {
  listBins,
  getBinDetails,
} from './routes/bins.js';
import {
  aiRateLimit,
  campusSummary,
  chat,
  classifyScan,
  createConversation,
  getConversationMessages,
  getScanClassification,
} from './routes/ai.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Multer - memory storage so we control temp file creation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// Routes
app.get('/api/health', (_req, res) => {
  res.status(200).json({ success: true, status: 'ok', service: 'waste-cv-backend' });
});

// Bin endpoints
app.get('/api/bins', listBins);
app.get('/api/bins/:binId', getBinDetails);

// Scan endpoints
app.post('/api/scans', upload.single('image'), createScan);
app.get('/api/scans', listScans);
app.get('/api/scans/:id', getScan);
app.get('/api/stats', getScanStats);

// AI routes use only controlled, parameterized database context and keep the
// Groq key on this server. Conversation IDs are opaque because auth is absent.
app.post('/api/ai/conversations', aiRateLimit, createConversation);
app.get('/api/ai/conversations/:conversationId/messages', getConversationMessages);
app.post('/api/ai/chat', aiRateLimit, chat);
app.get('/api/ai/campus-summary', campusSummary);
app.post('/api/ai/scans/:scanId/classify', aiRateLimit, classifyScan);
app.get('/api/ai/scans/:scanId/interpretation', getScanClassification);

// 404
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Start server
async function start(): Promise<void> {
  // Initialize database in the background; don't block server startup
  initDb().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[db] Initialization failed (DB-dependent routes will error):', err.message);
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[server] Running on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown: stop accepting new connections, close DB pool, exit
  async function shutdown(signal: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.info(`[server] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      // eslint-disable-next-line no-console
      console.info('[server] HTTP server closed');
    });
    try {
      await sql.end();
      // eslint-disable-next-line no-console
      console.info('[server] Database pool closed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[db] Error closing pool:', err);
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] Failed to start:', err);
  process.exit(1);
});