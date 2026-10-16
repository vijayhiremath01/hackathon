-- Initialize the ReBin backend database
-- Run with: psql "$POSTGRES_URL" -f db/init.sql

-- Create bins table (idempotent)
CREATE TABLE IF NOT EXISTS bins (
  bin_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed bins (idempotent: ON CONFLICT DO NOTHING prevents duplicates on re-run)
INSERT INTO bins (bin_id, name, location)
VALUES
  ('bin-01', 'Main Campus', 'Main Campus Building'),
  ('bin-02', 'Hostel Zone', 'Hostel Block A')
ON CONFLICT (bin_id) DO NOTHING;

-- Create scans table if not exists (preserves existing data)
CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB NOT NULL,
  image_filename TEXT,
  image_size INTEGER,
  bin_id TEXT REFERENCES bins(bin_id)
);

-- Index for faster lookups by created_at
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC);

-- Index for bin-based queries
CREATE INDEX IF NOT EXISTS idx_scans_bin_id_created_at
ON scans(bin_id, created_at DESC);

-- Index for JSONB queries (optional, for future filtering)
CREATE INDEX IF NOT EXISTS idx_scans_result_gin ON scans USING GIN(result);

-- Persistent AI conversations and separately stored scan interpretations.
-- Original scans.result JSONB is never modified by these tables.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY,
  bin_id TEXT REFERENCES bins(bin_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (char_length(content) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_bin_updated
ON ai_conversations(bin_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
ON ai_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_interpretations_bin_updated
ON ai_scan_interpretations(bin_id, updated_at DESC);

-- Persisted capacity and configurable, explicitly demo-only acceptance rules.
ALTER TABLE bins ADD COLUMN IF NOT EXISTS capacity_liters NUMERIC(8,2) NOT NULL DEFAULT 100;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS current_fill_liters NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS near_full_percent NUMERIC(5,2) NOT NULL DEFAULT 80;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS acceptance_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_capacity_invariants') THEN
    ALTER TABLE bins ADD CONSTRAINT bins_capacity_invariants
      CHECK (capacity_liters > 0 AND current_fill_liters >= 0 AND current_fill_liters <= capacity_liters);
  END IF;
END $$;

UPDATE bins SET acceptance_policy = '{"demo":true,"min_confidence":0.65,"label_rules":{"bottle":{"category":"beverage_container","volume_liters":0.5}},"note":"Demo policy: AI-identified bottle candidates at or above 65% detector confidence are added automatically when capacity allows. Bottle material and local recycling eligibility are not verified."}'::jsonb
WHERE bin_id IN ('bin-01', 'bin-02');

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
);
CREATE INDEX IF NOT EXISTS idx_bin_item_events_bin_created
ON bin_item_events(bin_id, created_at DESC);
