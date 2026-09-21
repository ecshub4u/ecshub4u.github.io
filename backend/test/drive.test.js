import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeFetch } from "./helpers/fakeDrive.js";
import { initiateResumableUpload, uploadResumableChunk, cancelResumableSession } from "../src/drive.js";

/**
 * Tests src/drive.js's resumable-upload functions directly, with no Hono
 * involved at all -- drive.js doesn't import Hono, so unlike
 * routes.test.js, these can run even in an environment where `hono`
 * isn't installed. This is deliberately the one place the actual chunked-
 * upload *client* logic (not just the DB bookkeeping around it, which
 * db.test.js already covers) gets real, always-runnable coverage.
 */

const env = {
  GOOGLE_CLIENT_ID: "fake-client-id",
  GOOGLE_CLIENT_SECRET: "fake-client-secret",
  GOOGLE_REFRESH_TOKEN: "fake-refresh-token",
};

beforeEach(() => {
  installFakeFetch();
});

describe("drive.js resumable uploads", () => {
  test("initiateResumableUpload returns a session URI", async () => {
    const sessionUri = await initiateResumableUpload(env, {
      name: "notes.pdf",
      parentId: "parent-folder-id",
      mimeType: "application/pdf",
      sizeBytes: 20,
    });
    assert.ok(sessionUri.startsWith("https://"));
  });

  test("a single chunk covering the whole file completes immediately", async () => {
    const sessionUri = await initiateResumableUpload(env, { name: "a.txt", parentId: "p1", mimeType: "text/plain", sizeBytes: 11 });
    const bytes = new TextEncoder().encode("hello world");
    const result = await uploadResumableChunk(env, sessionUri, { chunkBytes: bytes, rangeStart: 0, rangeEnd: 10, totalBytes: 11 });

    assert.equal(result.done, true);
    assert.equal(result.file.name, "a.txt");
    assert.equal(Number(result.file.size), 11);
  });

  test("multiple chunks: intermediate ones report bytesConfirmed, the last completes", async () => {
    const sessionUri = await initiateResumableUpload(env, { name: "split.bin", parentId: "p1", mimeType: null, sizeBytes: 20 });

    const first = await uploadResumableChunk(env, sessionUri, {
      chunkBytes: new Uint8Array(10),
      rangeStart: 0,
      rangeEnd: 9,
      totalBytes: 20,
    });
    assert.equal(first.done, false);
    assert.equal(first.bytesConfirmed, 10);

    const second = await uploadResumableChunk(env, sessionUri, {
      chunkBytes: new Uint8Array(10),
      rangeStart: 10,
      rangeEnd: 19,
      totalBytes: 20,
    });
    assert.equal(second.done, true);
    assert.equal(Number(second.file.size), 20);
  });

  test("a status check (chunkBytes: null) reports the true confirmed offset without sending any bytes", async () => {
    const sessionUri = await initiateResumableUpload(env, { name: "resume.bin", parentId: "p1", mimeType: null, sizeBytes: 20 });
    await uploadResumableChunk(env, sessionUri, { chunkBytes: new Uint8Array(10), rangeStart: 0, rangeEnd: 9, totalBytes: 20 });

    const status = await uploadResumableChunk(env, sessionUri, { chunkBytes: null, totalBytes: 20 });
    assert.equal(status.done, false);
    assert.equal(status.bytesConfirmed, 10);
  });

  test("cancelResumableSession never throws, even for an unknown/already-gone session", async () => {
    await assert.doesNotReject(() => cancelResumableSession(env, "https://fake-drive-upload.example/session/does-not-exist"));
  });
});
