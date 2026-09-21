/**
 * A canned-response stand-in for global fetch, covering exactly the
 * Google endpoints src/drive.js calls -- OAuth token refresh, Drive
 * folder create/rename/trash, file download, and (Phase 12) the full
 * resumable-upload protocol: initiate, chunk PUTs (tracking simulated
 * per-session progress so multi-chunk and status-check scenarios behave
 * like the real thing), and session cancellation. Tests install this
 * with installFakeFetch() before calling anything that hits Drive, so
 * nothing here ever touches the real network -- there isn't any in this
 * environment anyway.
 */

let callLog = [];
let uploadSessions = new Map(); // sessionUri -> { totalBytes, bytesReceived, name, mimeType }
let sessionCounter = 0;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

async function fakeFetch(url, options = {}) {
  const urlStr = String(url);
  callLog.push({ url: urlStr, method: options.method || "GET" });

  if (urlStr.startsWith("https://oauth2.googleapis.com/token")) {
    return jsonResponse({ access_token: "fake-access-token", expires_in: 3600 });
  }

  // ---- Resumable upload: initiate ----
  if (urlStr.includes("/upload/drive/v3/files") && urlStr.includes("uploadType=resumable") && options.method === "POST") {
    const metadata = JSON.parse(options.body);
    const totalBytes = Number(headerValue(options.headers, "X-Upload-Content-Length") ?? 0);
    const mimeType = headerValue(options.headers, "X-Upload-Content-Type") ?? "application/octet-stream";
    sessionCounter += 1;
    const sessionUri = `https://fake-drive-upload.example/session/${sessionCounter}`;
    uploadSessions.set(sessionUri, { totalBytes, bytesReceived: 0, name: metadata.name, mimeType });
    return new Response(null, { status: 200, headers: { Location: sessionUri } });
  }

  // ---- Resumable upload: chunk PUT / status check / cancel ----
  if (urlStr.startsWith("https://fake-drive-upload.example/session/")) {
    const session = uploadSessions.get(urlStr);
    if (!session) return new Response("no such session", { status: 404 });

    if (options.method === "DELETE") {
      uploadSessions.delete(urlStr);
      return new Response(null, { status: 204 });
    }

    const contentRange = headerValue(options.headers, "Content-Range") ?? "";
    const statusMatch = contentRange.match(/^bytes \*\/(\d+)$/);
    const chunkMatch = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);

    const respondComplete = () =>
      jsonResponse({ id: `fake-drive-file-${sessionCounter}`, name: session.name, size: String(session.totalBytes), mimeType: session.mimeType });
    const respondIncomplete = () =>
      new Response(null, {
        status: 308,
        headers: session.bytesReceived > 0 ? { Range: `bytes=0-${session.bytesReceived - 1}` } : {},
      });

    if (statusMatch) {
      return session.bytesReceived >= session.totalBytes ? respondComplete() : respondIncomplete();
    }

    if (chunkMatch) {
      const [, , endStr, totalStr] = chunkMatch;
      session.bytesReceived = Math.max(session.bytesReceived, Number(endStr) + 1);
      session.totalBytes = Number(totalStr);
      return session.bytesReceived >= session.totalBytes ? respondComplete() : respondIncomplete();
    }

    return new Response("malformed Content-Range", { status: 400 });
  }

  if (urlStr === "https://www.googleapis.com/drive/v3/files" && options.method === "POST") {
    return jsonResponse({ id: `fake-drive-folder-${callLog.length}` });
  }

  if (urlStr.includes("/drive/v3/files/") && urlStr.includes("alt=media")) {
    return new Response("fake file bytes", {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "15" },
    });
  }

  if (urlStr.includes("/drive/v3/files/") && options.method === "PATCH") {
    return jsonResponse({ id: "ok" });
  }

  throw new Error(`fakeFetch: no canned response for ${options.method || "GET"} ${urlStr}`);
}

export function installFakeFetch() {
  callLog = [];
  uploadSessions = new Map();
  sessionCounter = 0;
  globalThis.fetch = fakeFetch;
}

export function getFakeFetchCalls() {
  return callLog;
}
