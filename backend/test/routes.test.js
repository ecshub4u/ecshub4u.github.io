import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { createFakeD1 } from "./helpers/fakeD1.js";
import { installFakeFetch } from "./helpers/fakeDrive.js";
import { FOLDER_QUOTA_BYTES } from "../src/constants.js";

/**
 * Integration tests: real Hono `app` (the actual production router,
 * middleware, and handlers from src/index.js), a fresh in-memory D1 per
 * test, and a canned fetch standing in for Google Drive/OAuth -- nothing
 * here is reimplemented logic, it's the real request/response cycle.
 */

let env;

beforeEach(() => {
  installFakeFetch();
  env = {
    DB: createFakeD1(),
    ALLOWED_ORIGINS: "http://localhost:8000",
    GOOGLE_ROOT_FOLDER_ID: "root-folder-id",
    GOOGLE_CLIENT_ID: "fake-client-id",
    GOOGLE_CLIENT_SECRET: "fake-client-secret",
    GOOGLE_REFRESH_TOKEN: "fake-refresh-token",
    UNLOCK_SESSION_SECRET: "test-secret-do-not-use-in-prod",
  };
});

async function createFolder(name, password) {
  const res = await app.request(
    "/api/folders",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, password }) },
    env
  );
  const body = await res.json();
  return { res, body };
}

describe("GET /api/health", () => {
  test("reports ok with a connected DB", async () => {
    const res = await app.request("/api/health", {}, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.db, "connected");
  });
});

describe("Folder lifecycle", () => {
  test("create -> list -> get round-trip", async () => {
    const { res, body } = await createFolder("Robotics Club");
    assert.equal(res.status, 201);
    assert.equal(body.name, "Robotics Club");
    assert.equal(body.protected, false);
    assert.ok(body.managementToken, "should return a management token exactly once");

    const listRes = await app.request("/api/folders", {}, env);
    const listBody = await listRes.json();
    assert.equal(listBody.folders.length, 1);
    assert.equal(listBody.folders[0].managementToken, undefined, "list must never include the management token");

    const getRes = await app.request(`/api/folders/${body.id}`, {}, env);
    assert.equal(getRes.status, 200);
  });

  test("rejects a duplicate folder name", async () => {
    await createFolder("Robotics Club");
    const { res, body } = await createFolder("Robotics Club");
    assert.equal(res.status, 400);
    assert.match(body.error.message, /already exists/i);
  });

  test("rejects an invalid folder name with a clean 400, not a 500", async () => {
    const res = await app.request(
      "/api/folders",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: 12345 }) },
      env
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "bad_request");
  });

  test("404s for a folder that doesn't exist", async () => {
    const res = await app.request("/api/folders/does-not-exist", {}, env);
    assert.equal(res.status, 404);
  });

  test("rename requires the management token", async () => {
    const { body: folder } = await createFolder("Old Name");

    const noAuth = await app.request(
      `/api/folders/${folder.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "New Name" }) },
      env
    );
    assert.equal(noAuth.status, 401);

    const wrongAuth = await app.request(
      `/api/folders/${folder.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify({ name: "New Name" }),
      },
      env
    );
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await app.request(
      `/api/folders/${folder.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${folder.managementToken}` },
        body: JSON.stringify({ name: "New Name" }),
      },
      env
    );
    assert.equal(rightAuth.status, 200);
    const renamed = await rightAuth.json();
    assert.equal(renamed.name, "New Name");
  });

  test("delete requires the management token, and the folder 404s afterward", async () => {
    const { body: folder } = await createFolder("Doomed Folder");

    const wrongAuth = await app.request(`/api/folders/${folder.id}`, { method: "DELETE", headers: { Authorization: "Bearer nope" } }, env);
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await app.request(
      `/api/folders/${folder.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${folder.managementToken}` } },
      env
    );
    assert.equal(rightAuth.status, 200);

    const getRes = await app.request(`/api/folders/${folder.id}`, {}, env);
    assert.equal(getRes.status, 404);
  });

  test("rotate-token invalidates the old token immediately", async () => {
    const { body: folder } = await createFolder("Token Folder");

    const rotateRes = await app.request(
      `/api/folders/${folder.id}/rotate-token`,
      { method: "POST", headers: { Authorization: `Bearer ${folder.managementToken}` } },
      env
    );
    assert.equal(rotateRes.status, 200);
    const { managementToken: newToken } = await rotateRes.json();
    assert.notEqual(newToken, folder.managementToken);

    const oldTokenRes = await app.request(
      `/api/folders/${folder.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${folder.managementToken}` }, body: JSON.stringify({ name: "X" }) },
      env
    );
    assert.equal(oldTokenRes.status, 401, "the rotated-away token must no longer work");

    const newTokenRes = await app.request(
      `/api/folders/${folder.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${newToken}` }, body: JSON.stringify({ name: "X" }) },
      env
    );
    assert.equal(newTokenRes.status, 200);
  });
});

