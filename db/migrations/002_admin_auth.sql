CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disabled')),
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS admin_id TEXT;

ALTER TABLE admin_sessions
  ADD CONSTRAINT admin_sessions_admin_id_fkey
  FOREIGN KEY (admin_id)
  REFERENCES admin_accounts(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx
  ON admin_sessions (admin_id, expires_at);

CREATE INDEX IF NOT EXISTS admin_accounts_username_idx
  ON admin_accounts (username);
