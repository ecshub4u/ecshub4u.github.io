import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateFolderName,
  validatePassword,
  validateFileName,
  validateDirPath,
  validateManagerPassword,
  validateRecovery,
  validateAnswerList,
  normalizeAnswer,
} from "../src/validate.js";
import { AppError } from "../src/errors.js";

describe("validateFolderName", () => {
  test("accepts a normal name", () => {
    assert.equal(validateFolderName("Robotics Club"), "Robotics Club");
  });
  test("accepts em/en dashes -- e.g. the exact example shown in the create-folder form's placeholder", () => {
    assert.equal(validateFolderName("Priya — Semester 4 Notes"), "Priya — Semester 4 Notes");
    assert.equal(validateFolderName("Priya – Semester 4 Notes"), "Priya – Semester 4 Notes");
  });
  test("trims whitespace", () => {
    assert.equal(validateFolderName("  Robotics Club  "), "Robotics Club");
  });
  test("rejects empty/whitespace-only names", () => {
    assert.throws(() => validateFolderName(""), AppError);
    assert.throws(() => validateFolderName("   "), AppError);
  });
  test("rejects slashes (path-like names)", () => {
    assert.throws(() => validateFolderName("notes/2024"), AppError);
  });
  test("rejects names over 80 characters", () => {
    assert.throws(() => validateFolderName("a".repeat(81)), AppError);
  });
  test("rejects non-string input cleanly instead of throwing a raw TypeError", () => {
    assert.throws(() => validateFolderName(12345), AppError);
    assert.throws(() => validateFolderName(["a"]), AppError);
    assert.throws(() => validateFolderName({ name: "x" }), AppError);
  });
});

describe("validatePassword", () => {
  test("accepts a password in range", () => {
    assert.equal(validatePassword("gearup"), "gearup");
  });
  test("rejects too short", () => {
    assert.throws(() => validatePassword("abc"), AppError);
  });
  test("rejects too long", () => {
    assert.throws(() => validatePassword("a".repeat(101)), AppError);
  });
  test("rejects non-string input", () => {
    assert.throws(() => validatePassword(123456), AppError);
  });
});

describe("validateFileName", () => {
  test("accepts a normal file name", () => {
    assert.equal(validateFileName("notes.pdf"), "notes.pdf");
  });
  test("rejects slashes/backslashes", () => {
    assert.throws(() => validateFileName("a/b.pdf"), AppError);
    assert.throws(() => validateFileName("a\\b.pdf"), AppError);
  });
  test('rejects "." and ".."', () => {
    assert.throws(() => validateFileName("."), AppError);
    assert.throws(() => validateFileName(".."), AppError);
  });
  test("rejects control characters", () => {
    assert.throws(() => validateFileName("notes\x00.pdf"), AppError);
  });
  test("rejects names over 150 characters", () => {
    assert.throws(() => validateFileName("a".repeat(151)), AppError);
  });
});

