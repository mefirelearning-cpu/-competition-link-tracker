ALTER TABLE daily_claims
  ADD COLUMN IF NOT EXISTS day_number_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS day_title_snapshot TEXT;

UPDATE daily_claims dc
SET day_number_snapshot = COALESCE(dc.day_number_snapshot,d.day_number),
    day_title_snapshot = COALESCE(dc.day_title_snapshot,d.title)
FROM competition_days d
WHERE dc.day_id=d.id;

ALTER TABLE daily_claims
  ALTER COLUMN day_id DROP NOT NULL;

ALTER TABLE daily_claims
  DROP CONSTRAINT IF EXISTS daily_claims_day_id_fkey;

ALTER TABLE daily_claims
  ADD CONSTRAINT daily_claims_day_id_fkey
  FOREIGN KEY (day_id) REFERENCES competition_days(id) ON DELETE SET NULL;

ALTER TABLE mission_completions
  ADD COLUMN IF NOT EXISTS mission_title_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS mission_points_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS mission_multiplier_snapshot NUMERIC(10,4);

UPDATE mission_completions mc
SET mission_title_snapshot = COALESCE(mc.mission_title_snapshot,m.title),
    mission_points_snapshot = COALESCE(mc.mission_points_snapshot,m.points_fixed),
    mission_multiplier_snapshot = COALESCE(mc.mission_multiplier_snapshot,m.multiplier)
FROM missions m
WHERE mc.mission_id=m.id;

ALTER TABLE mission_completions
  ALTER COLUMN mission_id DROP NOT NULL;

ALTER TABLE mission_completions
  DROP CONSTRAINT IF EXISTS mission_completions_mission_id_fkey;

ALTER TABLE mission_completions
  ADD CONSTRAINT mission_completions_mission_id_fkey
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL;
