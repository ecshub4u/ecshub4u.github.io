-- Phase 13: sub-folders (uploading a whole folder without zipping it).
--
-- Adds a `path` column so each file can record which sub-folder it sits in.
-- Run this ONCE on a database that was created before Phase 13:
--
--   npm run db:migrate-paths:local     (your local test database)
--   npm run db:migrate-paths:remote    (the real Cloudflare database)
--
-- A database created from the current schema.sql already has these columns,
-- so do NOT run this on a brand-new database -- SQLite would stop with a
-- "duplicate column name" error (harmless, but confusing).

ALTER TABLE files ADD COLUMN path TEXT NOT NULL DEFAULT '';
ALTER TABLE upload_sessions ADD COLUMN path TEXT NOT NULL DEFAULT '';
