import { Hono } from "hono";
import {
  insertFolder,
  listActiveFolders,
  getPublicFolder,
  getFolderWithSecrets,
  folderNameExists,
  renameFolder,
  updateManagementTokenHash,
  updateManagerPassword,
  softDeleteFolder,
  insertFileIfWithinQuota,
  listFilesForFolder,
  listFilesUnderPath,
  countFilesUnderPath,
  softDeleteFilesByIds,
  getFolderUsedBytes,
  insertUploadSession,
  getUploadSession,
  updateUploadSessionProgress,
  markUploadSessionDone,
  reclaimStaleUploadSessions,
} from "../db.js";
import {
  createDriveFolder,
  renameDriveFolder,
  trashDriveFolder,
  trashDriveFile,
  initiateResumableUpload,
  uploadResumableChunk,
  cancelResumableSession,
} from "../drive.js";
import { generateManagementToken, sha256Hex, newId } from "../crypto.js";
import { hashPassword, verifyPassword } from "../password.js";
import {
  validateFolderName,
  validatePassword,
  validateFileName,
  validateDirPath,
  validateManagerPassword,
  validateRecovery,
  validateAnswerList,
} from "../validate.js";
import { requireManagementAccess, assertManagementAccess, assertFolderViewAccess } from "../auth.js";
import {
  hashManagerPassword,
  hashRecoveryAnswers,
  managerPasswordMatches,
  recoveryAnswersMatch,
} from "../manager.js";
import {
  enforceUnlockRateLimit,
  resetUnlockRateLimit,
  enforceFolderCreateRateLimit,
  enforceUploadRateLimit,
  enforceManageLoginRateLimit,
  resetManageLoginRateLimit,
  enforceRecoveryRateLimit,
  resetRecoveryRateLimit,
  getClientIp,
} from "../rateLimit.js";
import { issueUnlockToken, issueManageToken } from "../session.js";
import { logSecurityEvent } from "../audit.js";
import { FOLDER_QUOTA_BYTES, UPLOAD_CHUNK_BYTES, UPLOAD_SESSION_TTL_MS, PATH_DELETE_BATCH } from "../constants.js";
import { Errors } from "../errors.js";

export const folders = new Hono();

