-- Manager password + recovery questions (replaces the long management token
-- for NEW folders; older folders keep working with their token).
--
-- Run this ONCE on a database created before this feature:
--
--   npm run db:migrate-manager:local     (your local test database)
--   npm run db:migrate-manager:remote    (the real Cloudflare database)
--
-- If your database is even older (created before the sub-folder feature),
-- run  npm run db:migrate-paths:local  FIRST (migrations/001_...).
-- "duplicate column name" means that step was already done -- harmless,
-- just skip it. A database made from the current schema.sql already has
-- all of these columns; don't run either migration on it.

ALTER TABLE folders ADD COLUMN manager_password_hash TEXT;
ALTER TABLE folders ADD COLUMN recovery_questions TEXT;
ALTER TABLE folders ADD COLUMN recovery_answers_hash TEXT;
ALTER TABLE folders ADD COLUMN manager_version INTEGER NOT NULL DEFAULT 1;
