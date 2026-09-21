ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_idempotency_key_uidx
  ON notifications (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
