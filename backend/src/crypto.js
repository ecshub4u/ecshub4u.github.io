/**
 * Crypto helpers built entirely on the Workers-native Web Crypto API —
 * no extra dependency needed for this phase. See README > "Why no
 * bcrypt/argon2 yet" for the password-hashing decision (that's Phase 4).
 */

/** SHA-256 hex digest of a string. Used for hashing management tokens —
 * these are high-entropy random values, not human passwords, so a fast
 * cryptographic hash (not a slow password-hashing KDF) is the right tool. */
export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison, for comparing token hashes so a
 * failed match can't be timed to leak how many leading characters matched. */
export function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** A high-entropy, URL-safe management token — shown to the user exactly
 * once at folder-creation time. Only its hash is ever stored. */
export function generateManagementToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

export function newId() {
  return crypto.randomUUID();
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
