import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/password.js";

describe("password.js", () => {
  test("verifyPassword accepts the correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
  });

  test("verifyPassword rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    assert.equal(await verifyPassword("wrong-password", hash), false);
  });

  test("verifyPassword rejects malformed/foreign hash strings instead of throwing", async () => {
    assert.equal(await verifyPassword("anything", "not-a-real-hash"), false);
    assert.equal(await verifyPassword("anything", ""), false);
    assert.equal(await verifyPassword("anything", "$argon2id$v=19$m=1$notpbkdf2"), false);
  });

  test("two hashes of the same password are different (random salt) but both verify", async () => {
    const hashA = await hashPassword("same-password");
    const hashB = await hashPassword("same-password");
    assert.notEqual(hashA, hashB);
    assert.equal(await verifyPassword("same-password", hashA), true);
    assert.equal(await verifyPassword("same-password", hashB), true);
  });

  test("hash format is pbkdf2$<iterations>$<salt>$<hash>", async () => {
    const hash = await hashPassword("test");
    const parts = hash.split("$");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "pbkdf2");
    assert.ok(Number(parts[1]) > 0);
  });
});
