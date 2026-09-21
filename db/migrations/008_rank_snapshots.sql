CREATE TABLE IF NOT EXISTS rank_snapshots (
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  bucket_at TIMESTAMPTZ NOT NULL,
  rank INTEGER NOT NULL CHECK (rank > 0),
  points INTEGER NOT NULL DEFAULT 0,
  valid_clicks INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (competition_id, participant_id, bucket_at)
);

CREATE INDEX IF NOT EXISTS rank_snapshots_lookup_idx
  ON rank_snapshots (competition_id, participant_id, bucket_at DESC);

CREATE INDEX IF NOT EXISTS rank_snapshots_competition_idx
  ON rank_snapshots (competition_id, bucket_at DESC, rank);
