-- ECS Drive — initial schema (Phase 2: structure only, no routes use it yet)
-- Matches the data model in docs/Architecture.md.

CREATE TABLE IF NOT EXISTS folders (
  id                     TEXT PRIMARY KEY,
  parent_folder_id       TEXT REFERENCES folders(id),
  drive_folder_id        TEXT NOT NULL,
  name                   TEXT NOT NULL,
  password_hash          TEXT,              -- NULL = not password-protected
  management_token_hash  TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  status                 TEXT NOT NULL DEFAULT 'active',
  -- Manager password (replaces the long management token for new folders).
  -- NULL manager_password_hash = an older folder that still uses its token.
  manager_password_hash  TEXT,                       -- keyed hash of the manager password
  recovery_questions     TEXT,                       -- JSON array with the 2 recovery questions
  recovery_answers_hash  TEXT,                       -- keyed hash of both (normalized) answers
  manager_version        INTEGER NOT NULL DEFAULT 1  -- bumped on every password change/reset: signs out old sessions
);

CREATE TABLE IF NOT EXISTS files (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT NOT NULL REFERENCES folders(id),
  drive_file_id   TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  status          TEXT NOT NULL DEFAULT 'active',
  path            TEXT NOT NULL DEFAULT ''  -- sub-folder inside the folder, e.g. 'calendar/css'; '' = top level
);

-- Used for both password-unlock attempt limiting and general security events.
CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT NOT NULL,   -- e.g. folder id, or client IP+folder id
  event_type    TEXT NOT NULL,   -- e.g. 'unlock_attempt'
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, event_type, window_start)
);

-- Append-only audit trail for security-relevant actions (Phase 7). Never
-- read back by the API for any decision — write-only, for the owner to
-- inspect if something looks wrong. See src/audit.js.
CREATE TABLE IF NOT EXISTS security_events (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,   -- e.g. 'unlock_failed', 'folder_deleted'
  folder_id   TEXT,            -- nullable: some events aren't folder-scoped
  client_ip   TEXT,
  detail      TEXT,            -- short human-readable context, no secrets
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracks an in-progress chunked (resumable) upload to Google Drive. One
-- row per upload; deleted on completion, or left for opportunistic
-- cleanup if abandoned. See src/drive.js's resumable-upload functions
-- and the Phase-12 write-up in docs/Memory.md for why this exists.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                 TEXT PRIMARY KEY,
  folder_id          TEXT NOT NULL REFERENCES folders(id),
  drive_session_uri  TEXT NOT NULL,
  original_name      TEXT NOT NULL,
  mime_type          TEXT,
  total_bytes        INTEGER NOT NULL,
  bytes_received     INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active', -- active | completed | aborted
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  path               TEXT NOT NULL DEFAULT ''        -- sub-folder the finished file will live in
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_security_events_folder ON security_events(folder_id);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_folder ON upload_sessions(folder_id);
