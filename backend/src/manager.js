import { keyedHash } from "./session.js";
import { timingSafeEqual } from "./crypto.js";
import { normalizeAnswer } from "./validate.js";

/**
 * Manager password + recovery answers: how a folder's owner proves they own
 * it (replacing the long management token for new folders). Only keyed
 * hashes are stored -- see session.js > keyedHash for why -- and every hash
 * is bound to its folder's id, so two folders with the same password never
 * share a stored value.
 */

export function hashManagerPassword(env, folderId, password) {
  return keyedHash(env, `manager-password:${folderId}`, password);
}

/** Both answers are normalized (case, spacing, punctuation) and hashed as one
 * value, so a single comparison decides, and a partly-right guess reveals
 * nothing about which answer was right. */
export function hashRecoveryAnswers(env, folderId, answers) {
  return keyedHash(env, `recovery-answers:${folderId}`, answers.map(normalizeAnswer).join("\u001f"));
}

export async function managerPasswordMatches(env, folder, password) {
  if (!folder.manager_password_hash) return false;
  const supplied = await hashManagerPassword(env, folder.id, password);
  return timingSafeEqual(supplied, folder.manager_password_hash);
}

export async function recoveryAnswersMatch(env, folder, answers) {
  if (!folder.recovery_answers_hash) return false;
  const supplied = await hashRecoveryAnswers(env, folder.id, answers);
  return timingSafeEqual(supplied, folder.recovery_answers_hash);
}
