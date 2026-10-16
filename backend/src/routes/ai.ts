import type { NextFunction, Request, Response } from 'express';
import { asyncHandler } from '../middleware.js';
import {
  appendAiMessage,
  createAiConversation,
  getAiContextData,
  getAiConversation,
  getAiMessages,
  getScanById,
  getScanInterpretation,
  isValidBinId,
} from '../queries.js';
import { buildChatMessages, needsCampusComparison } from '../ai/context-builder.js';
import { complete, GROQ_MODEL } from '../ai/groq-client.js';
import { AI_PROMPT_VERSION } from '../ai/system-prompt.js';
import { classifyStoredScan } from '../ai/recycling-service.js';
import { autoAcceptScanCandidates, autoAcceptScanDetections } from '../ai/bin-acceptance-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rateWindows = new Map<string, { start: number; count: number }>();
const routeParam = (value: string | string[] | undefined): string => Array.isArray(value) ? value[0] || '' : value || '';

export function aiRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = req.ip || 'unknown';
  let window = rateWindows.get(key);
  if (!window || now - window.start >= 60_000) {
    window = { start: now, count: 0 };
    rateWindows.set(key, window);
  }
  window.count += 1;
  if (window.count > 30) {
    res.status(429).json({ success: false, error: 'Too many AI requests. Please wait a minute and try again.' });
    return;
  }
  if (rateWindows.size > 1000) {
    for (const [ip, state] of rateWindows) if (now - state.start > 120_000) rateWindows.delete(ip);
  }
  next();
}

function requestedBin(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isValidBinId(value)) return undefined;
  return value;
}

export const createConversation = asyncHandler(async (req: Request, res: Response) => {
  const binId = requestedBin(req.body?.bin_id);
  if (binId === undefined) {
    res.status(400).json({ success: false, error: 'bin_id must be bin-01, bin-02, or null.' });
    return;
  }
  const conversation = await createAiConversation(binId);
  res.status(201).json({ success: true, data: { conversation_id: conversation.id, bin_id: conversation.bin_id, created_at: conversation.created_at } });
});

export const getConversationMessages = asyncHandler(async (req: Request, res: Response) => {
  const id = routeParam(req.params.conversationId);
  if (!UUID.test(id)) {
    res.status(400).json({ success: false, error: 'conversation_id must be a UUID.' });
    return;
  }
  const conversation = await getAiConversation(id);
  if (!conversation) {
    res.status(404).json({ success: false, error: 'Conversation not found.' });
    return;
  }
  const messages = await getAiMessages(id, 20);
  res.status(200).json({ success: true, data: { conversation_id: id, bin_id: conversation.bin_id, messages } });
});

export const chat = asyncHandler(async (req: Request, res: Response) => {
  const conversationId = req.body?.conversation_id;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const binId = requestedBin(req.body?.bin_id);
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
    res.status(400).json({ success: false, error: 'A valid conversation_id is required.' });
    return;
  }
  if (!message || message.length > 2000) {
    res.status(400).json({ success: false, error: 'message must contain between 1 and 2000 characters.' });
    return;
  }
  if (binId === undefined) {
    res.status(400).json({ success: false, error: 'bin_id must be bin-01, bin-02, or null.' });
    return;
  }
  const conversation = await getAiConversation(conversationId);
  if (!conversation) {
    res.status(404).json({ success: false, error: 'Conversation not found. Start a new conversation.' });
    return;
  }
  if (conversation.bin_id !== binId) {
    res.status(403).json({ success: false, error: 'This conversation belongs to a different bin.' });
    return;
  }

  const { messages, context } = await buildChatMessages(binId, conversationId, message);
  await appendAiMessage(conversationId, 'user', message);
  const answer = await complete(messages, 800);
  await appendAiMessage(conversationId, 'assistant', answer);
  const asksForScanData = /scan|detect|material|today|stat|count|history|latest/i.test(message);
  const sources = asksForScanData ? context.recent_scans.map((scan) => ({ type: 'scan', scan_id: scan.scan_id, bin_id: scan.bin_id })) : [];
  res.status(200).json({ success: true, data: { conversation_id: conversationId, answer, bin_id: binId, sources, model: GROQ_MODEL, prompt_version: AI_PROMPT_VERSION, scope: needsCampusComparison(message) ? 'campus' : binId || 'campus' } });
});

export const classifyScan = asyncHandler(async (req: Request, res: Response) => {
  const scanId = routeParam(req.params.scanId);
  if (!UUID.test(scanId)) {
    res.status(400).json({ success: false, error: 'scan_id must be a UUID.' });
    return;
  }
  const detectorAcceptance = await autoAcceptScanDetections(scanId);
  const result = await classifyStoredScan(scanId);
  const acceptance = await autoAcceptScanCandidates(scanId, result.interpretation as unknown as Record<string, unknown>);
  res.status(200).json({ success: true, data: result.interpretation, cached: result.cached, acceptance: acceptance.results.length ? acceptance : detectorAcceptance });
});

export const getScanClassification = asyncHandler(async (req: Request, res: Response) => {
  const scanId = routeParam(req.params.scanId);
  if (!UUID.test(scanId)) {
    res.status(400).json({ success: false, error: 'scan_id must be a UUID.' });
    return;
  }
  const scan = await getScanById(scanId);
  if (!scan) {
    res.status(404).json({ success: false, error: 'Scan not found.' });
    return;
  }
  const interpretation = await getScanInterpretation(scanId);
  if (!interpretation) {
    res.status(404).json({ success: false, error: 'This scan has not been interpreted yet.' });
    return;
  }
  res.status(200).json({ success: true, data: interpretation });
});

export const campusSummary = asyncHandler(async (_req: Request, res: Response) => {
  const data = await getAiContextData(null);
  res.status(200).json({ success: true, data });
});
