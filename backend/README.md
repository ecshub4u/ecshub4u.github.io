# ECS Drive API

Cloudflare Worker backend, built with [Hono](https://hono.dev). This is
Phase 2: the project exists, connects to a D1 database, and exposes a
health-check endpoint with structured error handling. No folder/file/Drive
logic yet — that starts in Phase 3.

## One-time setup

```bash
cd backend
npm install
npx wrangler login          # opens a browser to link your Cloudflare account
npx wrangler d1 create ecs-drive-db
```

Copy the `database_id` the last command prints into `wrangler.toml` under
`[[d1_databases]]`.

Then create the tables:

```bash
npm run db:migrate:local     # for local dev
npm run db:migrate:remote    # for the real deployed database
```

If you'll eventually need local secrets (none required yet — see
`.dev.vars.example`), copy it to `.dev.vars`, which is gitignored.

## Run it

```bash
npm run dev
```

Then check:

```bash
curl http://localhost:8787/api/health
# {"status":"ok","time":"...","db":"connected"}
```

## Deploy

```bash
npm run deploy
```

Real secrets (added from Phase 5 onward, e.g. Google Drive service-account
credentials) are set with:

```bash
npx wrangler secret put SECRET_NAME
```

They are never written to `wrangler.toml` or any committed file.

## Google Drive setup (required from Phase 3 onward)