describe("validateDirPath (sub-folder paths)", () => {
  test('no path means the top level of the folder ("")', () => {
    assert.equal(validateDirPath(undefined), "");
    assert.equal(validateDirPath(null), "");
    assert.equal(validateDirPath(""), "");
    assert.equal(validateDirPath("/"), "");
  });
  test("accepts nested paths and keeps spaces/unicode inside names", () => {
    assert.equal(validateDirPath("calendar"), "calendar");
    assert.equal(validateDirPath("calendar/css"), "calendar/css");
    assert.equal(validateDirPath("Sem 4 (notes)/लैब"), "Sem 4 (notes)/लैब");
  });
  test("tidies stray slashes and spaces around names", () => {
    assert.equal(validateDirPath("/calendar//css/"), "calendar/css");
    assert.equal(validateDirPath(" calendar / css "), "calendar/css");
  });
  test('rejects "." and ".." segments so a path can never climb out of its folder', () => {
    assert.throws(() => validateDirPath(".."), AppError);
    assert.throws(() => validateDirPath("a/../b"), AppError);
    assert.throws(() => validateDirPath("./a"), AppError);
  });
  test("rejects backslashes and control characters", () => {
    assert.throws(() => validateDirPath("a\\b"), AppError);
    assert.throws(() => validateDirPath("a/b\x00c"), AppError);
  });
  test("rejects non-string input", () => {
    assert.throws(() => validateDirPath(123), AppError);
    assert.throws(() => validateDirPath(["a"]), AppError);
  });
  test("rejects paths nested more than 10 levels deep", () => {
    assert.equal(validateDirPath("a/b/c/d/e/f/g/h/i/j"), "a/b/c/d/e/f/g/h/i/j");
    assert.throws(() => validateDirPath("a/b/c/d/e/f/g/h/i/j/k"), AppError);
  });
  test("rejects a single name over 150 characters and a whole path over 600", () => {
    assert.throws(() => validateDirPath("a".repeat(151)), AppError);
    const long = Array.from({ length: 5 }, () => "b".repeat(140)).join("/"); // 5*140 + 4 = 704 chars
    assert.throws(() => validateDirPath(long), AppError);
  });
});

describe("manager password and recovery validation", () => {
  test("manager password must be 6-100 characters", () => {
    assert.equal(validateManagerPassword("abc123"), "abc123");
    assert.throws(() => validateManagerPassword("abc12"), AppError);
    assert.throws(() => validateManagerPassword("x".repeat(101)), AppError);
    assert.throws(() => validateManagerPassword(123456), AppError);
    assert.throws(() => validateManagerPassword(undefined), AppError);
  });
  test("normalizeAnswer ignores case, punctuation and extra spaces, and keeps Devanagari intact", () => {
    assert.equal(normalizeAnswer("  Sangola  High-School! "), "sangola high school");
    assert.equal(normalizeAnswer("SANGOLA high school"), normalizeAnswer("sangola  high  school."));
    assert.equal(normalizeAnswer("सांगोला हायस्कूल"), "सांगोला हायस्कूल");
  });
  test("recovery needs exactly two different questions with real answers", () => {
    const ok = validateRecovery([
      { question: "What was your first school?", answer: " Sangola Vidyalaya! " },
      { question: "What is your nickname?", answer: "Bunty" },
    ]);
    assert.deepEqual(ok, [
      { question: "What was your first school?", answer: "sangola vidyalaya" },
      { question: "What is your nickname?", answer: "bunty" },
    ]);
    const q = (question, answer) => ({ question, answer });
    assert.throws(() => validateRecovery(undefined), AppError);
    assert.throws(() => validateRecovery([q("What is your nickname?", "Bunty")]), AppError);
    assert.throws(() => validateRecovery([q("What is your nickname?", "Bunty"), q("Another question?", "Pune"), q("Third one?", "abc")]), AppError);
    assert.throws(() => validateRecovery([q("What is your nickname?", "Bunty"), q("WHAT IS YOUR NICKNAME?", "Rohan")]), AppError, "same question twice");
    assert.throws(() => validateRecovery([q("What is your nickname?", "!!"), q("Another question?", "Pune")]), AppError, "answer with no letters");
    assert.throws(() => validateRecovery([q("What is your nickname?", "ab"), q("Another question?", "Pune")]), AppError, "too-short answer");
    assert.throws(() => validateRecovery([q("Hi?", "Bunty"), q("Another question?", "Pune")]), AppError, "too-short question");
  });
  test("validateAnswerList wants one string per question", () => {
    assert.deepEqual(validateAnswerList(["a", "b"], 2), ["a", "b"]);
    assert.throws(() => validateAnswerList(["a"], 2), AppError);
    assert.throws(() => validateAnswerList(["a", 5], 2), AppError);
    assert.throws(() => validateAnswerList("ab", 2), AppError);
  });
});
