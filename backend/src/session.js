import { Errors } from "./errors.js";
import { timingSafeEqual } from "./crypto.js";

/**
 * A temporary "I already entered the right password" token for a
 * protected folder. Stateless (HMAC-signed, no DB row) so it costs
 * nothing to issue or check — Phase 5's file routes will require this
 * token (as `Authorization: Unlock <token>`) for protected folders.
 */

const TTL_SECONDS = 30 * 60; // 30 minutes

export async function issueUnlockToken(env, folderId) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${folderId}.${exp}`;
  const signature = await sign(env, payload);
  return `${base64UrlEncode(payload)}.${signature}`;
}

/** Returns the folderId if the token is valid and unexpired, else null. */
export async function verifyUnlockToken(env, token, expectedFolderId) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;

  const lastDot = token.lastIndexOf(".");
  const payloadB64 = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);

  let payload;
  try {
    payload = base64UrlDecode(payloadB64);
  } catch {
    return null;
  }

  const expectedSignature = await sign(env, payload);
  if (expectedSignature !== signature) return null;

  const [folderId, expStr] = payload.split(".");
  const exp = Number(expStr);
  if (folderId !== expectedFolderId) return null;
  if (!exp || Date.now() / 1000 > exp) return null;

  return folderId;
}

// ---------- Manager sessions ----------
// What a folder's manager gets after signing in with the manager password
// (or resetting it). Same idea as the unlock token -- stateless, HMAC-signed,
// nothing stored -- but longer-lived, and it carries the folder's
// `manager_version`: changing or resetting the password bumps that number,
// which instantly makes every older session (on any device) stop working.
// Sent as  Authorization: Manage <token>.

const MANAGE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MANAGE_PREFIX = "mgr.";

export async function issueManageToken(env, folderId, version) {
  const exp = Math.floor(Date.now() / 1000) + MANAGE_TTL_SECONDS;
  const payload = `${folderId}.${exp}.${version}`;
  const signature = await sign(env, `manage-session:${payload}`);
  return `${MANAGE_PREFIX}${base64UrlEncode(payload)}.${signature}`;
}

/** Returns the session's manager_version if the token is genuine, unexpired
 * and for this folder; otherwise null. */
export async function verifyManageToken(env, token, expectedFolderId) {
  if (typeof token !== "string" || !token.startsWith(MANAGE_PREFIX)) return null;
  const body = token.slice(MANAGE_PREFIX.length);
  const lastDot = body.lastIndexOf(".");
  if (lastDot === -1) return null;

  let payload;
  try {
    payload = base64UrlDecode(body.slice(0, lastDot));
  } catch {
    return null;
  }
  const expectedSignature = await sign(env, `manage-session:${payload}`);
  if (!timingSafeEqual(expectedSignature, body.slice(lastDot + 1))) return null;

  const [folderId, expStr, versionStr] = payload.split(".");
  const exp = Number(expStr);
  const version = Number(versionStr);
  if (folderId !== expectedFolderId) return null;
  if (!exp || Date.now() / 1000 > exp) return null;
  if (!Number.isInteger(version)) return null;
  return version;
}

// ---------- Keyed hashes for the manager password and recovery answers ----------
// HMAC-SHA256 with the server's secret. Why not PBKDF2 like the folder
// (viewing) password? Workers' free plan gives ~10 ms of CPU per request and
// one PBKDF2 run already takes ~5.5 ms (see password.js); creating a folder
// needs both the manager password AND the recovery answers hashed in the same
// request, which would blow that budget. A keyed hash gives the property that
// matters here: a copy of the database alone can't be used to guess
// passwords/answers offline, because the key lives only in the Worker's
// secrets. Guessing through the API is what the rate limits are for.
// CONSEQUENCE: changing UNLOCK_SESSION_SECRET after folders exist makes every
// manager password and recovery answer stop matching -- don't rotate it.
export async function keyedHash(env, context, value) {
  return sign(env, `secret:${context}\u0000${value}`);
}

async function sign(env, payload) {
  if (!env.UNLOCK_SESSION_SECRET) {
    throw Errors.internal("Missing secret UNLOCK_SESSION_SECRET — see backend/README.md.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.UNLOCK_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signatureBytes));
}

function base64UrlEncode(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}
function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  return atob(padded);
}
