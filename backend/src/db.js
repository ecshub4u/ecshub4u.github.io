/**
 * Thin helpers around the D1 binding. Raw SQL (no ORM) keeps the dependency
 * list small and queries easy to read — see docs/Rules.md ("prefer stable,
 * well-documented libraries" / "don't add dependencies unless they solve a
 * real requirement").
 */

export function getDb(c) {
  const db = c.env.DB;
  if (!db) {
    throw new Error(
      "D1 binding 'DB' is not configured. Check wrangler.toml and that you've created + migrated the database."
    );
  }
  return db;
}

/** Simple connectivity check used by the health endpoint. */
export async function pingDb(c) {
  const db = getDb(c);
  const result = await db.prepare("SELECT 1 AS ok").first();
  return result?.ok === 1;
}

// ---------- Folders ----------
// Raw SQL, on purpose — see the file header. Each function does one query
// so route handlers stay readable and it's obvious what hits the DB.

export async function insertFolder(c, folder) {
  const db = getDb(c);
  await db
    .prepare(
      `INSERT INTO folders (id, drive_folder_id, name, password_hash, management_token_hash,
                            manager_password_hash, recovery_questions, recovery_answers_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      folder.id,
      folder.driveFolderId,
      folder.name,
      folder.passwordHash ?? null,
      folder.managementTokenHash,
      folder.managerPasswordHash ?? null,
      folder.recoveryQuestions ?? null, // JSON text of the 2 questions
      folder.recoveryAnswersHash ?? null
    )
    .run();
}

/** Public-safe folder fields only — never selects password_hash or
 * management_token_hash. File count/bytes come from Phase 5's files table
 * (empty for now, so these are always 0/0 until file upload exists). */
const PUBLIC_FOLDER_COLUMNS = `
  f.id, f.name, f.created_at, f.updated_at,
  (f.password_hash IS NOT NULL) AS is_protected,
  (f.manager_password_hash IS NOT NULL) AS has_manager_password,
  COUNT(files.id) AS file_count,
  COALESCE(SUM(files.size_bytes), 0) AS used_bytes
`;

export async function listActiveFolders(c) {
  const db = getDb(c);
  const { results } = await db
    .prepare(
      `SELECT ${PUBLIC_FOLDER_COLUMNS}
       FROM folders f
       LEFT JOIN files ON files.folder_id = f.id AND files.status = 'active'
       WHERE f.status = 'active'
       GROUP BY f.id
       ORDER BY f.updated_at DESC`
    )
    .all();
  return results;
}

export async function getPublicFolder(c, id) {
  const db = getDb(c);
  return db
    .prepare(
      `SELECT ${PUBLIC_FOLDER_COLUMNS}
       FROM folders f
       LEFT JOIN files ON files.folder_id = f.id AND files.status = 'active'
       WHERE f.id = ? AND f.status = 'active'
       GROUP BY f.id`
    )
    .bind(id)
    .first();
}

/** Includes management_token_hash — for internal auth checks only. Never
 * return the result of this function directly from a route. */
export async function getFolderWithSecrets(c, id) {
  const db = getDb(c);
  return db.prepare(`SELECT * FROM folders WHERE id = ? AND status = 'active'`).bind(id).first();
}

export async function folderNameExists(c, name) {
  const db = getDb(c);
  const row = await db
    .prepare(`SELECT id FROM folders WHERE lower(name) = lower(?) AND status = 'active'`)
    .bind(name)
    .first();
  return Boolean(row);
}

export async function renameFolder(c, id, name) {
  const db = getDb(c);
  await db
    .prepare(`UPDATE folders SET name = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(name, id)
    .run();
}

export async function updateManagementTokenHash(c, id, managementTokenHash) {
  const db = getDb(c);
  await db
    .prepare(`UPDATE folders SET management_token_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(managementTokenHash, id)
    .run();
}

/** Sets a new manager password and bumps manager_version, which signs out
 * every existing manager session (on every device). */
export async function updateManagerPassword(c, id, managerPasswordHash) {
  const db = getDb(c);
  await db
    .prepare(
      `UPDATE folders
       SET manager_password_hash = ?, manager_version = manager_version + 1, updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(managerPasswordHash, id)
    .run();
}

export async function softDeleteFolder(c, id) {
  const db = getDb(c);
  await db
    .prepare(`UPDATE folders SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

// ---------- Files ----------

export async function insertFile(c, file) {
  const db = getDb(c);
  await db
    .prepare(
      `INSERT INTO files (id, folder_id, drive_file_id, original_name, mime_type, size_bytes, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(file.id, file.folderId, file.driveFileId, file.originalName, file.mimeType, file.sizeBytes, file.path ?? "")
    .run();
}

/**
 * Same insert as insertFile, but the quota check and the write happen in
 * one atomic SQL statement instead of two round trips (check, then
 * insert). That closes the race two concurrent uploads could otherwise
 * hit: both reading "under quota" before either has written, together
 * pushing the folder over 1 GB. SQLite (what D1 runs on) executes a
 * single statement atomically, so no other write can land between this
 * statement's subquery read and its insert — see backend/README.md >
 * "Concurrent uploads" for the walkthrough and a local proof.
 *
 * Returns true if the file was inserted (within quota), false if the
 * insert was skipped because it would have gone over.
 */
export async function insertFileIfWithinQuota(c, file, quotaBytes) {
  const db = getDb(c);
  const result = await db
    .prepare(
      `INSERT INTO files (id, folder_id, drive_file_id, original_name, mime_type, size_bytes, path)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (
         SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE folder_id = ? AND status = 'active'
       ) + ? <= ?`
    )
    .bind(
      file.id,
      file.folderId,
      file.driveFileId,
      file.originalName,
      file.mimeType,
      file.sizeBytes,
      file.path ?? "",
      file.folderId,
      file.sizeBytes,
      quotaBytes
    )
    .run();
  return result.meta.changes === 1;
}

export async function listFilesForFolder(c, folderId) {
  const db = getDb(c);
  const { results } = await db
    .prepare(
      `SELECT id, original_name, mime_type, size_bytes, created_at, path
       FROM files
       WHERE folder_id = ? AND status = 'active'
       ORDER BY created_at DESC`
    )
    .bind(folderId)
    .all();
  return results;
}

/** Joins in just enough of the parent folder (password_hash,
 * management_token_hash, status) to make access-control decisions about
 * the file without a second query. Never return this row directly. */
export async function getFileWithFolder(c, fileId) {
  const db = getDb(c);
  return db
    .prepare(
      `SELECT
         files.id, files.folder_id, files.drive_file_id, files.original_name,
         files.mime_type, files.size_bytes, files.status AS file_status,
         folders.password_hash, folders.management_token_hash, folders.manager_version,
         folders.status AS folder_status
       FROM files
       JOIN folders ON folders.id = files.folder_id
       WHERE files.id = ?`
    )
    .bind(fileId)
    .first();
}

export async function softDeleteFile(c, fileId) {
  const db = getDb(c);
  await db.prepare(`UPDATE files SET status = 'deleted' WHERE id = ?`).bind(fileId).run();
}

export async function renameFile(c, fileId, name) {
  const db = getDb(c);
  await db.prepare(`UPDATE files SET original_name = ? WHERE id = ?`).bind(name, fileId).run();
}

// ---------- Sub-folders (virtual paths) ----------
// "Everything at or below sub-folder `dirPath`" means path = dirPath, or
// path starts with "dirPath/". That prefix test is written as a range
// (path >= 'dirPath/' AND path < 'dirPath0') rather than LIKE, because
// '0' is the character right after '/' -- so the range holds exactly the
// strings starting with "dirPath/", and a sub-folder name containing % or _
// can't be mistaken for a wildcard. A sibling like "calendar2" is never
// caught up in a delete of "calendar".

const UNDER_PATH_SQL = `folder_id = ? AND status = 'active'
       AND (path = ? OR (path >= ? AND path < ?))`;

function underPathParams(folderId, dirPath) {
  return [folderId, dirPath, `${dirPath}/`, `${dirPath}0`];
}

/** Up to `limit` active files at or below a sub-folder, oldest first. */
export async function listFilesUnderPath(c, folderId, dirPath, limit) {
  const db = getDb(c);
  const { results } = await db
    .prepare(
      `SELECT id, drive_file_id, size_bytes FROM files
       WHERE ${UNDER_PATH_SQL}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .bind(...underPathParams(folderId, dirPath), limit)
    .all();
  return results;
}

export async function countFilesUnderPath(c, folderId, dirPath) {
  const db = getDb(c);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM files WHERE ${UNDER_PATH_SQL}`)
    .bind(...underPathParams(folderId, dirPath))
    .first();
  return Number(row.n);
}

export async function softDeleteFilesByIds(c, fileIds) {
  if (fileIds.length === 0) return;
  const db = getDb(c);
  const placeholders = fileIds.map(() => "?").join(", ");
  await db.prepare(`UPDATE files SET status = 'deleted' WHERE id IN (${placeholders})`).bind(...fileIds).run();
}

// ---------- Upload sessions (chunked/resumable uploads) ----------

export async function insertUploadSession(c, session) {
  const db = getDb(c);
  await db
    .prepare(
      `INSERT INTO upload_sessions (id, folder_id, drive_session_uri, original_name, mime_type, total_bytes, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      session.id,
      session.folderId,
      session.driveSessionUri,
      session.originalName,
      session.mimeType,
      session.totalBytes,
      session.path ?? ""
    )
    .run();
}

export async function getUploadSession(c, id) {
  const db = getDb(c);
  return db.prepare(`SELECT * FROM upload_sessions WHERE id = ? AND status = 'active'`).bind(id).first();
}

export async function updateUploadSessionProgress(c, id, bytesReceived) {
  const db = getDb(c);
  await db.prepare(`UPDATE upload_sessions SET bytes_received = ? WHERE id = ?`).bind(bytesReceived, id).run();
}

export async function markUploadSessionDone(c, id, status) {
  const db = getDb(c);
  await db.prepare(`UPDATE upload_sessions SET status = ? WHERE id = ?`).bind(status, id).run();
}

/** Opportunistic cleanup, called when starting a new upload rather than
 * on a schedule (no Cron Trigger needed — one less thing to configure
 * before deployment). Returns the abandoned sessions so the caller can
 * also cancel them on Drive's side. */
export async function reclaimStaleUploadSessions(c, folderId, olderThanIso) {
  const db = getDb(c);
  const { results } = await db
    .prepare(`SELECT * FROM upload_sessions WHERE folder_id = ? AND status = 'active' AND created_at < ?`)
    .bind(folderId, olderThanIso)
    .all();
  if (results.length > 0) {
    await db
      .prepare(`UPDATE upload_sessions SET status = 'aborted' WHERE folder_id = ? AND status = 'active' AND created_at < ?`)
      .bind(folderId, olderThanIso)
      .run();
  }
  return results;
}

/** Sum of active file sizes in a folder — the live number the quota check
 * is measured against. No separate running counter is kept, so this can
 * never drift out of sync with the files that actually exist. */
export async function getFolderUsedBytes(c, folderId) {
  const db = getDb(c);
  const row = await db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files WHERE folder_id = ? AND status = 'active'`)
    .bind(folderId)
    .first();
  return Number(row.used);
}

// ---------- Rate limiting ----------
// Fixed-window counter, shared by any event_type (currently just
// 'unlock_attempt'). One row per (key, event_type, window). See rateLimit.js
// for the policy (window size, max attempts) — this file only knows SQL.

/** Increments (or creates) the counter for the current window and returns
 * the new count, in one atomic statement. */
export async function recordRateLimitAttempt(c, key, eventType, windowStartIso) {
  const db = getDb(c);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, event_type, count, window_start)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key, event_type, window_start)
       DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(key, eventType, windowStartIso)
    .first();
  return row.count;
}

/** Clears all windows for a key — used after a successful unlock so a
 * legitimate user isn't penalized by their own earlier typos. */
export async function clearRateLimit(c, key, eventType) {
  const db = getDb(c);
  await db.prepare(`DELETE FROM rate_limits WHERE key = ? AND event_type = ?`).bind(key, eventType).run();
}
