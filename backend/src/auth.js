import { getFolderWithSecrets } from "./db.js";
import { sha256Hex, timingSafeEqual } from "./crypto.js";
import { verifyUnlockToken, verifyManageToken } from "./session.js";
import { logSecurityEvent } from "./audit.js";
import { getClientIp } from "./rateLimit.js";
import { Errors } from "./errors.js";

/**
 * Does this request carry proof that the caller manages `folder`?
 * Two kinds of proof are accepted (see README > "Manager password"):
 *
 *   Authorization: Manage <session>   -- signed in with the manager password
 *                                        (or reset it). Only counts while its
 *                                        version matches the folder's
 *                                        manager_version, so changing/resetting
 *                                        the password signs everyone out.
 *   Authorization: Bearer <token>     -- the long management token of an OLDER
 *                                        folder. New folders' tokens are random
 *                                        values nobody is ever given, so this
 *                                        can never match for them.
 *
 * `folder` needs: id, management_token_hash, manager_version.
 * Returns "manage", "bearer" or null (no valid proof); never throws for a
 * bad credential -- callers decide what to do about it.
 */
export async function managementProof(c, folder) {
  const header = c.req.header("Authorization") || "";

  const manage = header.match(/^Manage\s+(.+)$/i);
  if (manage) {
    const version = await verifyManageToken(c.env, manage[1].trim(), folder.id);
    return version !== null && version === Number(folder.manager_version ?? 1) ? "manage" : null;
  }

  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) {
    const providedHash = await sha256Hex(bearer[1].trim());
    return timingSafeEqual(providedHash, folder.management_token_hash) ? "bearer" : null;
  }
  return null;
}

/** Throws unless the caller manages `folder` (see managementProof). */
export async function assertManagementAccess(c, folder) {
  if (await managementProof(c, folder)) return;

  const header = c.req.header("Authorization") || "";
  if (/^Manage\s+/i.test(header)) {
    // They were signed in, but that session is no longer good (expired, or
    // the password was changed/reset). Let the website sign them out cleanly.
    throw Errors.sessionExpired();
  }
  if (!/^Bearer\s+/i.test(header)) {
    throw Errors.unauthorized("Sign in as this folder's manager to do that.");
  }
  await logSecurityEvent(c, "management_auth_failed", { folderId: folder.id, clientIp: getClientIp(c) });
  throw Errors.unauthorized("Invalid management token.");
}

/**
 * Loads a folder and verifies the caller manages it. Returns the folder row
 * (including secrets -- safe here, since the caller just proved they own it)
 * so the route doesn't need a second read.
 */
export async function requireManagementAccess(c, folderId) {
  const folder = await getFolderWithSecrets(c, folderId);
  if (!folder) {
    throw Errors.notFound("Folder");
  }
  await assertManagementAccess(c, folder);
  return folder;
}

/**
 * Verifies the caller may *view* a folder's files: always true for public
 * folders, and for protected folders requires either a valid unlock token
 * (`Authorization: Unlock <token>`, from POST /unlock) or proof they manage
 * the folder (a manager never needs to unlock their own folder).
 */
export async function assertFolderViewAccess(c, folder) {
  if (!folder.password_hash) return; // public folder -- nothing to check

  if (await managementProof(c, folder)) return;

  const header = c.req.header("Authorization") || "";
  const unlockMatch = header.match(/^Unlock\s+(.+)$/i);
  if (unlockMatch) {
    const verifiedFolderId = await verifyUnlockToken(c.env, unlockMatch[1].trim(), folder.id);
    if (verifiedFolderId) return;
  }

  await logSecurityEvent(c, "folder_view_denied", { folderId: folder.id, clientIp: getClientIp(c) });
  throw Errors.unauthorized("This folder is password protected. Unlock it first.");
}
