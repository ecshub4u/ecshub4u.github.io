import { recordRateLimitAttempt, clearRateLimit } from "./db.js";
import { logSecurityEvent } from "./audit.js";
import { Errors } from "./errors.js";

function currentWindowStart(windowMs) {
  return new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
}

/**
 * Generic fixed-window rate limiter, built on the same `rate_limits`
 * table for every event type. Records one attempt for `key` and throws
 * Errors.rateLimited(message) if this pushes the current window over
 * maxAttempts. The attempt is always recorded, even when it triggers the
 * throw -- an attacker retrying immediately keeps hitting the same
 * rejection instead of getting a fresh window's worth of tries.
 */
export async function enforceRateLimit(c, key, eventType, { windowMs, maxAttempts, message }) {
  const windowStart = currentWindowStart(windowMs);
  const count = await recordRateLimitAttempt(c, key, eventType, windowStart);
  if (count > maxAttempts) {
    await logSecurityEvent(c, `rate_limited:${eventType}`, { detail: `key=${key} count=${count}/${maxAttempts}` });
    throw Errors.rateLimited(message);
  }
}

export function getClientIp(c) {
  // Set by Cloudflare's network on real deployments. Falls back to a
  // constant during local `wrangler dev`, where every request still
  // shares one rate-limit bucket -- fine for local testing, not a
  // concern in production.
  return c.req.header("CF-Connecting-IP") || "local-dev";
}

// ---------- Unlock attempts ----------
// Keyed per folder *and* IP, so one noisy client can't lock everyone else
// out of a shared folder -- but note this doesn't stop a distributed
// attempt from many IPs; that's a known gap, not a goal here.

const UNLOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const UNLOCK_MAX_ATTEMPTS = 5;

export async function enforceUnlockRateLimit(c, folderId, clientIp) {
  await enforceRateLimit(c, `${folderId}:${clientIp}`, "unlock_attempt", {
    windowMs: UNLOCK_WINDOW_MS,
    maxAttempts: UNLOCK_MAX_ATTEMPTS,
    message: "Too many attempts on this folder. Please wait 15 minutes and try again.",
  });
}

/** Called after a successful unlock so earlier failed attempts don't count
 * against the next legitimate visit. */
export async function resetUnlockRateLimit(c, folderId, clientIp) {
  await clearRateLimit(c, `${folderId}:${clientIp}`, "unlock_attempt");
}

// ---------- Folder creation ----------
// Keyed per IP only (there's no folder yet to key on). Generous enough
// for normal club/class use, tight enough to blunt a scripted spam run.

const FOLDER_CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FOLDER_CREATE_MAX_ATTEMPTS = 10;

export async function enforceFolderCreateRateLimit(c, clientIp) {
  await enforceRateLimit(c, clientIp, "folder_create", {
    windowMs: FOLDER_CREATE_WINDOW_MS,
    maxAttempts: FOLDER_CREATE_MAX_ATTEMPTS,
    message: "Too many folders created from this connection recently. Please try again later.",
  });
}

// ---------- File uploads ----------
// Keyed per IP. The 1 GB-per-folder quota already limits total damage;
// this is about request *rate* (e.g. a script hammering the endpoint),
// not total bytes.

const UPLOAD_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Every file is one upload, and dropping a whole project folder can be a few
// hundred files -- so this is set well above one-file-at-a-time use. Each
// upload costs only a handful of small D1 writes, so even hitting this cap
// every hour stays far under D1's free daily write allowance.
const UPLOAD_MAX_ATTEMPTS = 600;

export async function enforceUploadRateLimit(c, clientIp) {
  await enforceRateLimit(c, clientIp, "file_upload", {
    windowMs: UPLOAD_WINDOW_MS,
    maxAttempts: UPLOAD_MAX_ATTEMPTS,
    message: "Too many uploads from this connection recently. Please try again later.",
  });
}

// ---------- Manager sign-in and password recovery ----------
// Signing in (or changing the password) is limited per folder + IP, like the
// viewing password. Recovery answers are weaker secrets than a password, so
// they get a second, folder-wide cap on top of the per-IP one: even someone
// spreading guesses over many IPs can only try 20 times a day per folder.

const MANAGE_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MANAGE_LOGIN_MAX_ATTEMPTS = 5;

export async function enforceManageLoginRateLimit(c, folderId, clientIp) {
  await enforceRateLimit(c, `${folderId}:${clientIp}`, "manage_login", {
    windowMs: MANAGE_LOGIN_WINDOW_MS,
    maxAttempts: MANAGE_LOGIN_MAX_ATTEMPTS,
    message: "Too many attempts. Please wait 15 minutes and try again.",
  });
}

export async function resetManageLoginRateLimit(c, folderId, clientIp) {
  await clearRateLimit(c, `${folderId}:${clientIp}`, "manage_login");
}

const RECOVERY_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RECOVERY_IP_MAX_ATTEMPTS = 5;
const RECOVERY_FOLDER_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
const RECOVERY_FOLDER_MAX_ATTEMPTS = 20;

export async function enforceRecoveryRateLimit(c, folderId, clientIp) {
  await enforceRateLimit(c, `${folderId}:${clientIp}`, "recovery_attempt", {
    windowMs: RECOVERY_IP_WINDOW_MS,
    maxAttempts: RECOVERY_IP_MAX_ATTEMPTS,
    message: "Too many recovery attempts. Please wait an hour and try again.",
  });
  await enforceRateLimit(c, folderId, "recovery_attempt_folder", {
    windowMs: RECOVERY_FOLDER_WINDOW_MS,
    maxAttempts: RECOVERY_FOLDER_MAX_ATTEMPTS,
    message: "Too many recovery attempts on this folder today. Please try again tomorrow.",
  });
}

export async function resetRecoveryRateLimit(c, folderId, clientIp) {
  await clearRateLimit(c, `${folderId}:${clientIp}`, "recovery_attempt");
}
