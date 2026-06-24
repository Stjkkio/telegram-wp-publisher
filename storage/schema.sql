-- Sessions: one per user submission, tracks state through the full pipeline
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  media_group_id  TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  preview_payload TEXT,
  processed_at    INTEGER
);

-- Images attached to a session
CREATE TABLE IF NOT EXISTS session_images (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  telegram_file_id TEXT NOT NULL,
  local_path       TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

-- Idempotency keys to prevent duplicate publishing
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idem_key   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_session_images_session_sort ON session_images(session_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_session ON idempotency_keys(session_id);
