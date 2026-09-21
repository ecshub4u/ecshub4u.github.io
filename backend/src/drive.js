import { Errors } from "./errors.js";

/**
 * Minimal Google Drive v3 client for folder operations and chunked
 * (resumable) file uploads.
 *
 * Auth model: the project owner authorizes this app ONCE against their own
 * Google account and we store the resulting OAuth refresh token as a
 * secret (GOOGLE_REFRESH_TOKEN). Every request exchanges it for a
 * short-lived access token. This is deliberately NOT a service account —
 * service accounts have their own separate (usually empty) Drive storage,
 * not the owner's personal Drive, which is where files need to live. See
 * backend/README.md > "Google Drive setup" for the one-time authorization
 * steps. Never use a browsing student's access token here — this
 * credential belongs to the project, not to any one request.
 *
 * Upload architecture (Phase 12): every Drive request, including every
 * chunk of a resumable upload, is made *from this file, server-side*.
 * The browser never receives a Drive session URI or any Drive credential
 * — it only ever talks to our own API, which relays to Drive. This was a
 * deliberate choice over having the browser PUT chunks directly to
 * Google's session URI (which would avoid proxying bytes through the
 * Worker at all): Google's own docs for the near-identical Cloud Storage
 * resumable protocol warn that a session URI "can be used by anyone... 
 * without any further authentication," and Drive's own behavior on that
 * point wasn't confirmed precisely enough to hand a live one to a
 * browser — so this keeps every authorization/quota/rate-limit check
 * exactly where it already lived, at the cost of one extra network hop
 * per chunk. See docs/Memory.md's Phase 12 entry for the full reasoning.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

async function getAccessToken(env) {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
  for (const key of required) {
    if (!env[key]) {
      throw Errors.internal(`Missing secret ${key} — see backend/README.md > Google Drive setup.`);
    }
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Errors.upstream(`Google token refresh failed (${response.status}): ${detail}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function driveFetch(env, path, options = {}) {
  const accessToken = await getAccessToken(env);
  const response = await fetch(`${DRIVE_FILES_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Errors.upstream(`Google Drive API error (${response.status}) on ${path}: ${detail}`);
  }

  // DELETE-style calls can return an empty body.
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function createDriveFolder(env, name) {
  if (!env.GOOGLE_ROOT_FOLDER_ID) {
    throw Errors.internal("GOOGLE_ROOT_FOLDER_ID is not configured — see backend/README.md.");
  }
  const file = await driveFetch(env, "", {
    method: "POST",
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [env.GOOGLE_ROOT_FOLDER_ID],
    }),
  });
  return file.id;
}

export async function renameDriveFolder(env, driveFolderId, newName) {
  await driveFetch(env, `/${driveFolderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: newName }),
  });
}

/** Moves the folder to Drive's trash rather than permanently erasing it,
 * so an accidental or malicious delete stays recoverable by the owner. */
export async function trashDriveFolder(env, driveFolderId) {
  await driveFetch(env, `/${driveFolderId}`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: true }),
  });
}

// ---------- Resumable (chunked) file uploads ----------

/**
 * Starts a resumable upload session and returns Google's session URI.
 * This request carries only metadata (name/size/type), never file bytes
 * — the actual content is sent in separate uploadResumableChunk() calls,
 * which is what lets a single file exceed Cloudflare Workers' 100 MB
 * single-request body cap without ever sending Google (or us) a request
 * anywhere near that size.
 */
export async function initiateResumableUpload(env, { name, parentId, mimeType, sizeBytes }) {
  const accessToken = await getAccessToken(env);
  const response = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,size,mimeType`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType || "application/octet-stream",
      "X-Upload-Content-Length": String(sizeBytes),
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Errors.upstream(`Google Drive resumable-upload initiation failed (${response.status}): ${detail}`);
  }

  const sessionUri = response.headers.get("Location");
  if (!sessionUri) {
    throw Errors.upstream("Google Drive did not return a resumable session URI.");
  }
  return sessionUri;
}

/**
 * Sends one chunk (or, with chunkBytes=null, a zero-byte status-check
 * request) to an existing resumable session. Returns:
 *   - { done: false, bytesConfirmed } for an intermediate chunk (Drive
 *     replies 308 Resume Incomplete; bytesConfirmed comes from Drive's
 *     own Range response header, not our own bookkeeping, so a client
 *     resuming after a dropped connection resumes from what Drive
 *     actually has, not what we last recorded).
 *   - { done: true, file } once Drive has the whole file (200/201),
 *     where `file` is Drive's own resource for it (id/name/size/mimeType
 *     — `size` here is Drive's authoritative count of bytes it received,
 *     which is what quota enforcement is keyed to, not any client- or
 *     server-side running total that could drift).
 */
export async function uploadResumableChunk(env, sessionUri, { chunkBytes, rangeStart, rangeEnd, totalBytes }) {
  const accessToken = await getAccessToken(env);
  const isStatusCheck = chunkBytes === null;

  const headers = { Authorization: `Bearer ${accessToken}` };
  if (isStatusCheck) {
    headers["Content-Range"] = `bytes */${totalBytes}`;
    headers["Content-Length"] = "0";
  } else {
    headers["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${totalBytes}`;
    headers["Content-Length"] = String(chunkBytes.byteLength ?? chunkBytes.length);
  }

  const response = await fetch(sessionUri, {
    method: "PUT",
    headers,
    body: isStatusCheck ? undefined : chunkBytes,
  });

  if (response.status === 308) {
    const rangeHeader = response.headers.get("Range"); // e.g. "bytes=0-8388607"
    const bytesConfirmed = rangeHeader ? Number(rangeHeader.split("-")[1]) + 1 : 0;
    return { done: false, bytesConfirmed };
  }

  if (response.status === 200 || response.status === 201) {
    let file = await response.json();
    // Defensive fallback: the `fields` requested at session-initiation
    // time should carry through to this response, but if `size` is
    // somehow missing, fetch it explicitly rather than let quota
    // enforcement silently use an unreliable number.
    if (file.size === undefined) {
      file = await driveFetch(env, `/${file.id}?fields=id,name,size,mimeType`);
    }
    return { done: true, file };
  }

  const detail = await response.text();
  throw Errors.upstream(`Google Drive resumable upload chunk failed (${response.status}): ${detail}`);
}

/** Best-effort cancellation of an abandoned resumable session, so it
 * doesn't sit incomplete on Drive's side until Google's own ~1-week
 * auto-expiry. Never throws — cleanup failing is not worth failing the
 * request that triggered it. */
export async function cancelResumableSession(env, sessionUri) {
  try {
    const accessToken = await getAccessToken(env);
    await fetch(sessionUri, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    console.error("Failed to cancel abandoned Drive resumable session (non-fatal):", err);
  }
}

/** Returns the raw fetch Response (not parsed as JSON) so the caller can
 * stream response.body straight through to the client without buffering
 * the whole file in Worker memory. */
export async function downloadDriveFile(env, driveFileId) {
  const accessToken = await getAccessToken(env);
  const response = await fetch(`${DRIVE_FILES_URL}/${driveFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Errors.upstream(`Google Drive download failed (${response.status}): ${detail}`);
  }
  return response;
}

export async function trashDriveFile(env, driveFileId) {
  await driveFetch(env, `/${driveFileId}`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: true }),
  });
}
