import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeD1, fakeContext } from "./helpers/fakeD1.js";
import {
  insertFolder,
  listActiveFolders,
  getPublicFolder,
  getFolderWithSecrets,
  folderNameExists,
  renameFolder,
  updateManagementTokenHash,
  softDeleteFolder,
  insertFileIfWithinQuota,
  listFilesForFolder,
  getFolderUsedBytes,
  softDeleteFile,
  renameFile,
  recordRateLimitAttempt,
  clearRateLimit,
  insertUploadSession,
  getUploadSession,
  updateUploadSessionProgress,
  markUploadSessionDone,
  reclaimStaleUploadSessions,
  listFilesUnderPath,
  countFilesUnderPath,
  softDeleteFilesByIds,
} from "../src/db.js";

function setup() {
  return fakeContext(createFakeD1());
}

describe("db.js folders", () => {
  test("insertFolder + getPublicFolder round-trips and never exposes secrets", async () => {
    const c = setup();
    await insertFolder(c, {
      id: "f1",
      driveFolderId: "drive-1",
      name: "Robotics Club",
      passwordHash: "pbkdf2$30000$salt$hash",
      managementTokenHash: "abc123",
    });

    const folder = await getPublicFolder(c, "f1");
    assert.equal(folder.name, "Robotics Club");
    assert.equal(Boolean(folder.is_protected), true);
    assert.equal(folder.password_hash, undefined, "public query must not select password_hash");
    assert.equal(folder.management_token_hash, undefined, "public query must not select management_token_hash");
  });

  test("getFolderWithSecrets does expose the hashes (internal-only use)", async () => {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "X", passwordHash: null, managementTokenHash: "tok-hash" });
    const folder = await getFolderWithSecrets(c, "f1");
    assert.equal(folder.management_token_hash, "tok-hash");
  });

  test("listActiveFolders excludes soft-deleted folders", async () => {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "Keep", passwordHash: null, managementTokenHash: "h1" });
    await insertFolder(c, { id: "f2", driveFolderId: "d2", name: "Gone", passwordHash: null, managementTokenHash: "h2" });
    await softDeleteFolder(c, "f2");

    const rows = await listActiveFolders(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Keep");
  });

  test("folderNameExists is case-insensitive and ignores deleted folders", async () => {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "Robotics Club", passwordHash: null, managementTokenHash: "h1" });
    assert.equal(await folderNameExists(c, "robotics club"), true);
    assert.equal(await folderNameExists(c, "Chess Club"), false);

    await softDeleteFolder(c, "f1");
    assert.equal(await folderNameExists(c, "robotics club"), false, "a deleted folder's name should be reusable");
  });

  test("renameFolder updates the name", async () => {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "Old Name", passwordHash: null, managementTokenHash: "h1" });
    await renameFolder(c, "f1", "New Name");
    const folder = await getPublicFolder(c, "f1");
    assert.equal(folder.name, "New Name");
  });

  test("updateManagementTokenHash rotates the stored hash", async () => {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "X", passwordHash: null, managementTokenHash: "old-hash" });
    await updateManagementTokenHash(c, "f1", "new-hash");
    const folder = await getFolderWithSecrets(c, "f1");
    assert.equal(folder.management_token_hash, "new-hash");
  });
});

