CREATE TABLE IF NOT EXISTS point_rules (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  base_points INTEGER NOT NULL DEFAULT 0,
  multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
  daily_cap_points INTEGER,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, action_type)
);

CREATE TABLE IF NOT EXISTS burst_rules (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  bonus_points INTEGER NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 1 CHECK (daily_limit > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS point_rules_competition_idx
  ON point_rules (competition_id, action_type);

CREATE INDEX IF NOT EXISTS burst_rules_competition_idx
  ON burst_rules (competition_id, enabled);

INSERT INTO point_rules
  (id, competition_id, action_type, enabled, base_points, multiplier, daily_cap_points, settings)
SELECT
  'rule_' || md5(c.id || ':valid_click'),
  c.id,
  'valid_click',
  TRUE,
  1,
  1,
  60,
  '{"seededDefault":true}'::jsonb
FROM competitions c
ON CONFLICT (competition_id, action_type) DO NOTHING;
