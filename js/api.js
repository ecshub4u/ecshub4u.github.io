/**
 * Thin fetch wrapper around the ECS Drive backend API.
 *
 * Backend URL is read from window.ECS_DRIVE_API_BASE, set in a small
 * inline script in index.html *before* this file loads — that's the one
 * line to change when pointing this at a deployed backend instead of
 * localhost (see Phase 10 in docs/Phases.md).
 */

const API_BASE = window.ECS_DRIVE_API_BASE || "http://localhost:8787";

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parseJsonSafely(response) {
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request(path, { method = "GET", body, headers = {}, isJson = true } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (isJson) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    } else {
      opts.body = body; // e.g. FormData — browser sets its own Content-Type + boundary
    }
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, opts);
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", {
      status: 0,
      code: "network_error",
    });
  }

  const data = await parseJsonSafely(response);

  if (!response.ok) {
    const message = data?.error?.message || `Something went wrong (${response.status}).`;
    throw new ApiError(message, { status: response.status, code: data?.error?.code });
  }

  return data;
}

function authHeaderFor({ managementToken, unlockToken } = {}) {
  if (managementToken) {
    // A manager session (from signing in with the manager password) starts
    // with "mgr."; anything else is an older folder's long management token.
    return { Authorization: managementToken.startsWith("mgr.") ? `Manage ${managementToken}` : `Bearer ${managementToken}` };
  }
  if (unlockToken) return { Authorization: `Unlock ${unlockToken}` };
  return {};
}

export const api = {
  listFolders: () => request("/api/folders"),
  getFolder: (id) => request(`/api/folders/${id}`),

  createFolder: ({ name, password, managerPassword, recovery }) =>
    request("/api/folders", {
      method: "POST",
      body: {
        name,
        ...(password ? { password } : {}),
        ...(managerPassword ? { managerPassword, recovery } : {}),
      },
    }),

  // Manager password: sign in, "forgot it", change it.
  manageLogin: (id, password) =>
    request(`/api/folders/${id}/manage/login`, { method: "POST", body: { password } }),
  getRecoveryQuestions: (id) => request(`/api/folders/${id}/manage/recovery-questions`),
  resetManagerPassword: (id, { answers, newPassword }) =>
    request(`/api/folders/${id}/manage/reset`, { method: "POST", body: { answers, newPassword } }),
  changeManagerPassword: (id, { currentPassword, newPassword }, managementToken) =>
    request(`/api/folders/${id}/manage/password`, {
      method: "POST",
      headers: authHeaderFor({ managementToken }),
      body: { currentPassword, newPassword },
    }),

  unlockFolder: (id, password) => request(`/api/folders/${id}/unlock`, { method: "POST", body: { password } }),

  rotateToken: (id, managementToken) =>
    request(`/api/folders/${id}/rotate-token`, { method: "POST", headers: authHeaderFor({ managementToken }) }),

  renameFolder: (id, name, managementToken) =>
    request(`/api/folders/${id}`, { method: "PATCH", body: { name }, headers: authHeaderFor({ managementToken }) }),

  deleteFolder: (id, managementToken) =>
    request(`/api/folders/${id}`, { method: "DELETE", headers: authHeaderFor({ managementToken }) }),

  listFiles: (id, access) => request(`/api/folders/${id}/files`, { headers: authHeaderFor(access) }),

  deleteFile: (fileId, managementToken) =>
    request(`/api/files/${fileId}`, { method: "DELETE", headers: authHeaderFor({ managementToken }) }),

  /** Deletes a sub-folder (every file at or below `path`). The server does
   * it in small batches -- call again while `remaining` is above 0. */
  deletePath: (folderId, path, managementToken) =>
    request(`/api/folders/${folderId}/paths?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: authHeaderFor({ managementToken }),
    }),

  renameFile: (fileId, name, managementToken) =>
    request(`/api/files/${fileId}`, { method: "PATCH", body: { name }, headers: authHeaderFor({ managementToken }) }),

  /**
   * Chunked upload (Phase 12 — replaces the old single-request version).
   * Splits the file into `chunkSize`-sized pieces (server-specified, from
   * the initiate response) and PUTs them one at a time, so no single
   * request ever approaches Cloudflare's 100 MB body-size ceiling — the
   * only thing bounding a file's size is the folder's own 1 GB quota,
   * matching the "no artificial per-file limit" requirement. On a failed
   * chunk, checks with the server what Drive actually has before
   * retrying (a request can fail after its bytes already landed), so a
   * flaky connection resumes instead of corrupting the upload.
   */
  async uploadFile(folderId, file, { managementToken, onProgress, dirPath } = {}) {
    const { uploadId, chunkSize } = await request(`/api/folders/${folderId}/uploads`, {
      method: "POST",
      headers: authHeaderFor({ managementToken }),
      body: {
        name: file.name,
        ...(dirPath ? { path: dirPath } : {}), // sub-folder inside the folder, e.g. "calendar/css"
        mimeType: file.type || undefined,
        sizeBytes: file.size,
      },
    });

    async function putChunk({ chunkBytes, rangeStart, rangeEnd, totalBytes }) {
      const isStatusCheck = chunkBytes === null;
      const response = await fetch(`${API_BASE}/api/folders/${folderId}/uploads/${uploadId}`, {
        method: "PUT",
        headers: {
          "Content-Range": isStatusCheck ? `bytes */${totalBytes}` : `bytes ${rangeStart}-${rangeEnd}/${totalBytes}`,
        },
        body: isStatusCheck ? undefined : chunkBytes,
      });
      const data = await parseJsonSafely(response);
      if (!response.ok) {
        throw new ApiError(data?.error?.message || `Upload failed (${response.status}).`, {
          status: response.status,
          code: data?.error?.code,
        });
      }
      return data;
    }

    let offset = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;

    while (true) {
      const end = Math.min(offset + chunkSize, file.size) - 1;
      const chunkBytes = await file.slice(offset, end + 1).arrayBuffer();

      let result;
      try {
        result = await putChunk({ chunkBytes, rangeStart: offset, rangeEnd: end, totalBytes: file.size });
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) throw err;
        try {
          const status = await putChunk({ chunkBytes: null, totalBytes: file.size });
          offset = status.done ? file.size : status.bytesConfirmed;
        } catch {
          // Status check failed too -- retry from the same offset next loop.
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * consecutiveFailures));
        continue;
      }

      if (result.done || result.id) {
        if (onProgress) onProgress(1);
        return result; // { id, name, mimeType, sizeBytes, createdAt }
      }

      offset = result.bytesConfirmed;
      if (onProgress) onProgress(offset / file.size);
    }
  },

  /** Fetches the file as a blob (so protected-folder Authorization headers
   * can be sent — a plain <a href> download can't carry custom headers)
   * and triggers a normal browser download from it. */
  async downloadFile(fileId, filename, access) {
    const response = await fetch(`${API_BASE}/api/files/${fileId}`, { headers: authHeaderFor(access) });
    if (!response.ok) {
      const data = await parseJsonSafely(response);
      throw new ApiError(data?.error?.message || `Download failed (${response.status}).`, {
        status: response.status,
        code: data?.error?.code,
      });
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
