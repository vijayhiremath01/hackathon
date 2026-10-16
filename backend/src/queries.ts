import { sql } from './db.js';
import type { ApiError } from './middleware.js';
import { asyncHandler } from './middleware.js';
import { IRRELEVANT_DETECTION_LABELS, POSSIBLE_WASTE_LABELS, normalizedLabel } from './ai/waste-policy.js';

const VALID_BIN_IDS = ['bin-01', 'bin-02'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidBinId(binId: string): boolean {
  return VALID_BIN_IDS.includes(binId);
}

export const initDb = async (): Promise<void> => {
  // Create bins table (idempotent)
  await sql`
    CREATE TABLE IF NOT EXISTS bins (
      bin_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Seed bins idempotently (ON CONFLICT DO NOTHING prevents duplicates on restart)
  await sql`
    INSERT INTO bins (bin_id, name, location)
    VALUES
      ('bin-01', 'Main Campus', 'Main Campus Building'),
      ('bin-02', 'Hostel Zone', 'Hostel Block A')
    ON CONFLICT (bin_id) DO NOTHING
  `;

  // Add bin_id column to scans table if it doesn't exist (idempotent migration)
  await sql`
    ALTER TABLE scans
    ADD COLUMN IF NOT EXISTS bin_id TEXT REFERENCES bins(bin_id)
  `;

  // Index for bin-based queries
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scans_bin_id_created_at
    ON scans(bin_id, created_at DESC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id UUID PRIMARY KEY,
      bin_id TEXT REFERENCES bins(bin_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ai_messages (
      id UUID PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL CHECK (char_length(content) <= 4000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ai_scan_interpretations (
      scan_id UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
      bin_id TEXT REFERENCES bins(bin_id) ON DELETE SET NULL,
      classification_status TEXT NOT NULL CHECK (classification_status IN ('pending', 'completed', 'failed')),
      prompt_version TEXT NOT NULL,
      model TEXT NOT NULL,
      interpretation JSONB,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_conversations_bin_updated ON ai_conversations(bin_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created ON ai_messages(conversation_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_interpretations_bin_updated ON ai_scan_interpretations(bin_id, updated_at DESC)`;

  // Demo-only acceptance policies. These labels are category proxies, not
  // verified material identification or campus recycling guidance.
  await sql`ALTER TABLE bins ADD COLUMN IF NOT EXISTS capacity_liters NUMERIC(8,2) NOT NULL DEFAULT 100`;
  await sql`ALTER TABLE bins ADD COLUMN IF NOT EXISTS current_fill_liters NUMERIC(8,2) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE bins ADD COLUMN IF NOT EXISTS near_full_percent NUMERIC(5,2) NOT NULL DEFAULT 80`;
  await sql`ALTER TABLE bins ADD COLUMN IF NOT EXISTS acceptance_policy JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_capacity_invariants') THEN ALTER TABLE bins ADD CONSTRAINT bins_capacity_invariants CHECK (capacity_liters > 0 AND current_fill_liters >= 0 AND current_fill_liters <= capacity_liters); END IF; END $$;`);
  await sql`UPDATE bins SET acceptance_policy = ${JSON.stringify({ demo: true, min_confidence: 0.65, label_rules: { bottle: { category: 'beverage_container', volume_liters: 0.5 } }, note: 'Demo policy: AI-identified bottle candidates at or above 65% detector confidence are added automatically when capacity allows. Bottle material and local recycling eligibility are not verified.' })}::jsonb WHERE bin_id IN ('bin-01', 'bin-02')`;
  await sql`
    CREATE TABLE IF NOT EXISTS bin_item_events (
      id UUID PRIMARY KEY,
      bin_id TEXT NOT NULL REFERENCES bins(bin_id),
      scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      detection_index INTEGER NOT NULL CHECK (detection_index >= 0),
      detection_label TEXT NOT NULL,
      item_category TEXT,
      estimated_volume_liters NUMERIC(8,3),
      acceptance_status TEXT NOT NULL CHECK (acceptance_status IN ('accepted', 'rejected', 'needs_review')),
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (scan_id, detection_index),
      CHECK ((acceptance_status = 'accepted' AND item_category IS NOT NULL AND estimated_volume_liters > 0) OR (acceptance_status <> 'accepted' AND estimated_volume_liters IS NULL))
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_bin_item_events_bin_created ON bin_item_events(bin_id, created_at DESC)`;

  // eslint-disable-next-line no-console
  console.log('[db] scans, bins, and AI tables initialized');
};

