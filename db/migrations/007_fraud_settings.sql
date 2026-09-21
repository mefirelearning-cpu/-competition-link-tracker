CREATE TABLE IF NOT EXISTS fraud_settings (
  competition_id TEXT PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  unique_click_window_hours INTEGER NOT NULL DEFAULT 2160 CHECK (unique_click_window_hours >= 1),
  daily_click_cap INTEGER,
  burst_detection_window_minutes INTEGER NOT NULL DEFAULT 5 CHECK (burst_detection_window_minutes >= 1),
  max_clicks_per_visitor INTEGER NOT NULL DEFAULT 8 CHECK (max_clicks_per_visitor >= 1),
  suspicious_threshold INTEGER NOT NULL DEFAULT 20 CHECK (suspicious_threshold >= 1),
  block_obvious_bots BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO fraud_settings (competition_id)
SELECT id FROM competitions
ON CONFLICT (competition_id) DO NOTHING;