function toPublicFolder(row) {
  const usedBytes = Number(row.used_bytes);
  return {
    id: row.id,
    name: row.name,
    protected: Boolean(row.is_protected),
    // "password": managed with a manager password (new folders).
    // "token": an older folder that is still managed with its management token.
    managerMode: row.has_manager_password ? "password" : "token",
    fileCount: Number(row.file_count),
    usedBytes,
    quotaBytes: FOLDER_QUOTA_BYTES,
    remainingBytes: Math.max(0, FOLDER_QUOTA_BYTES - usedBytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * POST /api/folders
 * body: { name: string, password?: string,
 *         managerPassword?: string, recovery?: [{ question, answer }, { question, answer }] }
 *   `password` is the optional VIEWING password. `managerPassword` (+ exactly
 *   two `recovery` questions and answers) is how the owner manages the folder
 *   afterwards -- the website always sends it. Without it the folder falls
 *   back to the older long management token (API-only use).
 * response: the folder + `managementToken` -- for a manager-password folder
 *   this is a signed-in manager SESSION (the website stores it silently; the
 *   person never sees or copies it); for an older-style folder it's the real
 *   management token, shown once.
 * Rate-limited per IP (there's no folder to key on yet). Creates the
 * Drive folder first (source of truth for storage), then the DB row. If
 * the DB write fails after the Drive folder was created, the Drive
 * folder is trashed so it doesn't become an orphan nobody can see.
 */
folders.post("/", async (c) => {
  const clientIp = getClientIp(c);
  await enforceFolderCreateRateLimit(c, clientIp);

  const body = await c.req.json().catch(() => ({}));
  const name = validateFolderName(body.name);
  const passwordHash = body.password != null && body.password !== ""
    ? await hashPassword(validatePassword(body.password))
    : null;

  // Validate the manager password and recovery questions up front, so a bad
  // request never reaches Drive.
  let managerSetup = null;
  if (body.managerPassword != null && body.managerPassword !== "") {
    const managerPassword = validateManagerPassword(body.managerPassword);
    if (body.password != null && managerPassword === body.password) {
      throw Errors.badRequest("The manager password must be different from the folder's viewing password.");
    }
    managerSetup = { managerPassword, recovery: validateRecovery(body.recovery) };
  }

  if (await folderNameExists(c, name)) {
    throw Errors.badRequest("A folder with that name already exists.");
  }

  const driveFolderId = await createDriveFolder(c.env, name);

  const id = newId();
  const managementToken = generateManagementToken();
  const managementTokenHash = await sha256Hex(managementToken);

  // For a manager-password folder the token above is never handed to anyone
  // (only its hash is stored, to satisfy the column) -- so the token path can
  // never be used to manage it. Its password + recovery answers are stored
  // as keyed hashes (see session.js > keyedHash).
  const managerFields = managerSetup
    ? {
        managerPasswordHash: await hashManagerPassword(c.env, id, managerSetup.managerPassword),
        recoveryQuestions: JSON.stringify(managerSetup.recovery.map((r) => r.question)),
        recoveryAnswersHash: await hashRecoveryAnswers(
          c.env,
          id,
          managerSetup.recovery.map((r) => r.answer)
        ),
      }
    : {};

  try {
    await insertFolder(c, { id, driveFolderId, name, passwordHash, managementTokenHash, ...managerFields });
  } catch (err) {
    console.error("DB insert failed after Drive folder was created, trashing orphan:", err);
    await trashDriveFolder(c.env, driveFolderId).catch((cleanupErr) =>
      console.error("Failed to clean up orphaned Drive folder:", cleanupErr)
    );
    throw Errors.internal(err.message);
  }

  await logSecurityEvent(c, "folder_created", { folderId: id, clientIp, detail: name });

  const folder = await getPublicFolder(c, id);
  return c.json(
    {
      ...toPublicFolder(folder),
      managementToken: managerSetup ? await issueManageToken(c.env, id, 1) : managementToken,
    },
    201
  );
});

/** GET /api/folders — list all active folders, public fields only. */
folders.get("/", async (c) => {
  const rows = await listActiveFolders(c);
  return c.json({ folders: rows.map(toPublicFolder) });
});

/** GET /api/folders/:id — a single folder's public metadata. */
folders.get("/:id", async (c) => {
  const row = await getPublicFolder(c, c.req.param("id"));
  if (!row) throw Errors.notFound("Folder");
  return c.json(toPublicFolder(row));
});

/**
 * POST /api/folders/:id/unlock
 * body: { password: string }
 * Rate-limited per (folder, client IP). On success, issues a short-lived
 * unlock token file/folder view routes accept in place of a password.
 */
folders.post("/:id/unlock", async (c) => {
  const id = c.req.param("id");
  const clientIp = getClientIp(c);

  await enforceUnlockRateLimit(c, id, clientIp); // throws Errors.rateLimited() if over the limit

  const folder = await getFolderWithSecrets(c, id);
  if (!folder) throw Errors.notFound("Folder");

  if (!folder.password_hash) {
    // Nothing to unlock — treat as trivially successful rather than an error.
    const token = await issueUnlockToken(c.env, id);
    return c.json({ unlocked: true, unlockToken: token });
  }

  const body = await c.req.json().catch(() => ({}));
  const suppliedPassword = typeof body.password === "string" ? body.password : "";
  const correct = await verifyPassword(suppliedPassword, folder.password_hash);
  if (!correct) {
    await logSecurityEvent(c, "unlock_failed", { folderId: id, clientIp });
    throw Errors.unauthorized("Incorrect password.");
  }

  await resetUnlockRateLimit(c, id, clientIp);
  await logSecurityEvent(c, "unlock_succeeded", { folderId: id, clientIp });
  const token = await issueUnlockToken(c.env, id);
  return c.json({ unlocked: true, unlockToken: token });
});

function toPublicFile(row) {
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    path: row.path || "", // sub-folder inside the folder ("" = top level)
  };
}

/**
 * GET /api/folders/:id/files — list a folder's files. Public folders:
 * open to anyone. Protected folders: requires an unlock token (from
 * POST /unlock) or the management token.
 */
folders.get("/:id/files", async (c) => {
  const id = c.req.param("id");
  const folder = await getFolderWithSecrets(c, id);
  if (!folder) throw Errors.notFound("Folder");

  await assertFolderViewAccess(c, folder);

  const rows = await listFilesForFolder(c, id);
  return c.json({ files: rows.map(toPublicFile) });
});

/**
 * POST /api/folders/:id/files — upload a file (multipart/form-data,
 * field name "file"). Rate-limited per IP. Public folders: anyone may
 * upload. Protected folders: only the management-token holder may
 * upload (deliberately stricter than viewing — see Memory.md's Product
 * Decisions). Quota is enforced atomically in the DB layer (see db.js >
 * insertFileIfWithinQuota); the pre-check here is just to avoid wasting
 * a Drive upload on an obviously-oversized file.
 */
/**
 * POST /api/folders/:id/uploads — start a chunked upload. Rate-limited
 * per IP. Public folders: anyone may upload. Protected folders: only the
 * management-token holder (deliberately stricter than viewing — see
 * Memory.md's Product Decisions).
 *
 * body: { name: string, path?: string, mimeType?: string, sizeBytes: number }
 *   `path` is the sub-folder the file goes in, e.g. "calendar/css" (omit or
 *   "" for the top level of the folder) -- see validate.js > validateDirPath.
 * response: { uploadId, chunkSize } — the client then PUTs the file in
 * chunkSize-sized pieces to PUT /api/folders/:id/uploads/:uploadId.
 *
 * Why two steps instead of one upload request: Cloudflare Workers' free
 * plan rejects any single request body over 100 MB *at the edge*, before
 * the Worker even runs — so a file has to arrive as multiple smaller
 * requests, which is exactly what Drive's own resumable upload protocol
 * is built for. See constants.js's UPLOAD_CHUNK_BYTES and drive.js's
 * header comment for the full reasoning.
 */
folders.post("/:id/uploads", async (c) => {
  const clientIp = getClientIp(c);
  await enforceUploadRateLimit(c, clientIp);

  const id = c.req.param("id");
  const folder = await getFolderWithSecrets(c, id);
  if (!folder) throw Errors.notFound("Folder");

  if (folder.password_hash) {
    await assertManagementAccess(c, folder);
  }

  const body = await c.req.json().catch(() => ({}));
  const originalName = validateFileName(body.name);
  const dirPath = validateDirPath(body.path);
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : null;
  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw Errors.badRequest("sizeBytes must be a positive integer.");
  }

  // Opportunistic cleanup of this folder's abandoned sessions, so they
  // don't accumulate forever — no Cron Trigger needed for this.
  const staleCutoff = new Date(Date.now() - UPLOAD_SESSION_TTL_MS).toISOString();
  const stale = await reclaimStaleUploadSessions(c, id, staleCutoff);
  for (const session of stale) {
    await cancelResumableSession(c.env, session.drive_session_uri);
  }

  // Cheap early rejection, before ever contacting Drive. Not the real
  // enforcement — see the completing chunk below, which uses Drive's
  // own authoritative byte count in the same atomic check the rest of
  // the app uses.
  const usedBytes = await getFolderUsedBytes(c, id);
  if (usedBytes + sizeBytes > FOLDER_QUOTA_BYTES) {
    await logSecurityEvent(c, "upload_quota_rejected", { folderId: id, clientIp, detail: `${sizeBytes} bytes (declared)` });
    throw Errors.quotaExceeded();
  }

  const driveSessionUri = await initiateResumableUpload(c.env, {
    name: originalName,
    parentId: folder.drive_folder_id,
    mimeType,
    sizeBytes,
  });

  const uploadId = newId();
  await insertUploadSession(c, { id: uploadId, folderId: id, driveSessionUri, originalName, mimeType, totalBytes: sizeBytes, path: dirPath });

  return c.json({ uploadId, chunkSize: UPLOAD_CHUNK_BYTES }, 201);
});

const CONTENT_RANGE_CHUNK = /^bytes (\d+)-(\d+)\/(\d+)$/;
const CONTENT_RANGE_STATUS_CHECK = /^bytes \*\/(\d+)$/;

/**
 * PUT /api/folders/:id/uploads/:uploadId — send one chunk (body = raw
 * bytes, header `Content-Range: bytes <start>-<end>/<total>`), or check
 * status after an interruption (empty body, header
 * `Content-Range: bytes *_/<total>` — see MDN's resumable-upload docs
 * for this exact convention). Possessing a valid uploadId is what
 * authorizes a chunk — the same capability-token model already used for
 * unlock/management tokens elsewhere, not re-checked per chunk, since
 * uploadId is only ever handed to whoever passed the real authorization
 * check at POST /uploads time.
 *
 * Always responds 200 with a JSON body describing progress — Drive's own
 * 308 "Resume Incomplete" is deliberately never relayed as our own HTTP
 * status, since a raw 308 would make `fetch()` on the client try to
 * follow it as an actual redirect instead of reading the response body.
 */
folders.put("/:id/uploads/:uploadId", async (c) => {
  const id = c.req.param("id");
  const uploadId = c.req.param("uploadId");
  const clientIp = getClientIp(c);

  const session = await getUploadSession(c, uploadId);
  if (!session || session.folder_id !== id) {
    throw Errors.notFound("Upload session");
  }

  const contentRange = c.req.header("Content-Range") || "";
  const statusCheckMatch = contentRange.match(CONTENT_RANGE_STATUS_CHECK);
  const chunkMatch = contentRange.match(CONTENT_RANGE_CHUNK);

  let result;
  if (statusCheckMatch) {
    result = await uploadResumableChunk(c.env, session.drive_session_uri, {
      chunkBytes: null,
      totalBytes: Number(statusCheckMatch[1]),
    });
  } else if (chunkMatch) {
    const [, startStr, endStr, totalStr] = chunkMatch;
    const chunkBytes = await c.req.arrayBuffer();
    result = await uploadResumableChunk(c.env, session.drive_session_uri, {
      chunkBytes,
      rangeStart: Number(startStr),
      rangeEnd: Number(endStr),
      totalBytes: Number(totalStr),
    });
  } else {
    throw Errors.badRequest("Missing or malformed Content-Range header.");
  }

  if (!result.done) {
    await updateUploadSessionProgress(c, uploadId, result.bytesConfirmed);
    return c.json({ done: false, bytesConfirmed: result.bytesConfirmed });
  }

  // Completing chunk: Drive has the whole file. Use ITS authoritative
  // size (not our tracked total, not the client's original declaration)
  // for the same atomic quota-check-and-insert used everywhere else —
  // see db.js > insertFileIfWithinQuota and its Phase 6 regression test.
  const driveFileId = result.file.id;
  const sizeBytes = Number(result.file.size);
  const fileId = newId();
  let insertedWithinQuota;

  try {
    insertedWithinQuota = await insertFileIfWithinQuota(
      c,
      {
        id: fileId,
        folderId: id,
        driveFileId,
        originalName: session.original_name,
        mimeType: session.mime_type,
        sizeBytes,
        path: session.path || "",
      },
      FOLDER_QUOTA_BYTES
    );
  } catch (err) {
    console.error("DB insert failed after Drive upload completed, trashing orphan:", err);
    await trashDriveFile(c.env, driveFileId).catch((cleanupErr) =>
      console.error("Failed to clean up orphaned Drive file:", cleanupErr)
    );
    await markUploadSessionDone(c, uploadId, "aborted");
    throw Errors.internal(err.message);
  }

  if (!insertedWithinQuota) {
    await trashDriveFile(c.env, driveFileId).catch((cleanupErr) =>
      console.error("Failed to clean up Drive file that lost the quota race:", cleanupErr)
    );
    await markUploadSessionDone(c, uploadId, "aborted");
    await logSecurityEvent(c, "upload_quota_rejected", { folderId: id, clientIp, detail: "lost concurrent-upload race" });
    throw Errors.quotaExceeded();
  }

  await markUploadSessionDone(c, uploadId, "completed");
  await logSecurityEvent(c, "file_uploaded", { folderId: id, clientIp, detail: `${session.original_name} (${sizeBytes} bytes)` });

  // The completing reply is the file object itself (no `done` wrapper) --
  // the client tells it apart from a progress reply ({ done: false, ... })
  // by the presence of `id`.
  return c.json(
    {
      id: fileId,
      name: session.original_name,
      mimeType: session.mime_type,
      sizeBytes,
      createdAt: new Date().toISOString(),
      path: session.path || "",
    },
    201
  );
});

/** DELETE /api/folders/:id/uploads/:uploadId — client-initiated cancel
 * (e.g. the user closes the upload dialog mid-transfer). Best-effort:
 * frees up the Drive-side session promptly instead of waiting for
 * opportunistic cleanup or Google's own ~1-week auto-expiry. */
folders.delete("/:id/uploads/:uploadId", async (c) => {
  const id = c.req.param("id");
  const uploadId = c.req.param("uploadId");

  const session = await getUploadSession(c, uploadId);
  if (!session || session.folder_id !== id) {
    throw Errors.notFound("Upload session");
  }

  await cancelResumableSession(c.env, session.drive_session_uri);
  await markUploadSessionDone(c, uploadId, "aborted");
  return c.json({ cancelled: true });
});

/**
 * DELETE /api/folders/:id/paths?path=calendar/css -- deletes a sub-folder:
 * every file at or below that path. Requires the management token (same
 * rule as deleting a single file). Files go to Drive's trash, so the owner
 * can still recover them.
 *
 * Deletes at most PATH_DELETE_BATCH files per call and reports how many
 * are left (`remaining`); the client keeps calling until it reaches 0.
 * That keeps each request under Cloudflare's free-plan cap on outgoing
 * requests (each file costs two calls to Google).
 * response: { deleted, failed, remaining, freedBytes }
 */
folders.delete("/:id/paths", async (c) => {
  const id = c.req.param("id");
  await requireManagementAccess(c, id);

  const dirPath = validateDirPath(c.req.query("path"));
  if (!dirPath) {
    throw Errors.badRequest("A sub-folder path is required.");
  }

  const batch = await listFilesUnderPath(c, id, dirPath, PATH_DELETE_BATCH);

  const trashedIds = [];
  let freedBytes = 0;
  let failed = 0;
  for (const file of batch) {
    try {
      await trashDriveFile(c.env, file.drive_file_id);
      trashedIds.push(file.id);
      freedBytes += Number(file.size_bytes);
    } catch (err) {
      failed += 1;
      console.error("Failed to trash a Drive file while deleting a sub-folder:", err);
    }
  }
  await softDeleteFilesByIds(c, trashedIds);

  if (batch.length > 0 && trashedIds.length === 0) {
    // Nothing got deleted at all -- surface it instead of letting the
    // client loop forever on the same failing files.
    throw Errors.upstream(`Drive refused to trash any of the ${batch.length} files under "${dirPath}".`);
  }

  const remaining = await countFilesUnderPath(c, id, dirPath);
  await logSecurityEvent(c, "path_deleted", {
    folderId: id,
    clientIp: getClientIp(c),
    detail: `${dirPath} (${trashedIds.length} files this batch, ${remaining} remaining)`,
  });

  return c.json({ deleted: trashedIds.length, failed, remaining, freedBytes });
});

/**
 * PATCH /api/folders/:id — rename. Requires the management token.
 * body: { name: string }
 */
folders.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const folder = await requireManagementAccess(c, id);

  const body = await c.req.json().catch(() => ({}));
  const name = validateFolderName(body.name);

  if (name.toLowerCase() !== folder.name.toLowerCase() && (await folderNameExists(c, name))) {
    throw Errors.badRequest("A folder with that name already exists.");
  }

  await renameDriveFolder(c.env, folder.drive_folder_id, name);
  await renameFolder(c, id, name);
  await logSecurityEvent(c, "folder_renamed", { folderId: id, clientIp: getClientIp(c), detail: `${folder.name} -> ${name}` });

  const updated = await getPublicFolder(c, id);
  return c.json(toPublicFolder(updated));
});