export const insertScan = async (
  result: unknown,
  imageFilename?: string,
  imageSize?: number,
  binId?: string
): Promise<string> => {
  const scanId = crypto.randomUUID();
  await sql`
    INSERT INTO scans (id, result, image_filename, image_size, bin_id)
    VALUES (${scanId}, ${JSON.stringify(result)}, ${imageFilename || null}, ${imageSize || null}, ${binId || null})
  `;
  return scanId;
};

export const getScanById = async (id: string): Promise<unknown | null> => {
  // Validate UUID format before querying
  try {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return null;
    }
  } catch {
    return null;
  }

  const rows = await sql`
    SELECT id, created_at, result, image_filename, image_size, bin_id
    FROM scans
    WHERE id = ${id}
  `;
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  // Parse JSONB result from string to object
  if (typeof row.result === 'string') {
    try {
      row.result = JSON.parse(row.result);
    } catch {
      // Leave as-is if not valid JSON
    }
  }
  return row;
};

export const getAllScans = async (
  binId?: string,
  limit?: number
): Promise<unknown[]> => {
  const lim = Math.min(limit || 50, 100);

  if (binId && isValidBinId(binId)) {
    const rows = await sql`
      SELECT id, created_at, result, image_filename, image_size, bin_id
      FROM scans
      WHERE bin_id = ${binId}
      ORDER BY created_at DESC
      LIMIT ${lim}
    `;
    return parseScanRows(rows);
  }

  const rows = await sql`
    SELECT id, created_at, result, image_filename, image_size, bin_id
    FROM scans
    ORDER BY created_at DESC
    LIMIT ${lim}
  `;
  return parseScanRows(rows);
};

function parseScanRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    if (typeof r.result === 'string') {
      try {
        r.result = JSON.parse(r.result as string);
      } catch {
        // Leave as-is if not valid JSON
      }
    }
    return r;
  });
}

export const getStats = async (
  binId?: string
): Promise<{
  total_scans: number;
  total_detections: number;
  detections_by_label: Record<string, number>;
  includes_unassigned?: boolean;
  unassigned_scans?: number;
}> => {
  const binFilter = binId && isValidBinId(binId)
    ? sql`WHERE bin_id = ${binId}`
    : sql``;

  const totalResult = await sql`
    SELECT COUNT(*) AS total_scans FROM scans ${binFilter}
  `;
  const totalScans = Number(totalResult[0]?.total_scans) || 0;

  const allScans = await sql`
    SELECT result FROM scans ${binFilter}
  `;
  let totalDetections = 0;
  const detectionsByLabel: Record<string, number> = {};

  for (const row of allScans) {
    let result = row.result;
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {
        continue;
      }
    }
    const scanResult = result as {
      summary?: { total_detections?: number; counts_by_label?: Record<string, number> };
    } | null;
    if (scanResult?.summary?.total_detections) {
      totalDetections += scanResult.summary.total_detections;
    }
    if (scanResult?.summary?.counts_by_label) {
      for (const [label, count] of Object.entries(scanResult.summary.counts_by_label)) {
        detectionsByLabel[label] = (detectionsByLabel[label] || 0) + Number(count);
      }
    }
  }

  const result: Record<string, unknown> = {
    total_scans: totalScans,
    total_detections: totalDetections,
    detections_by_label: detectionsByLabel,
  };

  // When no bin_id filter is applied, indicate whether unassigned scans are included
  if (!binId) {
    const unassignedResult = await sql`
      SELECT COUNT(*) AS unassigned_count FROM scans WHERE bin_id IS NULL
    `;
    const unassignedCount = Number(unassignedResult[0]?.unassigned_count) || 0;
    if (unassignedCount > 0) {
      result.includes_unassigned = true;
      result.unassigned_scans = unassignedCount;
    }
  }

  return result as {
    total_scans: number;
    total_detections: number;
    detections_by_label: Record<string, number>;
    includes_unassigned?: boolean;
    unassigned_scans?: number;
  };
};

