/**
 * AppError is the only kind of error a route handler should throw on
 * purpose — for expected situations like "wrong password" or "folder not
 * found". Anything else (a bug, a Drive API failure, a DB hiccup) is
 * unexpected and gets sanitized by the global error handler in index.js
 * before it reaches the client. See docs/Rules.md > Errors.
 */
export class AppError extends Error {
  constructor(status, code, message, { detail } = {}) {
    super(message);
    this.status = status; // HTTP status to send
    this.code = code; // stable machine-readable code the frontend can branch on
    this.detail = detail; // technical detail — logged server-side only, never sent to the client
  }
}

export const Errors = {
  notFound: (what = "Resource") => new AppError(404, "not_found", `${what} not found.`),
  badRequest: (message, detail) => new AppError(400, "bad_request", message, { detail }),
  unauthorized: (message = "This action requires a valid management token.") =>
    new AppError(401, "unauthorized", message),
  /** The person WAS signed in as manager, but that session is no longer
   * valid (expired, or the password was changed/reset elsewhere). A separate
   * code lets the website quietly sign them out and ask them to sign in again. */
  sessionExpired: () =>
    new AppError(401, "session_expired", "Your manager session has ended. Please sign in again."),
  forbidden: (message = "You don't have permission to do that.") =>
    new AppError(403, "forbidden", message),
  rateLimited: (message = "Too many attempts. Please wait and try again.") =>
    new AppError(429, "rate_limited", message),
  quotaExceeded: (message = "This folder has reached its 1 GB storage quota.") =>
    new AppError(413, "quota_exceeded", message),
  upstream: (detail) =>
    new AppError(
      502,
      "upstream_error",
      "A connected service is unavailable right now. Please try again shortly.",
      { detail }
    ),
  internal: (detail) =>
    new AppError(500, "internal_error", "Something went wrong on our end. Please try again.", {
      detail,
    }),
};
