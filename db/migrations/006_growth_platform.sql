CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  short_text TEXT NOT NULL DEFAULT '',
  commercial_text TEXT NOT NULL DEFAULT '',
  image_data TEXT,
  destination_url TEXT,
  whatsapp_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','paused','ended')),
  points_share INTEGER NOT NULL DEFAULT 0,
  points_click INTEGER NOT NULL DEFAULT 0,
  points_interest INTEGER NOT NULL DEFAULT 0,
  points_lead INTEGER NOT NULL DEFAULT 0,
  points_referral INTEGER NOT NULL DEFAULT 0,
  points_retention INTEGER NOT NULL DEFAULT 0,
  points_sale INTEGER NOT NULL DEFAULT 0,
  multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
  conversion_multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
  daily_share_limit INTEGER NOT NULL DEFAULT 1,
  click_daily_cap INTEGER,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, slug)
);

CREATE INDEX IF NOT EXISTS campaigns_competition_status_idx
  ON campaigns (competition_id, status, featured);

CREATE TABLE IF NOT EXISTS competition_days (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL CHECK (day_number > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_data TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','finished')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  reward_daily_points INTEGER NOT NULL DEFAULT 0,
  featured_campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  marketing_message TEXT NOT NULL DEFAULT '',
  notification_text TEXT NOT NULL DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, day_number)
);

CREATE INDEX IF NOT EXISTS competition_days_schedule_idx
  ON competition_days (competition_id, status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  day_id TEXT REFERENCES competition_days(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  points_fixed INTEGER NOT NULL DEFAULT 0,
  multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
  validation_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (validation_mode IN ('automatic','manual')),
  max_completions INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','finished')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS missions_day_idx
  ON missions (competition_id, day_id, status);

CREATE TABLE IF NOT EXISTS mission_completions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected')),
  point_transaction_id TEXT REFERENCES point_transactions(id) ON DELETE SET NULL,
  proof_data TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mission_id, participant_id)
);

CREATE TABLE IF NOT EXISTS daily_claims (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  day_id TEXT NOT NULL REFERENCES competition_days(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  point_transaction_id TEXT REFERENCES point_transactions(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day_id, participant_id)
);

CREATE INDEX IF NOT EXISTS daily_claims_participant_idx
  ON daily_claims (competition_id, participant_id, claimed_at DESC);

CREATE TABLE IF NOT EXISTS streak_rules (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  consecutive_days INTEGER NOT NULL CHECK (consecutive_days > 1),
  bonus_points INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, consecutive_days)
);

CREATE TABLE IF NOT EXISTS campaign_share_events (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'generic',
  rewarded BOOLEAN NOT NULL DEFAULT FALSE,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_share_events_idx
  ON campaign_share_events (competition_id, campaign_id, participant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interests (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  source_participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  visitor_id_hash TEXT NOT NULL,
  reference_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'interest'
    CHECK (status IN ('interest','lead_confirmed','sale_confirmed','rejected')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, visitor_id_hash)
);

CREATE INDEX IF NOT EXISTS interests_queue_idx
  ON interests (competition_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  interest_id TEXT NOT NULL UNIQUE REFERENCES interests(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','rejected')),
  point_transaction_id TEXT REFERENCES point_transactions(id) ON DELETE SET NULL,
  confirmed_by TEXT NOT NULL DEFAULT 'admin',
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS leads_competition_idx
  ON leads (competition_id, campaign_id, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  interest_id TEXT NOT NULL UNIQUE REFERENCES interests(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  amount NUMERIC(14,2),
  currency TEXT NOT NULL DEFAULT 'XAF',
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','rejected','refunded')),
  point_transaction_id TEXT REFERENCES point_transactions(id) ON DELETE SET NULL,
  confirmed_by TEXT NOT NULL DEFAULT 'admin',
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sales_competition_idx
  ON sales (competition_id, campaign_id, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS prizes (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','reserved','chosen','disabled')),
  chosen_by_participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  chosen_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prizes_competition_idx
  ON prizes (competition_id, status, sort_order);

CREATE TABLE IF NOT EXISTS prize_selections (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  prize_id TEXT NOT NULL UNIQUE REFERENCES prizes(id) ON DELETE RESTRICT,
  winner_rank INTEGER NOT NULL,
  selected_by TEXT NOT NULL DEFAULT 'participant',
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, participant_id)
);

CREATE TABLE IF NOT EXISTS reward_tiers (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  min_points INTEGER NOT NULL DEFAULT 0,
  max_points INTEGER,
  reward_type TEXT NOT NULL DEFAULT 'discount',
  reward_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  validity_days INTEGER,
  eligible_services JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reward_tiers_competition_idx
  ON reward_tiers (competition_id, enabled, min_points);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  reward_tier_id TEXT REFERENCES reward_tiers(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  reward_type TEXT NOT NULL,
  reward_value NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','used','expired','cancelled')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS coupons_participant_idx
  ON coupons (competition_id, participant_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  competition_id TEXT REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT,
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_feed_idx
  ON notifications (competition_id, participant_id, created_at DESC);