export const getBins = async (): Promise<unknown[]> => {
  const rows = await sql`
    SELECT bin_id, name, location, created_at, capacity_liters, current_fill_liters,
           near_full_percent, acceptance_policy
    FROM bins
    ORDER BY bin_id
  `;

  const binsWithStats = [];
  for (const row of rows) {
    const binId = row.bin_id;
    const stats = await getStats(binId);
    const recentResult = await sql`
      SELECT created_at
      FROM scans
      WHERE bin_id = ${binId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    binsWithStats.push({
      bin_id: binId,
      name: row.name,
      location: row.location,
      total_scans: stats.total_scans,
      total_detections: stats.total_detections,
      detections_by_label: stats.detections_by_label,
      last_scan_at: recentResult[0]?.created_at || null,
      capacity: await getBinCapacityDetails(String(binId)),
    });
  }

  return binsWithStats;
};

export const getBinById = async (
  binId: string
): Promise<unknown | null> => {
  if (!isValidBinId(binId)) {
    return null;
  }

  const rows = await sql`
    SELECT bin_id, name, location, created_at, capacity_liters, current_fill_liters,
           near_full_percent, acceptance_policy
    FROM bins
    WHERE bin_id = ${binId}
  `;
  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  const stats = await getStats(binId);

  // Recent scan history (last 10 scans, metadata only - no raw detection payloads)
  const recentScans = await sql`
    SELECT id, created_at, bin_id, image_filename, result
    FROM scans
    WHERE bin_id = ${binId}
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const scanHistory = recentScans.map((r) => {
    const scanRow = r as Record<string, unknown>;
    let result = scanRow.result;
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {
        result = null;
      }
    }
    const summary = (result as { summary?: { total_detections?: number; counts_by_label?: Record<string, number> } })?.summary;
    return {
      scan_id: scanRow.id,
      created_at: scanRow.created_at,
      image_filename: scanRow.image_filename,
      total_detections: summary?.total_detections || 0,
      counts_by_label: summary?.counts_by_label || {},
    };
  });

  // Most recent scan timestamp
  const mostRecent = await sql`
    SELECT created_at
    FROM scans
    WHERE bin_id = ${binId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const capacity = await getBinCapacityDetails(binId);

  return {
    bin_id: row.bin_id,
    name: row.name,
    location: row.location,
    total_scans: stats.total_scans,
    total_detections: stats.total_detections,
    detections_by_label: stats.detections_by_label,
    last_scan_at: mostRecent[0]?.created_at || null,
    recent_scans: scanHistory,
    capacity,
    acceptance_policy: capacity.acceptance_policy,
    recent_item_events: capacity.recent_item_events,
  };
};

export type BinCapacityDetails = {
  bin_id: string;
  capacity_liters: number;
  current_fill_liters: number;
  remaining_liters: number;
  capacity_percentage: number;
  status: 'AVAILABLE' | 'NEAR FULL' | 'FULL';
  near_full_percent: number;
  acceptance_policy: Record<string, unknown>;
  recent_item_events: Array<Record<string, unknown>>;
};

export async function getBinCapacityDetails(binId: string, db = sql): Promise<BinCapacityDetails> {
  const rows = await db`
    SELECT bin_id, capacity_liters, current_fill_liters, near_full_percent, acceptance_policy
    FROM bins WHERE bin_id = ${binId}
  `;
  const row = rows[0];
  if (!row) throw Object.assign(new Error('Bin not found.'), { statusCode: 404 });
  const capacityLiters = Number(row.capacity_liters) || 100;
  const fillLiters = Number(row.current_fill_liters) || 0;
  const percent = capacityLiters > 0 ? Math.max(0, Math.min(100, (fillLiters / capacityLiters) * 100)) : 0;
  const threshold = Number(row.near_full_percent) || 80;
  const events = await db`
    SELECT id, scan_id, detection_index, detection_label, item_category,
           estimated_volume_liters, acceptance_status, reason, created_at
    FROM bin_item_events WHERE bin_id = ${binId}
    ORDER BY created_at DESC LIMIT 10
  `;
  return {
    bin_id: String(row.bin_id), capacity_liters: capacityLiters, current_fill_liters: fillLiters,
    remaining_liters: Math.max(0, capacityLiters - fillLiters), capacity_percentage: percent,
    status: percent >= 100 ? 'FULL' : percent >= threshold ? 'NEAR FULL' : 'AVAILABLE',
    near_full_percent: threshold,
    acceptance_policy: (typeof row.acceptance_policy === 'string' ? JSON.parse(row.acceptance_policy) : row.acceptance_policy || {}) as Record<string, unknown>,
    recent_item_events: events as unknown as Array<Record<string, unknown>>,
  };
}

export type AiConversation = {
  id: string;
  bin_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type AiMessage = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: Date | string;
};

export async function createAiConversation(binId: string | null): Promise<AiConversation> {
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO ai_conversations (id, bin_id)
    VALUES (${id}, ${binId})
    RETURNING id, bin_id, created_at, updated_at
  `;
  return rows[0] as AiConversation;
}