describe("Password protection + unlock", () => {
  test("wrong password is rejected, correct password issues an unlock token", async () => {
    const { body: folder } = await createFolder("Secret Club", "correct-password");
    assert.equal(folder.protected, true);

    const wrong = await app.request(
      `/api/folders/${folder.id}/unlock`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) },
      env
    );
    assert.equal(wrong.status, 401);

    const right = await app.request(
      `/api/folders/${folder.id}/unlock`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) },
      env
    );
    assert.equal(right.status, 200);
    const body = await right.json();
    assert.equal(body.unlocked, true);
    assert.ok(body.unlockToken);
  });

  test("unlock is rate-limited after 5 failed attempts in the window", async () => {
    const { body: folder } = await createFolder("Rate Limited Club", "correct-password");

    let lastStatus;
    for (let i = 0; i < 6; i++) {
      const res = await app.request(
        `/api/folders/${folder.id}/unlock`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) },
        env
      );
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, "the 6th attempt within the window should be rate-limited");
  });

  test("listing files on a protected folder without access is denied", async () => {
    const { body: folder } = await createFolder("Locked Files", "pw-1234");
    const res = await app.request(`/api/folders/${folder.id}/files`, {}, env);
    assert.equal(res.status, 401);
  });
});

describe("Files: chunked upload / list / download / rename / delete", () => {
  async function initiateUpload(folderId, name, sizeBytes, headers = {}) {
    return app.request(
      `/api/folders/${folderId}/uploads`,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ name, sizeBytes, mimeType: "text/plain" }) },
      env
    );
  }

  async function putChunk(folderId, uploadId, { rangeStart, rangeEnd, totalBytes, bodyText, statusCheck = false }) {
    const headers = { "Content-Range": statusCheck ? `bytes */${totalBytes}` : `bytes ${rangeStart}-${rangeEnd}/${totalBytes}` };
    return app.request(`/api/folders/${folderId}/uploads/${uploadId}`, { method: "PUT", headers, body: statusCheck ? undefined : bodyText }, env);
  }

  /** Uploads a whole small file in a single chunk -- what most tests here
   * actually care about is what happens after a successful upload, not
   * the chunking mechanics themselves (those get their own dedicated
   * tests below). Returns the *chunk* response (mirrors the old helper's
   * shape) so existing assertions on `res.status`/`res.json()` keep working. */
  async function uploadWholeFile(folderId, content, filename, headers = {}) {
    const initRes = await initiateUpload(folderId, filename, content.length, headers);
    if (initRes.status !== 201) return initRes;
    const { uploadId } = await initRes.json();
    return putChunk(folderId, uploadId, { rangeStart: 0, rangeEnd: content.length - 1, totalBytes: content.length, bodyText: content });
  }

  test("upload to a public folder needs no auth", async () => {
    const { body: folder } = await createFolder("Public Uploads");
    const res = await uploadWholeFile(folder.id, "hello world", "notes.txt");
    assert.equal(res.status, 201);
    const uploaded = await res.json();
    assert.equal(uploaded.name, "notes.txt");
    assert.equal(uploaded.sizeBytes, 11);
  });

  test("upload to a protected folder requires the management token (checked at initiate, not per chunk)", async () => {
    const { body: folder } = await createFolder("Protected Uploads", "pw-1234");

    const noAuth = await initiateUpload(folder.id, "a.txt", 2);
    assert.equal(noAuth.status, 401);

    const withAuth = await uploadWholeFile(folder.id, "hi", "a.txt", { Authorization: `Bearer ${folder.managementToken}` });
    assert.equal(withAuth.status, 201);
  });

  test("initiating an upload that would exceed the folder's quota is rejected immediately, before any bytes are sent", async () => {
    const { body: folder } = await createFolder("Tiny Quota Folder");
    const initRes = await initiateUpload(folder.id, "huge.bin", FOLDER_QUOTA_BYTES + 1);
    assert.equal(initRes.status, 413);
    const body = await initRes.json();
    assert.equal(body.error.code, "quota_exceeded");
  });

  test("multi-chunk upload: intermediate chunks report progress, the last one completes", async () => {
    const { body: folder } = await createFolder("Multi Chunk Folder");
    const content = "0123456789ABCDEFGHIJ"; // 20 bytes, split into two 10-byte chunks
    const initRes = await initiateUpload(folder.id, "split.txt", content.length);
    const { uploadId } = await initRes.json();

    const first = await putChunk(folder.id, uploadId, { rangeStart: 0, rangeEnd: 9, totalBytes: 20, bodyText: content.slice(0, 10) });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.done, false);
    assert.equal(firstBody.bytesConfirmed, 10);

    const second = await putChunk(folder.id, uploadId, { rangeStart: 10, rangeEnd: 19, totalBytes: 20, bodyText: content.slice(10) });
    assert.equal(second.status, 201);
    const secondBody = await second.json();
    assert.equal(secondBody.done, undefined); // completing response is the file object directly, not a {done} wrapper
    assert.equal(secondBody.sizeBytes, 20);
    assert.equal(secondBody.name, "split.txt");
  });

  test("a status check after a chunk reports the correct resume point (simulates a dropped connection)", async () => {
    const { body: folder } = await createFolder("Resume Test Folder");
    const initRes = await initiateUpload(folder.id, "resume.txt", 20);
    const { uploadId } = await initRes.json();

    await putChunk(folder.id, uploadId, { rangeStart: 0, rangeEnd: 9, totalBytes: 20, bodyText: "0123456789" });

    const statusRes = await putChunk(folder.id, uploadId, { totalBytes: 20, statusCheck: true });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.done, false);
    assert.equal(statusBody.bytesConfirmed, 10, "should resume from where the server actually left off, not assume 0");
  });

  test("DELETE cancels an upload session; further chunks then 404", async () => {
    const { body: folder } = await createFolder("Cancel Test Folder");
    const initRes = await initiateUpload(folder.id, "abandoned.txt", 20);
    const { uploadId } = await initRes.json();

    const cancelRes = await app.request(`/api/folders/${folder.id}/uploads/${uploadId}`, { method: "DELETE" }, env);
    assert.equal(cancelRes.status, 200);

    const chunkAfterCancel = await putChunk(folder.id, uploadId, { rangeStart: 0, rangeEnd: 9, totalBytes: 20, bodyText: "0123456789" });
    assert.equal(chunkAfterCancel.status, 404);
  });

  test("download returns the file's bytes", async () => {
    const { body: folder } = await createFolder("Download Test");
    const uploadRes = await uploadWholeFile(folder.id, "hello world", "notes.txt");
    const uploaded = await uploadRes.json();

    const downloadRes = await app.request(`/api/files/${uploaded.id}`, {}, env);
    assert.equal(downloadRes.status, 200);
    const text = await downloadRes.text();
    assert.equal(text, "fake file bytes", "served from the (mocked) Drive download endpoint");
    assert.match(downloadRes.headers.get("Content-Disposition") || "", /notes\.txt/);
  });

  test("rename and delete require the management token", async () => {
    const { body: folder } = await createFolder("Manage Files");
    const uploadRes = await uploadWholeFile(folder.id, "hi", "a.txt");
    const uploaded = await uploadRes.json();

    const renameNoAuth = await app.request(
      `/api/files/${uploaded.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "b.txt" }) },
      env
    );
    assert.equal(renameNoAuth.status, 401);

    const renameWithAuth = await app.request(
      `/api/files/${uploaded.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${folder.managementToken}` }, body: JSON.stringify({ name: "b.txt" }) },
      env
    );
    assert.equal(renameWithAuth.status, 200);

    const deleteRes = await app.request(`/api/files/${uploaded.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${folder.managementToken}` } }, env);
    assert.equal(deleteRes.status, 200);

    const downloadAfterDelete = await app.request(`/api/files/${uploaded.id}`, {}, env);
    assert.equal(downloadAfterDelete.status, 404);
  });
});

describe("Cross-cutting: headers, CORS, error shape, 404", () => {
  test("security headers are present on every response", async () => {
    const res = await app.request("/api/health", {}, env);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.ok(res.headers.get("Content-Security-Policy"));
  });

  test("CORS allows a configured origin and rejects others", async () => {
    const allowed = await app.request("/api/health", { headers: { Origin: "http://localhost:8000" } }, env);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");

    const disallowed = await app.request("/api/health", { headers: { Origin: "http://evil.example" } }, env);
    assert.notEqual(disallowed.headers.get("Access-Control-Allow-Origin"), "http://evil.example");
  });

  test("CORS preflight allows Content-Range (needed for chunked upload PUTs)", async () => {
    // Regression test for a real bug: chunked uploads (Phase 12) send a
    // Content-Range header, which browsers only permit cross-origin if
    // the server's preflight response explicitly allows it.
    const res = await app.request(
      "/api/folders/some-id/uploads/some-upload-id",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8000",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "Content-Range",
        },
      },
      env
    );
    const allowedHeaders = res.headers.get("Access-Control-Allow-Headers") || "";
    assert.match(allowedHeaders, /Content-Range/i);
  });

  test("unknown routes return a clean 404 JSON body", async () => {
    const res = await app.request("/api/totally-not-a-route", {}, env);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "not_found");
  });

  test("an oversized JSON body is rejected before parsing", async () => {
    const hugeName = "a".repeat(25_000); // over the 20KB cap
    const res = await app.request(
      "/api/folders",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: hugeName }) },
      env
    );
    assert.equal(res.status, 400);
  });
});

describe("Sub-folders: upload a whole folder without zipping it", () => {
  const jsonHeaders = { "Content-Type": "application/json" };

  /** Full upload of one small file into a sub-folder path. */
  async function uploadInto(folderId, path, name, content = "hello", extraHeaders = {}) {
    const initRes = await app.request(
      `/api/folders/${folderId}/uploads`,
      { method: "POST", headers: { ...jsonHeaders, ...extraHeaders }, body: JSON.stringify({ name, path, sizeBytes: content.length, mimeType: "text/plain" }) },
      env
    );
    if (initRes.status !== 201) return initRes;
    const { uploadId } = await initRes.json();
    return app.request(
      `/api/folders/${folderId}/uploads/${uploadId}`,
      { method: "PUT", headers: { "Content-Range": `bytes 0-${content.length - 1}/${content.length}` }, body: content },
      env
    );
  }

  async function listFiles(folderId, headers = {}) {
    const res = await app.request(`/api/folders/${folderId}/files`, { headers }, env);
    return (await res.json()).files;
  }

  async function deletePath(folderId, path, token) {
    return app.request(
      `/api/folders/${folderId}/paths?path=${encodeURIComponent(path)}`,
      { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      env
    );
  }

  test("a file uploaded into a sub-folder comes back with its path, in the reply and in the listing", async () => {
    const { body: folder } = await createFolder("Project Folder");
    const res = await uploadInto(folder.id, "calendar/css", "style.css");
    assert.equal(res.status, 201);
    const uploaded = await res.json();
    assert.equal(uploaded.name, "style.css");
    assert.equal(uploaded.path, "calendar/css");

    await uploadInto(folder.id, "", "readme.txt");
    const files = await listFiles(folder.id);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.path]));
    assert.deepEqual(byName, { "style.css": "calendar/css", "readme.txt": "" });
  });

  test("leaving the path out still works exactly as before (top level)", async () => {
    const { body: folder } = await createFolder("Plain Uploads");
    const initRes = await app.request(
      `/api/folders/${folder.id}/uploads`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "a.txt", sizeBytes: 2 }) },
      env
    );
    assert.equal(initRes.status, 201);
  });

  test("a path that tries to climb out, or is malformed, is rejected before anything reaches Drive", async () => {
    const { body: folder } = await createFolder("Path Safety");
    for (const bad of ["..", "a/../b", "a\\b", "a/b/c/d/e/f/g/h/i/j/k"]) {
      const res = await uploadInto(folder.id, bad, "x.txt");
      assert.equal(res.status, 400, `path ${JSON.stringify(bad)} should be rejected`);
    }
    assert.equal((await listFiles(folder.id)).length, 0);
  });

  test("uploading into a sub-folder of a protected folder still needs the management token", async () => {
    const { body: folder } = await createFolder("Locked Project", "pw-1234");
    const noAuth = await uploadInto(folder.id, "a/b", "x.txt");
    assert.equal(noAuth.status, 401);
    const withAuth = await uploadInto(folder.id, "a/b", "x.txt", "hello", { Authorization: `Bearer ${folder.managementToken}` });
    assert.equal(withAuth.status, 201);
  });

  test("deleting a sub-folder needs the management token", async () => {
    const { body: folder } = await createFolder("Delete Needs Token");
    await uploadInto(folder.id, "docs", "a.txt");
    assert.equal((await deletePath(folder.id, "docs")).status, 401);
    assert.equal((await deletePath(folder.id, "docs", "not-the-token")).status, 401);
    assert.equal((await listFiles(folder.id)).length, 1, "nothing should have been deleted");
  });

  test("deleting a sub-folder removes it and everything below it, and nothing else", async () => {
    const { body: folder } = await createFolder("Delete Subfolder");
    await uploadInto(folder.id, "calendar", "a.txt");
    await uploadInto(folder.id, "calendar/css", "b.css");
    await uploadInto(folder.id, "calendar/css/deep", "c.css");
    await uploadInto(folder.id, "calendar2", "keep-sibling.txt");
    await uploadInto(folder.id, "", "keep-root.txt");

    const res = await deletePath(folder.id, "calendar", folder.managementToken);
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.deleted, 3);
    assert.equal(result.remaining, 0);
    assert.equal(result.freedBytes, 15);

    const left = (await listFiles(folder.id)).map((f) => f.name).sort();
    assert.deepEqual(left, ["keep-root.txt", "keep-sibling.txt"]);
  });

  test("a big sub-folder is deleted in batches: each call reports how many are still left", async () => {
    const { body: folder } = await createFolder("Big Delete");
    for (let i = 0; i < 25; i++) await uploadInto(folder.id, "big", `f${i}.txt`);

    let calls = 0;
    let remaining = Infinity;
    while (remaining > 0) {
      const res = await deletePath(folder.id, "big", folder.managementToken);
      assert.equal(res.status, 200);
      const result = await res.json();
      assert.ok(result.deleted > 0 && result.deleted <= 10, "each call deletes at most one batch of 10");
      remaining = result.remaining;
      assert.ok(++calls <= 5, "should finish in 3 calls, not loop forever");
    }
    assert.equal(calls, 3);
    assert.equal((await listFiles(folder.id)).length, 0);
  });

  test("deleting a path with no files is a harmless no-op; deleting with no path at all is rejected", async () => {
    const { body: folder } = await createFolder("Empty Delete");
    const res = await deletePath(folder.id, "nothing/here", folder.managementToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 0, failed: 0, remaining: 0, freedBytes: 0 });

    const noPath = await app.request(`/api/folders/${folder.id}/paths`, { method: "DELETE", headers: { Authorization: `Bearer ${folder.managementToken}` } }, env);
    assert.equal(noPath.status, 400);
  });

  test("the same sub-folder name in two different student folders never mixes them up", async () => {
    const { body: one } = await createFolder("Student One");
    const { body: two } = await createFolder("Student Two");
    await uploadInto(one.id, "notes", "1.txt");
    await uploadInto(two.id, "notes", "2.txt");
    await deletePath(one.id, "notes", one.managementToken);
    assert.equal((await listFiles(one.id)).length, 0);
    assert.equal((await listFiles(two.id)).length, 1);
  });

  test("CORS preflight allows the DELETE used for sub-folders and the PUT used for chunks", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const res = await app.request(
        "/api/folders/x/paths",
        { method: "OPTIONS", headers: { Origin: "http://localhost:8000", "Access-Control-Request-Method": method } },
        env
      );
      const allowed = res.headers.get("Access-Control-Allow-Methods") || "";
      assert.ok(allowed.includes(method), `${method} must be allowed cross-origin, got: ${allowed}`);
    }
  });
});

describe("Manager password + recovery questions (no management token to save)", () => {
  const json = { "Content-Type": "application/json" };
  const RECOVERY = [
    { question: "What was the name of your first school?", answer: "Sangola Vidyalaya" },
    { question: "What was your childhood nickname?", answer: "Bunty" },
  ];
  const ANSWERS = ["sangola vidyalaya", "BUNTY!"]; // typed differently on purpose -- still right

  const post = (path, body, headers = {}) =>
    app.request(path, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) }, env);

  async function createManaged(name, extra = {}) {
    const res = await post("/api/folders", { name, managerPassword: "manager-1", recovery: RECOVERY, ...extra });
    return { res, folder: await res.json() };
  }
  const asManager = (token) => ({ Authorization: `Manage ${token}` });
  const rename = (id, name, headers) =>
    app.request(`/api/folders/${id}`, { method: "PATCH", headers: { ...json, ...headers }, body: JSON.stringify({ name }) }, env);

  test("creating a folder with a manager password returns a signed-in session, never a token to save", async () => {
    const { res, folder } = await createManaged("Managed One");
    assert.equal(res.status, 201);
    assert.ok(folder.managementToken.startsWith("mgr."), "a manager session");
    assert.equal(folder.managerMode, "password");
    assert.equal((await rename(folder.id, "Managed One Renamed", asManager(folder.managementToken))).status, 200);
  });

  test("the session is not a Bearer token, and the stored secrets never appear in any response", async () => {
    const { folder } = await createManaged("Managed Two");
    assert.equal((await rename(folder.id, "Nope", { Authorization: `Bearer ${folder.managementToken}` })).status, 401);
    const everything = JSON.stringify([
      await (await app.request("/api/folders", {}, env)).json(),
      await (await app.request(`/api/folders/${folder.id}`, {}, env)).json(),
      await (await app.request(`/api/folders/${folder.id}/manage/recovery-questions`, {}, env)).json(),
    ]).toLowerCase();
    for (const secret of ["manager-1", "bunty", "sangola vidyalaya", "hash"]) {
      assert.ok(!everything.includes(secret), `"${secret}" must not be exposed`);
    }
  });

  test("bad setups are rejected before anything is created on Drive", async () => {
    const bad = [
      { managerPassword: "short", recovery: RECOVERY },
      { managerPassword: "manager-1" }, // no recovery questions
      { managerPassword: "manager-1", recovery: [RECOVERY[0]] },
      { managerPassword: "manager-1", recovery: [RECOVERY[0], { ...RECOVERY[1], answer: "!" }] },
      { managerPassword: "manager-1", recovery: [RECOVERY[0], RECOVERY[0]] },
    ];
    for (const [i, extra] of bad.entries()) {
      const res = await post("/api/folders", { name: `Bad ${i}`, ...extra });
      assert.equal(res.status, 400, `case ${i}`);
    }
    assert.equal((await (await app.request("/api/folders", {}, env)).json()).folders.length, 0);
  });

  test("the manager password must differ from the viewing password", async () => {
    const res = await post("/api/folders", { name: "Same Pw", password: "samepass1", managerPassword: "samepass1", recovery: RECOVERY });
    assert.equal(res.status, 400);
  });

  test("signing in: wrong password is refused, the right one gives a working session", async () => {
    const { folder } = await createManaged("Login Test");
    assert.equal((await post(`/api/folders/${folder.id}/manage/login`, { password: "wrong-pass" })).status, 401);
    const ok = await post(`/api/folders/${folder.id}/manage/login`, { password: "manager-1" });
    assert.equal(ok.status, 200);
    const { managementToken } = await ok.json();
    assert.equal((await rename(folder.id, "Login Renamed", asManager(managementToken))).status, 200);
  });

  test("a session from one folder does nothing on another folder", async () => {
    const { folder: a } = await createManaged("Folder A");
    const { folder: b } = await createManaged("Folder B");
    assert.equal((await rename(b.id, "Hijack", asManager(a.managementToken))).status, 401);
  });

  test("5 wrong passwords in a row lock sign-in for a while (even the right password)", async () => {
    const { folder } = await createManaged("Lockout");
    for (let i = 0; i < 5; i++) {
      assert.equal((await post(`/api/folders/${folder.id}/manage/login`, { password: `wrong-${i}-x` })).status, 401);
    }
    assert.equal((await post(`/api/folders/${folder.id}/manage/login`, { password: "manager-1" })).status, 429);
  });

  test("older folders that use a token are untouched: token still works, password sign-in says no", async () => {
    const res = await post("/api/folders", { name: "Old Style" });
    const legacy = await res.json();
    assert.equal(legacy.managerMode, "token");
    assert.ok(!legacy.managementToken.startsWith("mgr."));
    assert.equal((await rename(legacy.id, "Old Style 2", { Authorization: `Bearer ${legacy.managementToken}` })).status, 200);
    assert.equal((await post(`/api/folders/${legacy.id}/manage/login`, { password: "anything1" })).status, 400);
    assert.equal((await app.request(`/api/folders/${legacy.id}/manage/recovery-questions`, {}, env)).status, 400);
  });

  test("recovery questions are shown (never the answers)", async () => {
    const { folder } = await createManaged("Questions");
    const res = await app.request(`/api/folders/${folder.id}/manage/recovery-questions`, {}, env);
    assert.deepEqual((await res.json()).questions, RECOVERY.map((r) => r.question));
  });

  test("forgot password: wrong answers are refused; right answers (typed loosely) set a new password", async () => {
    const { folder } = await createManaged("Forgot It");
    const reset = (answers, newPassword = "brand-new-1") => post(`/api/folders/${folder.id}/manage/reset`, { answers, newPassword });

    assert.equal((await reset(["sangola vidyalaya", "wrong"])).status, 401);
    assert.equal((await reset(["wrong", "bunty"])).status, 401);
    assert.equal((await reset(ANSWERS, "short")).status, 400, "a too-short new password is refused");

    const ok = await reset(ANSWERS);
    assert.equal(ok.status, 200);
    const { managementToken } = await ok.json();
    assert.equal((await rename(folder.id, "After Reset", asManager(managementToken))).status, 200);

    assert.equal((await post(`/api/folders/${folder.id}/manage/login`, { password: "manager-1" })).status, 401, "old password is dead");
    assert.equal((await post(`/api/folders/${folder.id}/manage/login`, { password: "brand-new-1" })).status, 200, "new password works");
  });

  test("a reset signs out every older session, on every device", async () => {
    const { folder } = await createManaged("Signed Out");
    const oldSession = folder.managementToken;
    assert.equal((await rename(folder.id, "Before", asManager(oldSession))).status, 200);
    await post(`/api/folders/${folder.id}/manage/reset`, { answers: ANSWERS, newPassword: "brand-new-1" });
    const res = await rename(folder.id, "After", asManager(oldSession));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "session_expired");
  });

  test("guessing recovery answers is limited: 5 tries an hour, then even the right answers wait", async () => {
    const { folder } = await createManaged("Guess Limit");
    for (let i = 0; i < 5; i++) {
      const res = await post(`/api/folders/${folder.id}/manage/reset`, { answers: [`guess ${i}`, "nope nope"], newPassword: "brand-new-1" });
      assert.equal(res.status, 401);
    }
    const res = await post(`/api/folders/${folder.id}/manage/reset`, { answers: ANSWERS, newPassword: "brand-new-1" });
    assert.equal(res.status, 429);
  });

  test("changing the password needs the session AND the current password, and signs out other sessions", async () => {
    const { folder } = await createManaged("Change Pw");
    const change = (body, headers) => post(`/api/folders/${folder.id}/manage/password`, body, headers);

    assert.equal((await change({ currentPassword: "manager-1", newPassword: "changed-pw-1" })).status, 401, "no session");
    assert.equal((await change({ currentPassword: "wrong-pass", newPassword: "changed-pw-1" }, asManager(folder.managementToken))).status, 401, "wrong current password");
    assert.equal((await change({ currentPassword: "manager-1", newPassword: "abc" }, asManager(folder.managementToken))).status, 400, "new password too short");

    const ok = await change({ currentPassword: "manager-1", newPassword: "changed-pw-1" }, asManager(folder.managementToken));
    assert.equal(ok.status, 200);
    const { managementToken } = await ok.json();
    assert.equal((await rename(folder.id, "Changed", asManager(managementToken))).status, 200);
    assert.equal((await rename(folder.id, "Old Session", asManager(folder.managementToken))).status, 401, "old session ended");
    assert.equal((await post(`/api/folders/${folder.id}/manage/login`, { password: "changed-pw-1" })).status, 200);
  });

  test("a new manager password can't be the folder's viewing password", async () => {
    const { folder } = await createManaged("View Vs Manage", { password: "view-pass-1" });
    const res = await post(`/api/folders/${folder.id}/manage/password`, { currentPassword: "manager-1", newPassword: "view-pass-1" }, asManager(folder.managementToken));
    assert.equal(res.status, 400);
    const reset = await post(`/api/folders/${folder.id}/manage/reset`, { answers: ANSWERS, newPassword: "view-pass-1" });
    assert.equal(reset.status, 400);
  });

  test("a manager sees a protected folder without unlocking; a visitor doesn't", async () => {
    const { folder } = await createManaged("Protected Managed", { password: "view-pass-1" });
    const list = (headers = {}) => app.request(`/api/folders/${folder.id}/files`, { headers }, env);
    assert.equal((await list()).status, 401);
    assert.equal((await list(asManager(folder.managementToken))).status, 200);
  });

  test("uploads into a protected folder need the manager session", async () => {
    const { folder } = await createManaged("Protected Uploads Managed", { password: "view-pass-1" });
    const start = (headers = {}) =>
      post(`/api/folders/${folder.id}/uploads`, { name: "a.txt", sizeBytes: 3 }, headers);
    assert.equal((await start()).status, 401);
    assert.equal((await start(asManager(folder.managementToken))).status, 201);
  });

  test("deleting a file needs the manager session", async () => {
    const { folder } = await createManaged("File Delete");
    const init = await post(`/api/folders/${folder.id}/uploads`, { name: "a.txt", sizeBytes: 3 }, asManager(folder.managementToken));
    const { uploadId } = await init.json();
    const done = await app.request(`/api/folders/${folder.id}/uploads/${uploadId}`, { method: "PUT", headers: { "Content-Range": "bytes 0-2/3" }, body: "abc" }, env);
    const file = await done.json();
    const del = (headers) => app.request(`/api/files/${file.id}`, { method: "DELETE", headers }, env);
    assert.equal((await del({})).status, 401);
    assert.equal((await del(asManager(folder.managementToken))).status, 200);
  });

  test("rotate-token is for older folders only", async () => {
    const { folder } = await createManaged("No Rotate");
    const res = await post(`/api/folders/${folder.id}/rotate-token`, {}, asManager(folder.managementToken));
    assert.equal(res.status, 400);
  });
});
