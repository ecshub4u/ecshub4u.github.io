/**
 * Folder password hashing.
 *
 * Uses PBKDF2-SHA256 via the Workers-native Web Crypto API, NOT
 * Argon2id/bcrypt. This is a deliberate deviation from the original plan
 * (see Memory.md Phase 4 log): Cloudflare Workers' free plan caps CPU
 * time per request at ~10ms, and a properly-configured Argon2id run
 * (pure JS/WASM, no hardware acceleration) routinely exceeds that.
 * PBKDF2 via crypto.subtle is hardware-backed and fast enough to stay
 * under that limit. If Workers' CPU limits change or the project moves
 * off the free tier, this can be swapped for Argon2id without touching
 * any caller -- see verifyPassword/hashPassword's signatures.
 *
 * Iteration count: OWASP's 2023 guidance recommends 210,000+ iterations
 * for PBKDF2-SHA256, but that measured ~41ms in local benchmarking here
 * -- already over the entire 10ms free-tier CPU budget on its own,
 * before any routing, JSON parsing, or DB work. 30,000 iterations
 * measured ~5.5ms, leaving headroom for the rest of the request. This is
 * a real security/cost trade-off, made deliberately: these passwords
 * gate casual access to student coursework folders, not high-value
 * accounts, and the project's stated goal (Rules.md) is to stay on the
 * free tier. If that changes -- e.g. moving to a paid Workers plan
 * (higher CPU limits) -- raise ITERATIONS below; nothing else needs to
 * change, since the iteration count is stored inside each password's
 * hash string, so old and new hashes keep verifying correctly side by side.
 */

const ITERATIONS = 30_000; // see "Iteration count" note above -- lower than OWASP's ideal, on purpose
const SALT_BYTES = 16;
const KEY_LENGTH_BITS = 256;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashBytes = await deriveBits(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hashBytes)}`;
}

export async function verifyPassword(password, encoded) {
  const parts = (encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const [, iterationsStr, saltB64, hashB64] = parts;
  const iterations = Number(iterationsStr);
  const salt = fromBase64Url(saltB64);
  const expected = fromBase64Url(hashB64);

  const actual = await deriveBits(password, salt, iterations);
  return timingSafeEqualBytes(actual, expected);
}

async function deriveBits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH_BITS
  );
  return new Uint8Array(bits);
}

function timingSafeEqualBytes(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
