import { Hono } from "hono";
import { pingDb } from "../db.js";

export const health = new Hono();

/**
 * GET /api/health
 * Confirms the API is running and can reach the database. Used for
 * uptime checks and as a quick sanity check after every deploy.
 */
health.get("/", async (c) => {
  let dbStatus = "unknown";
  try {
    dbStatus = (await pingDb(c)) ? "connected" : "unreachable";
  } catch (err) {
    // A DB hiccup shouldn't take down the whole health check — report it
    // as degraded instead of throwing, so the endpoint stays reliable.
    console.error("Health check DB error:", err);
    dbStatus = "error";
  }

  return c.json({
    status: dbStatus === "connected" ? "ok" : "degraded",
    time: new Date().toISOString(),
    db: dbStatus,
  });
});
