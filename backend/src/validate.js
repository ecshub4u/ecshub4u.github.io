import { Errors } from "./errors.js";

/** Every validator starts here so a wrong JSON type (a number, an array,
 * an object) fails cleanly as a 400 instead of throwing a raw TypeError
 * out of .trim()/.length that the global handler would have to catch and
 * sanitize as a generic 500. */
function expectString(value, fieldName) {
  if (typeof value !== "string") {
    throw Errors.badRequest(`${fieldName} must be text.`);
  }
  return value;
}

// Letters (any language), digits, spaces, and a small safe set of
// punctuation -- including en/em dashes (\u2013/\u2014), since those are
// exactly what a name like "Priya — Semester 4 Notes" needs and are easy
// to type accidentally via autocorrect or copy-paste. Deliberately
// excludes slashes/backslashes/control characters so a folder name can
// never be mistaken for a path.
const FOLDER_NAME_PATTERN = /^[\p{L}\p{N} _\-.,()&'\u2013\u2014]{1,80}$/u;

export function validateFolderName(rawName) {
  const name = expectString(rawName ?? "", "Folder name").trim();

  if (!name) {
    throw Errors.badRequest("Folder name is required.");
  }
  if (!FOLDER_NAME_PATTERN.test(name)) {
    throw Errors.badRequest(
      "Folder name can only contain letters, numbers, spaces, and basic punctuation ( - _ . , ( ) & ' ), up to 80 characters."
    );
  }
  return name;
}

/** Returns the password unchanged (not trimmed -- leading/trailing spaces
 * may be intentional) or throws if it's missing/out of range. This gates
 * a shared student folder, not a bank account, so the bar is "long enough
 * to not be trivially guessable," not full password-complexity rules. */
export function validatePassword(rawPassword) {
  const password = expectString(rawPassword ?? "", "Password");
  if (password.length < 4 || password.length > 100) {
    throw Errors.badRequest("Password must be between 4 and 100 characters.");
  }
  return password;
}

// No slashes/backslashes (so a name can never be mistaken for a path) and
// no control characters. Otherwise permissive -- real uploaded files have
// all kinds of punctuation and extensions in their names.
const FILE_NAME_PATTERN = /^[^/\\\x00-\x1F]{1,150}$/;

export function validateFileName(rawName) {
  const name = expectString(rawName ?? "", "File name").trim();
  if (!name) {
    throw Errors.badRequest("The uploaded file needs a name.");
  }
  if (name === "." || name === "..") {
    throw Errors.badRequest("Invalid file name.");
  }
  if (!FILE_NAME_PATTERN.test(name)) {
    throw Errors.badRequest("File name can't contain slashes or control characters, and must be 1-150 characters.");
  }
  return name;
}

// ---------- Sub-folder paths (Phase 13) ----------
// Sub-folders inside a student folder are "virtual": a file just records
// which sub-folder path it sits in (e.g. "calendar/css"), and the website
// shows those paths as folders. Nothing is created on Drive per sub-folder.
// A path is a list of names joined with "/", where every name follows the
// same rules as a file name (no slashes, backslashes or control characters),
// and "." / ".." are refused so a path can never climb out of its folder.
const MAX_PATH_DEPTH = 10;
const MAX_PATH_LENGTH = 600;

/** Returns the cleaned-up path ("a/b/c"), or "" for "no sub-folder" (the
 * top level of the folder). Throws a 400 for anything malformed. */
export function validateDirPath(rawPath) {
  if (rawPath === undefined || rawPath === null || rawPath === "") return "";
  const raw = expectString(rawPath, "Path");

  const segments = raw
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean); // tolerate leading/trailing/double slashes
  if (segments.length === 0) return "";

  if (segments.length > MAX_PATH_DEPTH) {
    throw Errors.badRequest(`Folders can be nested at most ${MAX_PATH_DEPTH} levels deep.`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw Errors.badRequest("Invalid folder path.");
    }
    if (!FILE_NAME_PATTERN.test(segment)) {
      throw Errors.badRequest(
        "Folder names can't contain backslashes or control characters, and must be 1-150 characters."
      );
    }
  }

  const joined = segments.join("/");
  if (joined.length > MAX_PATH_LENGTH) {
    throw Errors.badRequest("That folder path is too long.");
  }
  return joined;
}

// ---------- Manager password + recovery questions ----------
const MANAGER_PASSWORD_MIN = 6;
const PASSWORD_MAX = 100;
const QUESTION_MIN = 5;
const QUESTION_MAX = 120;
const ANSWER_MIN = 3; // counted after normalizing, so "a!" or "  x " don't pass
const RECOVERY_QUESTION_COUNT = 2;

export function validateManagerPassword(raw) {
  const password = expectString(raw, "Manager password");
  if (password.length < MANAGER_PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw Errors.badRequest(`The manager password must be ${MANAGER_PASSWORD_MIN}-${PASSWORD_MAX} characters.`);
  }
  return password;
}

/** Makes "  Sangola  High-School!" and "sangola high school" the same answer:
 * lower-case, punctuation removed, spaces collapsed. Letters, digits and
 * combining marks are kept, so Hindi/Marathi (Devanagari) answers survive. */
export function normalizeAnswer(raw) {
  return String(raw)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** Expects exactly 2 { question, answer } pairs; returns them cleaned up
 * (question trimmed, answer normalized). */
export function validateRecovery(raw) {
  if (!Array.isArray(raw) || raw.length !== RECOVERY_QUESTION_COUNT) {
    throw Errors.badRequest(`Choose ${RECOVERY_QUESTION_COUNT} recovery questions and answer both.`);
  }
  const cleaned = raw.map((item) => {
    const question = expectString(item?.question, "Recovery question").trim();
    if (question.length < QUESTION_MIN || question.length > QUESTION_MAX) {
      throw Errors.badRequest(`A recovery question must be ${QUESTION_MIN}-${QUESTION_MAX} characters.`);
    }
    const answer = normalizeAnswer(expectString(item?.answer, "Recovery answer"));
    if (answer.length < ANSWER_MIN) {
      throw Errors.badRequest(`Each recovery answer needs at least ${ANSWER_MIN} letters or digits.`);
    }
    return { question, answer };
  });
  if (cleaned[0].question.toLowerCase() === cleaned[1].question.toLowerCase()) {
    throw Errors.badRequest("Pick two different recovery questions.");
  }
  return cleaned;
}

/** The answers a person typed while resetting: same shape check as above. */
export function validateAnswerList(raw, expectedCount) {
  if (!Array.isArray(raw) || raw.length !== expectedCount || raw.some((a) => typeof a !== "string")) {
    throw Errors.badRequest("Answer every recovery question.");
  }
  return raw;
}