// ---------- Manager password: sign in, forgot it, change it ----------

async function requirePasswordFolder(c, id) {
  const folder = await getFolderWithSecrets(c, id);
  if (!folder || folder.status !== "active") throw Errors.notFound("Folder");
  if (!folder.manager_password_hash) {
    throw Errors.badRequest("This folder doesn't use a manager password.");
  }
  return folder;
}

/** A new manager password may not equal the folder's viewing password --
 * otherwise everyone who can view the folder could also manage it. */
async function assertDiffersFromViewPassword(folder, newPassword) {
  if (folder.password_hash && (await verifyPassword(newPassword, folder.password_hash))) {
    throw Errors.badRequest("The manager password must be different from the folder's viewing password.");
  }
}

/**
 * POST /api/folders/:id/manage/login   body: { password }
 * Sign in as the folder's manager. Rate-limited per folder + IP.
 * response: { managementToken } -- a manager session (30 days).
 */
folders.post("/:id/manage/login", async (c) => {
  const id = c.req.param("id");
  const clientIp = getClientIp(c);
  await enforceManageLoginRateLimit(c, id, clientIp);

  const folder = await requirePasswordFolder(c, id);
  const body = await c.req.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";

  if (!(await managerPasswordMatches(c.env, folder, password))) {
    await logSecurityEvent(c, "manage_login_failed", { folderId: id, clientIp });
    throw Errors.unauthorized("Incorrect manager password.");
  }
  await resetManageLoginRateLimit(c, id, clientIp);
  await logSecurityEvent(c, "manage_login_succeeded", { folderId: id, clientIp });
  return c.json({ managementToken: await issueManageToken(c.env, id, Number(folder.manager_version)) });
});

