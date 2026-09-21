import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { issueUnlockToken, verifyUnlockToken, issueManageToken, verifyManageToken, keyedHash } from "../src/session.js";

const env = { UNLOCK_SESSION_SECRET: "test-secret-do-not-use-in-prod" };

describe("session.js unlock tokens", () => {
  test("a freshly issued token verifies for its own folder", async () => {
    const token = await issueUnlockToken(env, "folder-1");
    const result = await verifyUnlockToken(env, token, "folder-1");
    assert.equal(result, "folder-1");
  });

  test("a token for one folder does not verify for another", async () => {
    const token = await issueUnlockToken(env, "folder-1");
    const result = await verifyUnlockToken(env, token, "folder-2");
    assert.equal(result, null);
  });

  test("a tampered token fails verification", async () => {
    const token = await issueUnlockToken(env, "folder-1");
    const tampered = token.slice(0, -1) + (token.at(-1) === "a" ? "b" : "a");
    const result = await verifyUnlockToken(env, tampered, "folder-1");
    assert.equal(result, null);
  });

  test("garbage input never throws, just fails closed", async () => {
    assert.equal(await verifyUnlockToken(env, "", "folder-1"), null);
    assert.equal(await verifyUnlockToken(env, "not-a-token", "folder-1"), null);
    assert.equal(await verifyUnlockToken(env, null, "folder-1"), null);
  });

  test("a token signed with a different secret does not verify", async () => {
    const token = await issueUnlockToken(env, "folder-1");
    const otherEnv = { UNLOCK_SESSION_SECRET: "a-completely-different-secret" };
    const result = await verifyUnlockToken(otherEnv, token, "folder-1");
    assert.equal(result, null);
  });
});

describe("session.js manager sessions", () => {
  test("a fresh manager session verifies for its own folder and returns its version", async () => {
    const token = await issueManageToken(env, "folder-1", 3);
    assert.ok(token.startsWith("mgr."));
    assert.equal(await verifyManageToken(env, token, "folder-1"), 3);
  });
  test("it does not verify for another folder", async () => {
    const token = await issueManageToken(env, "folder-1", 1);
    assert.equal(await verifyManageToken(env, token, "folder-2"), null);
  });
  test("a tampered token (edited version or signature) is rejected", async () => {
    const token = await issueManageToken(env, "folder-1", 1);
    assert.equal(await verifyManageToken(env, token.slice(0, -2) + "xx", "folder-1"), null);
    const forged = "mgr." + btoa("folder-1.9999999999.99").replace(/=+$/, "") + "." + token.split(".").pop();
    assert.equal(await verifyManageToken(env, forged, "folder-1"), null);
  });
  test("an expired session is rejected", async () => {
    const realNow = Date.now;
    try {
      const token = await issueManageToken(env, "folder-1", 1);
      Date.now = () => realNow() + 31 * 24 * 3600 * 1000;
      assert.equal(await verifyManageToken(env, token, "folder-1"), null);
    } finally {
      Date.now = realNow;
    }
  });
  test("unlock tokens and manager sessions can never stand in for each other", async () => {
    const unlock = await issueUnlockToken(env, "folder-1");
    const manage = await issueManageToken(env, "folder-1", 1);
    assert.equal(await verifyManageToken(env, unlock, "folder-1"), null);
    assert.equal(await verifyUnlockToken(env, manage, "folder-1"), null);
  });
  test("a different secret can't verify it", async () => {
    const token = await issueManageToken(env, "folder-1", 1);
    assert.equal(await verifyManageToken({ UNLOCK_SESSION_SECRET: "another-secret" }, token, "folder-1"), null);
  });
  test("garbage input is rejected without throwing", async () => {
    for (const bad of ["", "mgr.", "mgr.abc", "mgr...", null, undefined, 42]) {
      assert.equal(await verifyManageToken(env, bad, "folder-1"), null);
    }
  });
});

describe("session.js keyedHash", () => {
  test("same input gives the same value; a different context, value or secret changes it", async () => {
    const a = await keyedHash(env, "manager-password:f1", "hunter22");
    assert.equal(a, await keyedHash(env, "manager-password:f1", "hunter22"));
    assert.notEqual(a, await keyedHash(env, "manager-password:f2", "hunter22"));
    assert.notEqual(a, await keyedHash(env, "manager-password:f1", "hunter23"));
    assert.notEqual(a, await keyedHash({ UNLOCK_SESSION_SECRET: "other" }, "manager-password:f1", "hunter22"));
  });
});
