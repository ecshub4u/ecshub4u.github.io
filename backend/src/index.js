import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { health } from "./routes/health.js";
import { folders } from "./routes/folders.js";
import { files } from "./routes/files.js";
import { AppError, Errors } from "./errors.js";

const app = new Hono();

// Standard security headers on every response. Hono's own defaults are
// already sensible (X-Content-Type-Options: nosniff, Referrer-Policy:
// no-referrer, HSTS, etc.) -- only overriding the few that need
// tightening or loosening for an API with no HTML/UI of its own:
//  - xFrameOptions 'DENY' instead of the default SAMEORIGIN: nothing
//    about this API should ever be framed, from any origin.
//  - contentSecurityPolicy default-src 'none': this API returns JSON and
//    file bytes, never HTML/JS, so there's nothing a CSP needs to allow.
//  - crossOriginResourcePolicy 'cross-origin': the default ('same-origin')
//    would fight the whole point of this API being called from a
//    different origin (the GitHub Pages frontend) -- CORS below is what
//    actually controls who's allowed to call it.
app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    contentSecurityPolicy: { defaultSrc: ["'none'"] },
    crossOriginResourcePolicy: "cross-origin",
    permissionsPolicy: { camera: false, microphone: false, geolocation: false },
  })
);

// CORS: only explicitly configured origins may call this API.
// ALLOWED_ORIGINS in wrangler.toml is a comma-separated list, so both the
// local dev server and the production frontend domain(s) can be listed
// side by side without code changes.
app.use("*", async (c, next) => {
  const allowedOrigins = (c.env.ALLOWED_ORIGINS || c.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const middleware = cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Content-Range is required from Phase 12 onward: chunked upload
    // requests (PUT /api/folders/:id/uploads/:uploadId) send it to tell
    // the server which byte range a chunk covers, and it's not one of
    // the handful of headers browsers allow cross-origin by default.
    allowHeaders: ["Content-Type", "Authorization", "Content-Range"],
    maxAge: 86400,
  });
  return middleware(c, next);
});

// Reject oversized JSON bodies before parsing them. Every JSON endpoint
// here (folder/file names, passwords) is naturally tiny; file uploads use
// multipart/form-data, which this check doesn't touch. This mainly
// protects CPU time, not memory -- there's no reason to spend cycles
// parsing a body that was never going to validate anyway.
const MAX_JSON_BODY_BYTES = 20_000;
app.use("*", async (c, next) => {
  const contentType = c.req.header("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const length = Number(c.req.header("Content-Length") || 0);
    if (length > MAX_JSON_BODY_BYTES) {
      throw Errors.badRequest("Request body is too large.");
    }
  }
  await next();
});

app.get("/", (c) => c.json({ name: "ECS Drive API", status: "running" }));

app.route("/api/health", health);
app.route("/api/folders", folders);
app.route("/api/files", files);

// Structured error handling: route handlers throw AppError for anything
// expected (bad input, missing folder, wrong password, quota exceeded...).
// Everything else is treated as an unexpected bug -- logged in full
// server-side, and never leaked to the client. See docs/Rules.md > Errors.
app.onError((err, c) => {
  if (err instanceof AppError) {
    if (err.detail) console.error(`[${err.code}]`, err.detail);
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }

  console.error("Unhandled error:", err);
  return c.json(
    { error: { code: "internal_error", message: "Something went wrong on our end. Please try again." } },
    500
  );
});

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "This endpoint doesn't exist." } }, 404)
);

export default app;