/**
 * GET /api/folders/:id/manage/recovery-questions
 * The two questions the owner chose (never the answers), so the "forgot my
 * password" screen can show them.
 */
folders.get("/:id/manage/recovery-questions", async (c) => {
  const folder = await requirePasswordFolder(c, c.req.param("id"));
  let questions = [];
  try {
    questions = JSON.parse(folder.recovery_questions || "[]");
  } catch {
    questions = [];
  }
  return c.json({ questions });
});

/**
 * POST /api/folders/:id/manage/reset   body: { answers: [..], newPassword }
 * "Forgot my manager password": answer the recovery questions to set a new
 * password. Tightly rate-limited (5/hour per IP, 20/day per folder). A
 * successful reset signs out every older manager session.
 * response: { managementToken } for the new session.
 */
folders.post("/:id/manage/reset", async (c) => {
  const id = c.req.param("id");
  const clientIp = getClientIp(c);
  await enforceRecoveryRateLimit(c, id, clientIp);

  const folder = await requirePasswordFolder(c, id);
  let questions = [];
  try {
    questions = JSON.parse(folder.recovery_questions || "[]");
  } catch {
    /* handled below */
  }
  if (questions.length === 0) throw Errors.badRequest("This folder has no recovery questions.");

  const body = await c.req.json().catch(() => ({}));
  // Checked before the answers, so a bad new password can never be used to
  // find out whether the answers were right.
  const newPassword = validateManagerPassword(body.newPassword);
  const answers = validateAnswerList(body.answers, questions.length);

  if (!(await recoveryAnswersMatch(c.env, folder, answers))) {
    await logSecurityEvent(c, "recovery_failed", { folderId: id, clientIp });
    throw Errors.unauthorized("Those answers don't match.");
  }
  await assertDiffersFromViewPassword(folder, newPassword);

  await updateManagerPassword(c, id, await hashManagerPassword(c.env, id, newPassword));
  await resetRecoveryRateLimit(c, id, clientIp);
  await logSecurityEvent(c, "manager_password_reset", { folderId: id, clientIp });
  return c.json({ managementToken: await issueManageToken(c.env, id, Number(folder.manager_version) + 1) });
});