describe("db.js files + quota", () => {
  async function makeFolder(c, id = "f1") {
    await insertFolder(c, { id, driveFolderId: "d1", name: "Folder", passwordHash: null, managementTokenHash: "h1" });
  }

  test("getFolderUsedBytes sums only active files for that folder", async () => {
    const c = setup();
    await makeFolder(c);
    const quota = 10_000_000;
    await insertFileIfWithinQuota(c, { id: "file1", folderId: "f1", driveFileId: "d1", originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 100 }, quota);
    await insertFileIfWithinQuota(c, { id: "file2", folderId: "f1", driveFileId: "d2", originalName: "b.pdf", mimeType: "application/pdf", sizeBytes: 200 }, quota);
    assert.equal(await getFolderUsedBytes(c, "f1"), 300);

    await softDeleteFile(c, "file1");
    assert.equal(await getFolderUsedBytes(c, "f1"), 200, "a deleted file's bytes should stop counting");
  });

  test("insertFileIfWithinQuota rejects an insert that would exceed the quota", async () => {
    const c = setup();
    await makeFolder(c);
    const quota = 500;

    const okResult = await insertFileIfWithinQuota(
      c, { id: "file1", folderId: "f1", driveFileId: "d1", originalName: "a.pdf", mimeType: null, sizeBytes: 400 }, quota
    );
    assert.equal(okResult, true);

    const rejected = await insertFileIfWithinQuota(
      c, { id: "file2", folderId: "f1", driveFileId: "d2", originalName: "b.pdf", mimeType: null, sizeBytes: 200 }, quota
    );
    assert.equal(rejected, false, "400 + 200 > 500 quota, should be rejected");

    // The rejected file must not have been inserted at all.
    const files = await listFilesForFolder(c, "f1");
    assert.equal(files.length, 1);
    assert.equal(await getFolderUsedBytes(c, "f1"), 400);
  });

  test("insertFileIfWithinQuota allows landing exactly on the quota boundary", async () => {
    const c = setup();
    await makeFolder(c);
    const quota = 500;
    const result = await insertFileIfWithinQuota(
      c, { id: "file1", folderId: "f1", driveFileId: "d1", originalName: "a.pdf", mimeType: null, sizeBytes: 500 }, quota
    );
    assert.equal(result, true);
    assert.equal(await getFolderUsedBytes(c, "f1"), 500);
  });

  test("REGRESSION (Phase 6): two uploads racing the same folder can never together exceed quota", async () => {
    // This is the exact bug found and fixed in Phase 6: a naive
    // check-then-insert would let two concurrent uploads both pass a
    // "is there room?" check before either had written. Simulating that
    // race here by firing both inserts concurrently (Promise.all) against
    // the same in-memory DB -- since SQLite serializes writes, only one
    // atomic INSERT...SELECT...WHERE should be able to win.
    const c = setup();
    await makeFolder(c);
    const quota = 1000;

    const [resultA, resultB] = await Promise.all([
      insertFileIfWithinQuota(c, { id: "fileA", folderId: "f1", driveFileId: "dA", originalName: "a.pdf", mimeType: null, sizeBytes: 700 }, quota),
      insertFileIfWithinQuota(c, { id: "fileB", folderId: "f1", driveFileId: "dB", originalName: "b.pdf", mimeType: null, sizeBytes: 700 }, quota),
    ]);

    // 700 + 700 = 1400 > 1000, so exactly one of the two must have won.
    const wins = [resultA, resultB].filter(Boolean).length;
    assert.equal(wins, 1, "exactly one of the two racing uploads should have been accepted");
    assert.ok(await getFolderUsedBytes(c, "f1") <= quota, "final usage must never exceed the quota");
  });

  test("renameFile updates original_name", async () => {
    const c = setup();
    await makeFolder(c);
    await insertFileIfWithinQuota(c, { id: "file1", folderId: "f1", driveFileId: "d1", originalName: "old.pdf", mimeType: null, sizeBytes: 10 }, 10_000);
    await renameFile(c, "file1", "new.pdf");
    const files = await listFilesForFolder(c, "f1");
    assert.equal(files[0].original_name, "new.pdf");
  });
});

describe("db.js rate limiting", () => {
  test("recordRateLimitAttempt increments within the same window", async () => {
    const c = setup();
    const window = "2026-01-01T00:00:00.000Z";
    assert.equal(await recordRateLimitAttempt(c, "k1", "unlock_attempt", window), 1);
    assert.equal(await recordRateLimitAttempt(c, "k1", "unlock_attempt", window), 2);
    assert.equal(await recordRateLimitAttempt(c, "k1", "unlock_attempt", window), 3);
  });

  test("different keys/windows/event types are counted independently", async () => {
    const c = setup();
    const w1 = "2026-01-01T00:00:00.000Z";
    const w2 = "2026-01-01T00:15:00.000Z";
    assert.equal(await recordRateLimitAttempt(c, "k1", "unlock_attempt", w1), 1);
    assert.equal(await recordRateLimitAttempt(c, "k2", "unlock_attempt", w1), 1, "different key, own counter");
    assert.equal(await recordRateLimitAttempt(c, "k1", "unlock_attempt", w2), 1, "different window, own counter");
    assert.equal(await recordRateLimitAttempt(c, "k1", "folder_create", w1), 1, "different event type, own counter");
  });

  test("clearRateLimit resets all windows for a key+eventType", async () => {
    const c = setup();
    const window = "2026-01-01T00:00:00.000Z";
    await recordRateLimitAttempt(c, "k1", "unlock_attempt", window);
    await recordRateLimitAttempt(c, "k1", "unlock_attempt", window);
    await clearRateLimit(c, "k1", "unlock_attempt");
    assert.equal(await recordRateLimitAttempt(c, "k1", "unlock_attempt", window), 1, "counter should restart from 1");
  });
});

