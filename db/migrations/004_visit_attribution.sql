ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS invalid_reason TEXT;

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS attribution_code TEXT;

CREATE TABLE IF NOT EXISTS visitor_attributions (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  visitor_id_hash TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  first_visit_id TEXT,
  visit_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (competition_id, visitor_id_hash)
);

CREATE INDEX IF NOT EXISTS visitor_attributions_participant_idx
  ON visitor_attributions (competition_id, participant_id, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS visits_valid_idx
  ON visits (competition_id, participant_id, is_valid, created_at DESC);

CREATE INDEX IF NOT EXISTS visits_unique_idx
  ON visits (competition_id, participant_id, is_unique, created_at DESC);