/**
 * POST /api/folders/:id/manage/password   body: { currentPassword, newPassword }
 * Change the manager password while signed in. Needs BOTH a valid manager
 * session and the current password (so someone at a shared computer that's
 * still signed in can't quietly take the folder over). Signs out every other
 * session. response: { managementToken } for the new session.
 */
folders.post("/:id/manage/password", async (c) => {
  const id = c.req.param("id");
  const clientIp = getClientIp(c);
  await enforceManageLoginRateLimit(c, id, clientIp);

  const folder = await requirePasswordFolder(c, id);
  await assertManagementAccess(c, folder);

  const body = await c.req.json().catch(() => ({}));
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = validateManagerPassword(body.newPassword);

  if (!(await managerPasswordMatches(c.env, folder, currentPassword))) {
    await logSecurityEvent(c, "manage_login_failed", { folderId: id, clientIp, detail: "password change" });
    throw Errors.unauthorized("The current password is incorrect.");
  }
  await assertDiffersFromViewPassword(folder, newPassword);

  await updateManagerPassword(c, id, await hashManagerPassword(c.env, id, newPassword));
  await resetManageLoginRateLimit(c, id, clientIp);
  await logSecurityEvent(c, "manager_password_changed", { folderId: id, clientIp });
  return c.json({ managementToken: await issueManageToken(c.env, id, Number(folder.manager_version) + 1) });
});