ECS Drive stores files in the **project owner's own Google Drive**, not in
a separate service-account Drive (service accounts get their own mostly-empty
storage, which isn't what we want). So the owner authorizes this app once,
and the server uses a long-lived refresh token from then on.

1. In [Google Cloud Console](https://console.cloud.google.com), create a
   project (or reuse one), enable the **Google Drive API**, and create an
   **OAuth 2.0 Client ID** (type: Web application). Add
   `https://developers.google.com/oauthplayground` as an authorized redirect
   URI — that's the easiest way to complete the one-time authorization below.
2. **Set the OAuth consent screen's publishing status to "In production"**
   (Cloud Console → APIs & Services → OAuth consent screen → Publish App).
   This step is easy to miss and causes a real, delayed failure: a fresh
   project defaults to **"Testing,"** and Google silently expires refresh
   tokens issued under Testing status after **7 days** — everything works
   at first, then folder creation/uploads start failing a week later with
   no obvious cause. Moving to "In production" removes that limit. Since
   the Drive scope isn't a "restricted" scope, this doesn't require Google's
   formal verification process to flip — the only visible effect is that
   the *one* person consenting (you, in step 4) sees an "unverified app"
   click-through warning, which is fine to accept for your own project.
3. In your Drive, create one folder that will hold every student folder
   (e.g. "ECS Drive"). Open it and copy the ID from the URL
   (`drive.google.com/drive/folders/<this part>`). Put it in `wrangler.toml`
   as `GOOGLE_ROOT_FOLDER_ID`.
4. Go to [OAuth Playground](https://developers.google.com/oauthplayground),
   click the gear icon, check "Use your own OAuth credentials," and paste in
   your Client ID/Secret from step 1.
5. In the left panel, find **Drive API v3** and select the
   `https://www.googleapis.com/auth/drive` scope. Click **Authorize APIs**
   and sign in with the Google account whose Drive should hold the files.
6. Click **Exchange authorization code for tokens**. Copy the **refresh
   token** it returns — this does not expire on its own *as long as step 2
   was actually done*; otherwise it silently stops working after 7 days
   (see step 2). If you generated a token before doing step 2, redo this
   step afterward — a token issued under "Testing" doesn't retroactively
   become long-lived when you switch to "In production."

Set the three secrets locally and in production:

```bash
# local dev: put these in backend/.dev.vars (see .dev.vars.example)
# production:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

## Try the folder endpoints

```bash
# Create a folder — save the managementToken, it's shown only this once
curl -X POST http://localhost:8787/api/folders \
  -H "Content-Type: application/json" \
  -d '{"name":"Priya — Semester 4 Notes"}'

# List folders (public fields only)
curl http://localhost:8787/api/folders

# Rename (requires the management token from creation)
curl -X PATCH http://localhost:8787/api/folders/<id> \
  -H "Authorization: Bearer <managementToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"New name"}'

# Delete (trashes the Drive folder, soft-deletes the DB row)
curl -X DELETE http://localhost:8787/api/folders/<id> \
  -H "Authorization: Bearer <managementToken>"
```

## Why no bcrypt/argon2

`src/crypto.js` hashes **management tokens** with SHA-256 — long,
high-entropy random values, where a fast cryptographic hash is the
standard, correct tool (same approach most APIs use for API keys).

Folder **passwords** (`src/password.js`) use PBKDF2-SHA256 via the
Workers-native Web Crypto API, not Argon2id/bcrypt as originally planned.
Reason: Cloudflare Workers' free plan caps CPU time at ~10ms per request,
and a properly-configured Argon2id run (pure JS/WASM, no hardware
acceleration) measured well over that budget on its own. PBKDF2 via
`crypto.subtle` is hardware-backed and fast enough to fit. Its iteration
count is also lower than OWASP's ideal recommendation for the same
reason — see the comment at the top of `src/password.js` for the exact
numbers and trade-off reasoning. This only gates casual access to student
folders, not high-value accounts, so the trade-off was made deliberately
in favor of staying on the free tier.

## Try the password / unlock endpoints

```bash
# Create a password-protected folder
curl -X POST http://localhost:8787/api/folders \
  -H "Content-Type: application/json" \
  -d '{"name":"Robotics Club Resources","password":"gearup"}'

# Unlock it (rate-limited: 5 attempts per 15 minutes per folder+IP)
curl -X POST http://localhost:8787/api/folders/<id>/unlock \
  -H "Content-Type: application/json" \
  -d '{"password":"gearup"}'
# -> {"unlocked":true,"unlockToken":"..."}  (valid 30 minutes; Phase 5's
#     file routes will accept this the same way they'll accept a fresh
#     correct password)
```

Set the new secret used to sign unlock tokens:

```bash
# local dev: add to backend/.dev.vars (see .dev.vars.example)
# production:
npx wrangler secret put UNLOCK_SESSION_SECRET   # any long random string, e.g. `openssl rand -base64 32`
```

## Chunked uploads (Phase 12)

Uploads are chunked/resumable, not a single request — see `src/drive.js`'s
header comment for the full reasoning. Short version: Cloudflare Workers'
free plan rejects any single request body over 100 MB *at the edge*,
before the Worker even runs, so a large file has to arrive as multiple
smaller requests. Every request, including every chunk, is relayed to
Drive server-side — the browser never sees a Drive session URI or
credential.

Flow: `POST /api/folders/:id/uploads` to start (returns `uploadId` and
the server's chunk size), then `PUT /api/folders/:id/uploads/:uploadId`
once per chunk with a `Content-Range: bytes <start>-<end>/<total>`
header and the chunk's raw bytes as the body. The response is always a
normal `200`/`201` JSON body — Drive's own `308 Resume Incomplete` is
deliberately never passed through as our HTTP status, since a raw `308`
would make a browser's `fetch()` try to follow it as an actual redirect
instead of reading the response.

```bash
# 1. Start the upload
curl -X POST http://localhost:8787/api/folders/<id>/uploads \
  -H "Content-Type: application/json" \
  -d '{"name":"notes.pdf","mimeType":"application/pdf","sizeBytes":11}'
# -> {"uploadId":"...","chunkSize":8388608}

# 2. Send the (only, since this example is tiny) chunk
curl -X PUT "http://localhost:8787/api/folders/<id>/uploads/<uploadId>" \
  -H "Content-Range: bytes 0-10/11" \
  --data-binary "hello world"
# -> 201 {"id":"...","name":"notes.pdf","mimeType":"application/pdf","sizeBytes":11,"createdAt":"..."}

# Check status after a dropped connection (empty body, no bytes re-sent)
curl -X PUT "http://localhost:8787/api/folders/<id>/uploads/<uploadId>" \
  -H "Content-Range: bytes */11"
# -> 200 {"done":false,"bytesConfirmed":6}  (resume from byte 6, not 0)

# Cancel an abandoned upload
curl -X DELETE "http://localhost:8787/api/folders/<id>/uploads/<uploadId>"
```

Protected folders: the management-token check happens once, at
`POST /uploads` — not re-checked per chunk. Possessing the `uploadId`
(an unguessable UUID, only ever handed to whoever passed that check) is
what authorizes each chunk, the same capability-token model already used
for unlock/management tokens elsewhere.

## Sub-folders: uploading a whole folder without zipping it

Sub-folders are **virtual**. Each file row has a `path` column (e.g.
`calendar/css`; `''` = top level of the student folder), and the website
shows those paths as folders. Nothing extra is created on Google Drive --
the files all sit in the student folder's one Drive folder. Consequences:

- A sub-folder exists only while it has files in it (empty folders aren't kept).
- Renaming a file only changes its name, never its path.
- The Drive owner sees a flat list; the tree is a feature of the website.

API additions:

- `POST /api/folders/:id/uploads` accepts an optional `path` in its body.
  It is checked by `validateDirPath` (max 10 levels deep, no `.`/`..`, no
  backslashes or control characters, same per-name rules as file names).
- `GET /api/folders/:id/files` now includes `path` on every file.
- `DELETE /api/folders/:id/paths?path=calendar/css` (management token
  required) trashes every file at or below that path. It handles at most
  `PATH_DELETE_BATCH` (10) files per call and returns
  `{ deleted, failed, remaining, freedBytes }`; the website repeats the call
  while `remaining > 0`. The batch is small on purpose: every file costs two
  outgoing requests to Google and Cloudflare's free plan allows 50 per Worker
  invocation.

**Upgrading a database created before this feature** (run once):

```bash
cd backend
npm run db:migrate-paths:local      # your local test database
npm run db:migrate-paths:remote     # the real Cloudflare database, when deployed
```

A brand-new database made from the current `schema.sql` already has the
column -- don't run the migration on it (SQLite would answer "duplicate
column name": harmless, but confusing).

The upload rate limit went from 60 to 600 per hour per IP, because every file
in a dropped folder is one upload. It is a single number
(`UPLOAD_MAX_ATTEMPTS` in `src/rateLimit.js`). On the website, one drop or
pick is capped at 500 files, and `node_modules` and `.git` folders and
system files (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are skipped.

## Manager password + recovery questions (no management token to save)

New folders are managed with a **manager password** the owner chooses, plus
**two recovery questions** for when they forget it. Nothing is ever copied or
saved: creating a folder signs the creator in, and any other phone or laptop
signs in with the password. Folders made before this feature keep working with
their long management token (`managerMode: "token"` in the folder JSON).

How it works:

- `POST /api/folders` takes `managerPassword` (6-100 chars, must differ from
  the viewing password) and `recovery` (exactly two `{ question, answer }`).
  The response's `managementToken` is a **manager session**
  (`mgr.<payload>.<signature>`, HMAC-signed, 30 days) -- the website stores it
  silently. Sent as `Authorization: Manage <session>`.
- `POST /api/folders/:id/manage/login` `{ password }` -> new session. 5 tries
  per 15 minutes per folder + IP.
- `GET  /api/folders/:id/manage/recovery-questions` -> the two questions only.
- `POST /api/folders/:id/manage/reset` `{ answers, newPassword }` -> "forgot
  my password". Answers are compared after normalizing (case, punctuation,
  spacing; Devanagari kept). Limited to 5 tries/hour per IP **and** 20/day per
  folder, because recovery answers are weaker secrets than a password.
- `POST /api/folders/:id/manage/password` `{ currentPassword, newPassword }` ->
  change it while signed in (needs the session *and* the current password).
- Every password change/reset bumps the folder's `manager_version`, and a
  session is only valid for the version it was issued at -- so all other
  devices are signed out at once (the site shows them the sign-in link again).
- The stored password and the recovery answers are **HMAC-SHA256 keyed
  hashes**, bound to the folder id (`session.js > keyedHash`), not PBKDF2.
  Reason: the free Workers plan gives ~10 ms CPU per request and one PBKDF2
  run is ~5.5 ms (see `password.js`); creating a folder needs two of these
  secrets hashed in one request. A keyed hash still means a stolen copy of the
  database can't be used to guess anything offline. **Never change
  `UNLOCK_SESSION_SECRET` once folders exist** -- it is the key for these
  hashes, so changing it makes every manager password and recovery answer stop
  matching (the viewing passwords and the older token folders are unaffected).
- Honest limits: recovery questions are only as strong as their answers
  (classmates may know "favourite teacher"); the two limits above plus the
  session-ending on reset are the safety net, and deleted files go to Drive's
  trash where the Drive owner can still restore them.

**Upgrading a database from before this feature** (run once, in this order;
skip a step if it says `duplicate column name` -- that step was already done):

```bash
cd backend
npm run db:migrate-paths:local      # sub-folders (001) -- skip if you already ran it
npm run db:migrate-manager:local    # manager password (002)
# later, for the real Cloudflare database:
npm run db:migrate-paths:remote
npm run db:migrate-manager:remote
```

A database created from the current `schema.sql` already has everything.

## Try the other file endpoints

```bash
# List a folder's files (protected folders need Authorization: Unlock <unlockToken>
# from POST /unlock, or Authorization: Bearer <managementToken>)
curl http://localhost:8787/api/folders/<id>/files

# Download a file
curl -OJ http://localhost:8787/api/files/<fileId>

# Rename a file — requires the folder's management token
curl -X PATCH http://localhost:8787/api/files/<fileId> \
  -H "Authorization: Bearer <managementToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"renamed.pdf"}'

# Delete a file — always requires the folder's management token
curl -X DELETE http://localhost:8787/api/files/<fileId> \
  -H "Authorization: Bearer <managementToken>"
```

## Concurrent uploads & quota enforcement

Quota enforcement has two layers:

1. An early check (`getFolderUsedBytes` vs. `FOLDER_QUOTA_BYTES`) at
   `POST /uploads` time, against the *declared* size — cheap, and
   rejects an obviously-oversized upload before a Drive session is even
   opened.
2. The real enforcement, on the chunk that completes the upload: Drive's
   own authoritative byte count for the finished file (not the client's
   original declaration, not our own running tally) is checked and
   inserted in **one atomic SQL statement**
   (`insertFileIfWithinQuota` — `INSERT ... SELECT ... WHERE (quota check)`),
   not two separate round trips. SQLite (what D1 runs on) executes a
   single statement atomically, so two uploads racing the same folder
   can't both read "under quota" before either has written — only one
   insert can win if together they'd exceed 1 GB. The loser's
   already-uploaded Drive file gets trashed, same as any other
   post-upload failure.

This was verified locally with Node's built-in SQLite (same engine D1
uses): inserting up to exactly the quota succeeds, the next byte over
fails, and the final total never exceeds the limit — see
`test/db.test.js`'s dedicated regression test (it fires two uploads at
the same folder concurrently via `Promise.all`).

## Try the quota fields

`GET /api/folders` and `GET /api/folders/:id` now include `quotaBytes`
and `remainingBytes` alongside `usedBytes`, so any frontend can render a
usage meter without hardcoding the 1 GB limit:

```json
{
  "id": "...",
  "name": "Robotics Club Resources",
  "usedBytes": 734003200,
  "quotaBytes": 1073741824,
  "remainingBytes": 339738624
}
```

## Security (Phase 7)

- **Security headers** on every response via Hono's built-in
  `secureHeaders()` middleware: `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'none'` (this API returns only
  JSON and file bytes, never HTML), plus Hono's sensible defaults
  (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  HSTS, etc). `Cross-Origin-Resource-Policy` is set to `cross-origin`
  since this API is meant to be called from a different origin (the
  frontend) — CORS below is what actually controls who's allowed.
- **CORS** now supports multiple allowed origins: `ALLOWED_ORIGINS` in
  `wrangler.toml` is a comma-separated list (so local dev and the
  production frontend domain can coexist), with methods/headers
  explicitly allowlisted rather than left open.
- **Body-size guard**: JSON request bodies over 20 KB are rejected before
  parsing (every JSON endpoint here is naturally tiny; file uploads use
  multipart/form-data and aren't affected).
- **Input validation** now rejects non-string JSON fields cleanly (a
  number or object where a name/password was expected used to throw an
  uncaught `TypeError`, sanitized into a generic 500 by the global
  handler — now it's a proper 400).
- **Rate limiting** now covers folder creation (10/hour/IP) and file
  uploads (now 600/hour/IP -- see "Sub-folders" below) in addition to unlock attempts (5/15 min per
  folder+IP from Phase 4) — all on the same `rate_limits` table.
- **Token rotation**: `POST /api/folders/:id/rotate-token` (management
  token required) invalidates the current management token immediately
  and issues a new one, for when a token might have leaked. Unlock
  tokens don't have individual revocation (they're stateless/signed, by
  design — see Phase 4), but rotating `UNLOCK_SESSION_SECRET`
  invalidates every outstanding one at once, as a coarse last resort.
- **Audit/security events**: a new `security_events` table (append-only,
  never read back by the API — see `src/audit.js`) logs rate-limit hits,
  failed management-token checks, denied folder views, unlock
  success/failure, and folder/file create/rename/delete/rotate events.
  Query it directly in D1 (`wrangler d1 execute ecs-drive-db --remote
  --command "SELECT * FROM security_events ORDER BY created_at DESC
  LIMIT 50"`) if something looks off. If you migrated the database before
  this phase, re-run `npm run db:migrate:local` / `:remote` — `schema.sql`
  uses `CREATE TABLE IF NOT EXISTS`, so re-running it is safe and won't
  touch your existing data, it just adds the new table.
- **Error sanitization** was already in place since Phase 2 (`AppError` +
  the global handler) — this phase's review didn't find anything to
  change there.

## Try token rotation

```bash
curl -X POST http://localhost:8787/api/folders/<id>/rotate-token \
  -H "Authorization: Bearer <oldManagementToken>"
# -> {"managementToken":"..."}  -- the old token stops working immediately
```

## Testing (Phase 9)

```bash
npm install   # needed once, for hono -- the integration suite imports the real app
npm test
```

Three tiers, all using Node's built-in test runner (`node:test` — zero
extra dependency for the parts that don't need it):

- **Unit tests** (`crypto.test.js`, `password.test.js`, `validate.test.js`,
  `session.test.js`) — pure logic, no D1 or network involved. These run
  with just `node --test`, no `npm install` required at all.
- **`drive.test.js`** — tests `src/drive.js`'s resumable-upload functions
  (initiate/chunk/status-check/cancel) directly against a canned `fetch`
  (`test/helpers/fakeDrive.js`), with **no Hono involved at all** — unlike
  `routes.test.js` below, this runs even where `hono` isn't installed,
  since `drive.js` doesn't import it. This is the one place the actual
  chunked-upload client logic gets real, always-runnable coverage.
- **DB tests** (`db.test.js`) — import the *real* `src/db.js` functions
  and run them against an in-memory SQLite database (via Node's built-in
  `node:sqlite`, the same engine D1 uses), wrapped in a small D1-shaped
  adapter (`test/helpers/fakeD1.js`) that only implements the handful of
  methods `db.js` actually calls. A passing test here means the real
  queries work, not a reimplementation of them. Includes a direct
  regression test for the Phase 6 quota race condition: it fires two
  uploads at the same folder concurrently via `Promise.all` and asserts
  only one can win when together they'd exceed the quota.
- **Integration tests** (`routes.test.js`) — import the real Hono `app`
  from `src/index.js` and drive it with `app.request(path, init, env)`
  (Hono's documented testing API), against a fresh fake-D1 per test and a
  canned `fetch` standing in for Google Drive/OAuth
  (`test/helpers/fakeDrive.js`), so no real network call ever happens.
  Covers the full folder + file lifecycle, auth (missing/wrong/correct
  management token), the unlock rate limit actually tripping after 5
  attempts, the full chunked-upload flow (multi-chunk, status-check
  resume, cancellation, quota rejection at the true 1GB boundary),
  security headers, CORS (including a regression test for the
  Content-Range preflight bug found in Phase 12), and the JSON
  body-size guard.

**What's actually been run, and what hasn't, in the environment these
tests were written in:** the unit, `drive.js`, and DB tests need nothing
but Node itself and were run directly — 53 of 54 tests pass (the 54th
file being `routes.test.js`, see below). The integration suite needs
`hono` installed (`npm install`), and that environment had no network
access to do so, so `routes.test.js` is syntax-checked and written
against Hono's documented `app.request()` testing API, but was **not**
actually executed there. Run `npm test` yourself after `npm install` to
get real pass/fail on it — don't take it on faith.

If this project ever needs to test against the *actual* Workers runtime
(not just Node standing in for it) — e.g. Workers-specific APIs this
project doesn't currently use — Cloudflare's own recommendation is
[Vitest with `@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/).
That's a reasonable upgrade path; `node:test` was chosen here because
everything this codebase actually uses (Web Crypto, `fetch`, D1's simple
prepare/bind/run interface) already runs identically in Node, so it adds
zero new dependencies while still testing the real production code.

## Deploying

See [`docs/Deployment.md`](../docs/Deployment.md) for the full Phase 10
checklist: GitHub Pages frontend, production secrets, production API URL,
free-tier sizing (checked against current Cloudflare limits), and a
post-deploy smoke test (`scripts/smoke-test.sh`).

## Structure

```
src/
  index.js          Worker entry point: CORS, routing, global error handler
  errors.js          AppError — the one way routes should throw expected errors
  db.js               D1 connection, folder/file/upload-session queries, rate-limit counters
  crypto.js           Fast hashing/tokens for management tokens (Web Crypto only)
  password.js         Slow password hashing for folder passwords (PBKDF2, Web Crypto only)
  validate.js         Input validation (folder names, passwords, file names)
  drive.js            Google Drive API client (folders + chunked/resumable file uploads, download, trash)
  auth.js             Management-token and folder-view access checks
  rateLimit.js         Generic rate-limit policy (unlock, folder create, uploads)
  session.js           Signed, stateless temporary unlock tokens
  audit.js              Append-only security_events logging
  constants.js          Shared numeric constants (1 GB quota, upload chunk size)
  routes/
    health.js         GET /api/health
    folders.js         Folder CRUD, POST /:id/unlock, /:id/rotate-token, GET /:id/files,
                          POST /:id/uploads (start), PUT/DELETE /:id/uploads/:uploadId (chunk/cancel)
    files.js            GET /:id (download), PATCH /:id (rename), DELETE /:id
schema.sql            D1 table definitions (folders, files, rate_limits, security_events, upload_sessions)
wrangler.toml          Worker config, D1 binding, non-secret vars
.dev.vars.example      Template for local secrets (copy to .dev.vars)
scripts/smoke-test.sh   Post-deploy smoke test (see docs/Deployment.md)
test/
  helpers/fakeD1.js      D1-shaped adapter over node:sqlite, for running real db.js in tests
  helpers/fakeDrive.js    Canned fetch responses standing in for Google Drive/OAuth, including the full resumable-upload protocol
  crypto.test.js          Unit tests
  password.test.js         Unit tests
  validate.test.js          Unit tests
  session.test.js            Unit tests
  drive.test.js                Resumable-upload client logic — runs without hono
  db.test.js                     Runs the real db.js against in-memory SQLite
  routes.test.js                   Runs the real Hono app end-to-end
```

## Error handling convention

Route handlers throw `AppError` (see `src/errors.js`) for anything
expected — a missing folder, a wrong password, a quota that would be
exceeded. Anything else (a bug, an unexpected D1 or Drive failure) is
caught by the global handler in `index.js`, logged in full server-side,
and returned to the client as a generic, non-leaking message — per
`docs/Rules.md` > Errors.

```js
import { Errors } from "../errors.js";
// in a route handler:
throw Errors.notFound("Folder");
```
