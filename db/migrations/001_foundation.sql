CREATE TABLE IF NOT EXISTS competitions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Africa/Douala',
  registrations_open BOOLEAN NOT NULL DEFAULT TRUE,
  leaderboard_visible BOOLEAN NOT NULL DEFAULT TRUE,
  leaderboard_frozen BOOLEAN NOT NULL DEFAULT FALSE,
  winner_count INTEGER NOT NULL DEFAULT 1 CHECK (winner_count >= 1),
  max_participants INTEGER,
  rules TEXT NOT NULL DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  pseudonym TEXT NOT NULL,
  whatsapp_normalized TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','blocked','archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS participants_whatsapp_unique
  ON participants (whatsapp_normalized)
  WHERE whatsapp_normalized IS NOT NULL;

CREATE TABLE IF NOT EXISTS competition_participants (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','disqualified','withdrawn')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_points_cache INTEGER NOT NULL DEFAULT 0,
  raw_clicks_cache INTEGER NOT NULL DEFAULT 0,
  unique_clicks_cache INTEGER NOT NULL DEFAULT 0,
  valid_clicks_cache INTEGER NOT NULL DEFAULT 0,
  rank_cache INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (competition_id, participant_id),
  UNIQUE (competition_id, referral_code)
);

CREATE INDEX IF NOT EXISTS competition_participants_competition_idx
  ON competition_participants (competition_id);

CREATE INDEX IF NOT EXISTS competition_participants_rank_idx
  ON competition_participants (competition_id, total_points_cache DESC, unique_clicks_cache DESC);

CREATE TABLE IF NOT EXISTS point_transactions (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  campaign_id TEXT,
  event_id TEXT,
  type TEXT NOT NULL,
  base_points INTEGER NOT NULL DEFAULT 0,
  multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
  final_points INTEGER NOT NULL,
  source_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'system',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS point_transactions_participant_idx
  ON point_transactions (competition_id, participant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS point_transactions_type_idx
  ON point_transactions (competition_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  campaign_id TEXT,
  visitor_id TEXT NOT NULL,
  referrer TEXT,
  user_agent_summary TEXT,
  ip_hash TEXT,
  is_unique BOOLEAN NOT NULL DEFAULT FALSE,
  is_valid BOOLEAN NOT NULL DEFAULT FALSE,
  fraud_score NUMERIC(7,4) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS visits_competition_time_idx
  ON visits (competition_id, created_at DESC);

CREATE INDEX IF NOT EXISTS visits_visitor_idx
  ON visits (competition_id, visitor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS visits_participant_idx
  ON visits (competition_id, participant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx
  ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_logs_time_idx
  ON admin_audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  visitor_id TEXT,
  risk_score NUMERIC(7,4) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','ignored','invalidated','suspended','blocked')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fraud_flags_open_idx
  ON fraud_flags (competition_id, status, created_at DESC);