export async function getAiConversation(id: string): Promise<AiConversation | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const rows = await sql`
    SELECT id, bin_id, created_at, updated_at
    FROM ai_conversations WHERE id = ${id}
  `;
  return (rows[0] as AiConversation | undefined) || null;
}

export async function getAiMessages(conversationId: string, limit = 20): Promise<AiMessage[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const rows = await sql`
    SELECT id, conversation_id, role, content, created_at
    FROM ai_messages
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
  return [...rows].reverse() as unknown as AiMessage[];
}

export async function appendAiMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<AiMessage> {
  const id = crypto.randomUUID();
  const rows = await sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO ai_messages (id, conversation_id, role, content)
      VALUES (${id}, ${conversationId}, ${role}, ${content})
      RETURNING id, conversation_id, role, content, created_at
    `;
    await tx`UPDATE ai_conversations SET updated_at = NOW() WHERE id = ${conversationId}`;
    return inserted;
  });
  return rows[0] as AiMessage;
}

export async function getAiContextData(binId: string | null) {
  const bins = binId ? [await getBinById(binId)].filter(Boolean) : await getBins();
  const stats = await getStats(binId || undefined);
  const recent = await getAllScans(binId || undefined, 10) as Array<Record<string, unknown>>;
  const utcStart = new Date();
  utcStart.setUTCHours(0, 0, 0, 0);
  const todayRows = binId
    ? await sql`SELECT result FROM scans WHERE bin_id = ${binId} AND created_at >= ${utcStart}`
    : await sql`SELECT result FROM scans WHERE created_at >= ${utcStart}`;
  const todayCounts: Record<string, number> = {};
  let todayDetections = 0;
  for (const row of todayRows) {
    const result = parseJson(row.result) as { summary?: { total_detections?: number; counts_by_label?: Record<string, number> } } | null;
    todayDetections += Number(result?.summary?.total_detections || 0);
    for (const [label, count] of Object.entries(result?.summary?.counts_by_label || {})) {
      todayCounts[label] = (todayCounts[label] || 0) + Number(count || 0);
    }
  }
  const scans = recent.map((row) => {
    const result = parseJson(row.result) as { detections?: Array<{ label?: string; confidence?: number }> } | null;
    return {
      scan_id: row.id,
      bin_id: row.bin_id,
      created_at: row.created_at,
      detections: (result?.detections || []).slice(0, 30).map((detection) => ({
        label: String(detection.label || 'unknown').slice(0, 80),
        confidence: typeof detection.confidence === 'number' ? Math.max(0, Math.min(1, detection.confidence)) : null,
      })),
    };
  });
  const completedInterpretations = binId
    ? await sql`SELECT interpretation FROM ai_scan_interpretations WHERE bin_id = ${binId} AND classification_status = 'completed'`
    : await sql`SELECT interpretation FROM ai_scan_interpretations WHERE classification_status = 'completed'`;
  let confirmedItems = 0;
  let possibleItems = 0;
  let excludedItems = 0;
  for (const row of completedInterpretations) {
    const interpretation = parseJson(row.interpretation) as { confirmed_waste_items?: unknown[]; possible_waste_items?: unknown[]; excluded_detections?: unknown[] } | null;
    confirmedItems += interpretation?.confirmed_waste_items?.length || 0;
    possibleItems += interpretation?.possible_waste_items?.length || 0;
    excludedItems += interpretation?.excluded_detections?.length || 0;
  }
  const rawLabels = stats.detections_by_label;
  return {
    generated_at: new Date().toISOString(),
    scope: binId ? 'selected_bin' : 'campus',
    bins,
    aggregate: stats,
    today: { scans: todayRows.length, detections: todayDetections, detections_by_label: todayCounts },
    recent_scans: scans,
    waste_policy: {
      note: 'Raw YOLO detections are not confirmed waste. Generic labels alone cannot prove an item was discarded or its material.',
      raw_possible_candidate_labels: Object.fromEntries(Object.entries(rawLabels).filter(([label]) => POSSIBLE_WASTE_LABELS.has(normalizedLabel(label)))),
      raw_irrelevant_labels_excluded: Object.fromEntries(Object.entries(rawLabels).filter(([label]) => IRRELEVANT_DETECTION_LABELS.has(normalizedLabel(label)))),
      stored_ai_interpretations: { completed_scans: completedInterpretations.length, confirmed_waste_items: confirmedItems, possible_waste_items: possibleItems, excluded_or_unknown_detections: excludedItems },
    },
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export type StoredInterpretation = {
  scan_id: string;
  bin_id: string | null;
  classification_status: 'completed' | 'failed' | 'pending';
  prompt_version: string;
  model: string;
  interpretation: unknown | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function getScanInterpretation(scanId: string): Promise<StoredInterpretation | null> {
  if (!UUID_PATTERN.test(scanId)) return null;
  const rows = await sql`
    SELECT scan_id, bin_id, classification_status, prompt_version, model,
           interpretation, error_message, created_at, updated_at
    FROM ai_scan_interpretations WHERE scan_id = ${scanId}
  `;
  const row = rows[0] as StoredInterpretation | undefined;
  if (row && typeof row.interpretation === 'string') row.interpretation = parseJson(row.interpretation);
  return row || null;
}

export async function saveScanInterpretation(input: {
  scanId: string;
  binId: string | null;
  status: 'completed' | 'failed' | 'pending';
  promptVersion: string;
  model: string;
  interpretation: unknown | null;
  errorMessage: string | null;
}): Promise<StoredInterpretation> {
  const rows = await sql`
    INSERT INTO ai_scan_interpretations
      (scan_id, bin_id, classification_status, prompt_version, model, interpretation, error_message)
    VALUES
      (${input.scanId}, ${input.binId}, ${input.status}, ${input.promptVersion}, ${input.model},
       ${input.interpretation === null ? null : JSON.stringify(input.interpretation)}::jsonb, ${input.errorMessage})
    ON CONFLICT (scan_id) DO UPDATE SET
      bin_id = EXCLUDED.bin_id,
      classification_status = EXCLUDED.classification_status,
      prompt_version = EXCLUDED.prompt_version,
      model = EXCLUDED.model,
      interpretation = EXCLUDED.interpretation,
      error_message = EXCLUDED.error_message,
      updated_at = NOW()
    RETURNING scan_id, bin_id, classification_status, prompt_version, model,
              interpretation, error_message, created_at, updated_at
  `;
  const row = rows[0] as StoredInterpretation;
  if (typeof row.interpretation === 'string') row.interpretation = parseJson(row.interpretation);
  return row;
}