describe("db.js upload sessions", () => {
  async function makeFolder(c, id = "f1") {
    await insertFolder(c, { id, driveFolderId: "d1", name: "Folder", passwordHash: null, managementTokenHash: "h1" });
  }

  test("insertUploadSession + getUploadSession round-trips, and only returns active sessions", async () => {
    const c = setup();
    await makeFolder(c);
    await insertUploadSession(c, {
      id: "u1",
      folderId: "f1",
      driveSessionUri: "https://example.com/session/1",
      originalName: "big.zip",
      mimeType: "application/zip",
      totalBytes: 5000,
    });

    const session = await getUploadSession(c, "u1");
    assert.equal(session.original_name, "big.zip");
    assert.equal(session.total_bytes, 5000);
    assert.equal(session.bytes_received, 0);
    assert.equal(session.status, "active");

    await markUploadSessionDone(c, "u1", "completed");
    assert.equal(await getUploadSession(c, "u1"), null, "a completed session should no longer be 'active'");
  });

  test("updateUploadSessionProgress persists the confirmed byte count", async () => {
    const c = setup();
    await makeFolder(c);
    await insertUploadSession(c, { id: "u1", folderId: "f1", driveSessionUri: "https://x/1", originalName: "a", mimeType: null, totalBytes: 1000 });
    await updateUploadSessionProgress(c, "u1", 400);
    const session = await getUploadSession(c, "u1");
    assert.equal(session.bytes_received, 400);
  });

  test("reclaimStaleUploadSessions only reclaims old, active sessions for that folder", async () => {
    const c = setup();
    await makeFolder(c);
    await insertUploadSession(c, { id: "old", folderId: "f1", driveSessionUri: "https://x/1", originalName: "a", mimeType: null, totalBytes: 100 });
    await insertUploadSession(c, { id: "fresh", folderId: "f1", driveSessionUri: "https://x/2", originalName: "b", mimeType: null, totalBytes: 100 });

    // Simulate "old" by reclaiming with a cutoff far in the future --
    // everything inserted so far is "older than" that.
    const futureCutoff = new Date(Date.now() + 60_000).toISOString();
    const reclaimed = await reclaimStaleUploadSessions(c, "f1", futureCutoff);
    assert.equal(reclaimed.length, 2, "both sessions were created before the (future) cutoff");

    assert.equal(await getUploadSession(c, "old"), null);
    assert.equal(await getUploadSession(c, "fresh"), null);

    // Reclaiming again should find nothing left to reclaim.
    const reclaimedAgain = await reclaimStaleUploadSessions(c, "f1", futureCutoff);
    assert.equal(reclaimedAgain.length, 0);
  });
});

describe("db.js sub-folders (virtual paths)", () => {
  async function seed() {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "Folder One", passwordHash: null, managementTokenHash: "h" });
    await insertFolder(c, { id: "f2", driveFolderId: "d2", name: "Folder Two", passwordHash: null, managementTokenHash: "h" });
    let n = 0;
    const add = (folderId, path, name = "x.txt", size = 10) =>
      insertFileIfWithinQuota(
        c,
        { id: `file-${++n}`, folderId, driveFileId: `drive-${n}`, originalName: name, mimeType: null, sizeBytes: size, path },
        1000
      );
    return { c, add };
  }

  test("a file remembers its path, and files default to the top level", async () => {
    const { c, add } = await seed();
    await add("f1", "calendar/css", "style.css");
    await add("f1", "", "readme.txt");
    const files = await listFilesForFolder(c, "f1");
    const byName = Object.fromEntries(files.map((f) => [f.original_name, f.path]));
    assert.equal(byName["style.css"], "calendar/css");
    assert.equal(byName["readme.txt"], "");
  });

  test("listFilesUnderPath finds the sub-folder and everything below it, but not look-alike siblings", async () => {
    const { c, add } = await seed();
    await add("f1", "calendar");
    await add("f1", "calendar/css");
    await add("f1", "calendar/css/deep");
    await add("f1", "calendar2"); // shares a prefix but is a different folder
    await add("f1", "calendar-old");
    await add("f1", "");
    await add("f2", "calendar"); // same path in a DIFFERENT student folder
    const rows = await listFilesUnderPath(c, "f1", "calendar", 100);
    assert.equal(rows.length, 3);
    assert.equal(await countFilesUnderPath(c, "f1", "calendar"), 3);
    assert.equal(await countFilesUnderPath(c, "f1", "calendar/css"), 2);
    assert.equal(await countFilesUnderPath(c, "f2", "calendar"), 1);
  });

  test("% and _ in a folder name are matched literally, never as wildcards", async () => {
    const { c, add } = await seed();
    await add("f1", "100%_done");
    await add("f1", "100abc_done");
    assert.equal(await countFilesUnderPath(c, "f1", "100%_done"), 1);
  });

  test("softDeleteFilesByIds hides files from listings and from the used-bytes total", async () => {
    const { c, add } = await seed();
    await add("f1", "a", "1.txt", 100);
    await add("f1", "a", "2.txt", 200);
    const rows = await listFilesUnderPath(c, "f1", "a", 100);
    await softDeleteFilesByIds(c, [rows[0].id]);
    assert.equal(await countFilesUnderPath(c, "f1", "a"), 1);
    await softDeleteFilesByIds(c, []); // no-op, must not throw
  });

  test("listFilesUnderPath respects its limit", async () => {
    const { c, add } = await seed();
    for (let i = 0; i < 5; i++) await add("f1", "many", `f${i}.txt`, 1);
    assert.equal((await listFilesUnderPath(c, "f1", "many", 3)).length, 3);
  });

  test("an upload session carries its path", async () => {
    const c = setup();
    await insertFolder(c, { id: "f1", driveFolderId: "d1", name: "Folder One", passwordHash: null, managementTokenHash: "h" });
    await insertUploadSession(c, { id: "u1", folderId: "f1", driveSessionUri: "uri", originalName: "a.txt", mimeType: null, totalBytes: 5, path: "x/y" });
    assert.equal((await getUploadSession(c, "u1")).path, "x/y");
  });
});
