import { getDb } from "./db.js";

/**
 * Write-only audit trail. Never read back by the API to make decisions —
 * that would make it a second source of truth to keep in sync. It exists
 * purely so the folder owner can look at `security_events` later and see
 * what happened (repeated failed unlocks on one folder, a burst of
 * folder creations from one IP, etc).
 *
 * A logging failure must never break the request that triggered it, so
 * this always swallows its own errors after logging them to the console.
 */
export async function logSecurityEvent(c, eventType, { folderId = null, clientIp = null, detail = null } = {}) {
  try {
    const db = getDb(c);
    await db
      .prepare(
        `INSERT INTO security_events (id, event_type, folder_id, client_ip, detail)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), eventType, folderId, clientIp, detail)
      .run();
  } catch (err) {
    console.error("Failed to write security event (non-fatal):", eventType, err);
  }
}
