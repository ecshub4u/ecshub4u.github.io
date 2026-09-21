export const GB = 1024 * 1024 * 1024;

/** Every folder's storage quota — enforced server-side on every upload,
 * regardless of what any client believes. See docs/Architecture.md. */
export const FOLDER_QUOTA_BYTES = 1 * GB;

/**
 * Chunk size for resumable Drive uploads. Must be a multiple of 256 KiB
 * (Google's requirement for all but the final chunk) — 8 MiB = 32 x
 * 256 KiB, comfortably satisfies that. Chosen to stay far under
 * Cloudflare Workers' free-plan 100 MB request-body cap (enforced at
 * the edge, before the Worker even runs — no amount of in-Worker
 * streaming can raise that ceiling) and its 128 MB memory limit, since
 * each chunk is buffered in Worker memory for exactly one request.
 */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** How long an abandoned upload session (started, never finished or
 * explicitly cancelled) sticks around before opportunistic cleanup
 * removes it. Google auto-expires the Drive-side incomplete session on
 * its own after about a week regardless. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How many files one "delete sub-folder" request removes before asking the
 * client to call again. Each file costs two outgoing requests to Google
 * (token refresh + trash), and Cloudflare's free plan allows only 50
 * outgoing requests per Worker invocation, so a big sub-folder has to be
 * deleted in small batches rather than all at once. */
export const PATH_DELETE_BATCH = 10;
