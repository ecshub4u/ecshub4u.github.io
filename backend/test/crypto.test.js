import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, timingSafeEqual, generateManagementToken, newId } from "../src/crypto.js";

describe("crypto.js", () => {
  test("sha256Hex is deterministic and produces a 64-char hex string", async () => {
    const a = await sha256Hex("hello");
    const b = await sha256Hex("hello");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("sha256Hex produces different output for different input", async () => {
    const a = await sha256Hex("hello");
    const b = await sha256Hex("hello!");
    assert.notEqual(a, b);
  });

  test("timingSafeEqual returns true only for identical strings", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
    assert.equal(timingSafeEqual("", ""), true);
  });

  test("generateManagementToken produces unique, URL-safe tokens", () => {
    const a = generateManagementToken();
    const b = generateManagementToken();
    assert.notEqual(a, b);
    // URL-safe base64: no +, /, or = padding
    assert.doesNotMatch(a, /[+/=]/);
    assert.ok(a.length > 30, "token should be long enough to be high-entropy");
  });

  test("newId produces distinct UUIDs", () => {
    const a = newId();
    const b = newId();
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);
  });
});