/**
 * POST /api/folders/:id/rotate-token — invalidates the current management
 * token immediately and issues a new one, shown exactly once. For when a
 * token may have leaked (accidentally pasted somewhere public, shared
 * device, etc.) — the folder's owner doesn't have to delete and recreate
 * the folder just to regain exclusive control of it.
 */
folders.post("/:id/rotate-token", async (c) => {
  const id = c.req.param("id");
  const folder = await requireManagementAccess(c, id);
  if (folder.manager_password_hash) {
    throw Errors.badRequest("This folder is managed with a manager password -- change the password instead.");
  }

  const managementToken = generateManagementToken();
  const managementTokenHash = await sha256Hex(managementToken);
  await updateManagementTokenHash(c, id, managementTokenHash);
  await logSecurityEvent(c, "token_rotated", { folderId: id, clientIp: getClientIp(c) });

  return c.json({ managementToken }); // shown exactly once, same as at creation
});

/** DELETE /api/folders/:id — requires the management token. Trashes the
 * Drive folder (recoverable by the owner) and soft-deletes the DB row. */
folders.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const folder = await requireManagementAccess(c, id);

  await trashDriveFolder(c.env, folder.drive_folder_id);
  await softDeleteFolder(c, id);
  await logSecurityEvent(c, "folder_deleted", { folderId: id, clientIp: getClientIp(c), detail: folder.name });

  return c.json({ deleted: true });
});
