# Operations: Admin Recovery & Free-Tier Limits

For whoever ends up administering a live ECS Drive instance. Setup is in
`docs/Setup.md`; going live is in `docs/Deployment.md`. This is what to
do once it's running and something needs fixing.

A running theme below: most recovery actions mean running a raw SQL
command against the production database with `wrangler d1 execute
ecs-drive-db --remote --command "..."`. That flag skips every safety
check the API layer normally does — **test any destructive command
against `--local` first**, and double-check the folder/file `id` in the
`WHERE` clause before running it `--remote`.

## Admin recovery

### A student lost their management token

There's no self-serve recovery by design — a recoverable token would
defeat the point of it (the create-folder form says exactly this: "it
won't be shown again"). As the admin, you *can* issue a new one manually,
but treat this as an identity-verification step first (confirm the
request is really from that folder's creator — e.g. over ECS email —
before touching anything, since a leaked token is exactly what this
process would also grant to an impersonator).

```bash
# 1. Find the folder (if you don't already have its id)
npx wrangler d1 execute ecs-drive-db --remote --command \
  "SELECT id, name FROM folders WHERE name LIKE '%part of the name%';"

# 2. Generate a new token
NEW_TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
echo "Give this to the student (and only them): $NEW_TOKEN"

# 3. Hash it the same way the backend does (SHA-256 hex — see src/crypto.js)
NEW_HASH=$(printf '%s' "$NEW_TOKEN" | shasum -a 256 | cut -d' ' -f1)

# 4. Store the hash
npx wrangler d1 execute ecs-drive-db --remote --command \
  "UPDATE folders SET management_token_hash = '$NEW_HASH' WHERE id = '<folder-id>';"
```

### A folder's password needs to be reset

**Known gap**: there's currently no endpoint for an owner to change their
folder's password after creation — only set one at creation time. Until
that's built, an admin-assisted reset uses the same production hashing
code directly (not a reimplementation, so it stays consistent with what
`verifyPassword` expects):

```bash
cd backend
node -e "
import('./src/password.js').then(async ({ hashPassword }) => {
  console.log(await hashPassword(process.argv[1]));
});
" "the-new-password"
```

Then take the printed hash and:

```bash
npx wrangler d1 execute ecs-drive-db --remote --command \
  "UPDATE folders SET password_hash = '<paste-hash-here>' WHERE id = '<folder-id>';"
```

Same identity-verification caveat as token reissuance above.

### The Google Drive connection stops working

Symptoms: folder creation, uploads, or downloads start failing with a
generic "a connected service is unavailable" message (the API's
`upstream_error` — see `backend/src/errors.js`).

**Check this first, before anything else**: if this started roughly
7 days after the refresh token was first generated, the OAuth consent
screen was very likely left in "Testing" publishing status — Google
silently expires refresh tokens issued under Testing after exactly 7
days. This is a well-known, extremely common cause of exactly this
symptom. Fix: Cloud Console → OAuth consent screen → Publish App (set
to "In production"), then redo `backend/README.md` > "Google Drive
setup" steps 4–6 to generate a *new* refresh token — a token generated
before the switch doesn't retroactively become long-lived.

If that's not it, the credential may have been revoked another way
(the connected account's security settings, or the OAuth app removed
from "third-party access"). Same fix either way: re-run the OAuth
Playground flow in `backend/README.md`, then
`wrangler secret put GOOGLE_REFRESH_TOKEN` with the new value. No
student data is affected by this — the files themselves never leave
Drive; only the credential used to reach them needs replacing.

### A folder or file was deleted by mistake

Deletes are soft in two places, which is what makes this recoverable:
the D1 row is marked `status = 'deleted'` (so it disappears from
listings) and the Drive folder/file is moved to **Drive's trash**, not
permanently erased.

1. First, check it's still recoverable in Drive's own trash
   (drive.google.com, in the trash view) — Google controls how long
   trashed items are kept there, and that policy is outside this
   project's control, so don't wait to check.
2. Restore it in Drive if needed.
3. Flip the D1 row back:
   ```bash
   npx wrangler d1 execute ecs-drive-db --remote --command \
     "UPDATE folders SET status = 'active' WHERE id = '<folder-id>';"
   # or, for a single file:
   npx wrangler d1 execute ecs-drive-db --remote --command \
     "UPDATE files SET status = 'active' WHERE id = '<file-id>';"
   ```

Do step 2 before step 3 — you want the Drive-side file and the D1 row to
agree again, not a D1 row pointing at something no longer there.

### Investigating suspicious activity

Every rate-limit hit, failed management-token check, denied protected-
folder view, and folder/file create/rename/delete/upload is logged to
`security_events` (see `backend/src/audit.js`) — append-only, never read
by the API itself, purely for you to inspect:

```bash
npx wrangler d1 execute ecs-drive-db --remote --command \
  "SELECT event_type, folder_id, client_ip, detail, created_at
   FROM security_events ORDER BY created_at DESC LIMIT 50;"
```

**Known gap, not a fix**: the unlock rate limit (Phase 4/7) is keyed per
folder *and* IP — so a distributed attempt to guess one folder's
password from many different IPs isn't stopped by it. If
`security_events` shows a pattern like that on one folder, the practical
mitigation today is the password-reset procedure above (change the
password out from under the attempt), not anything automatic.

### `security_events` growing large

It's append-only with no automatic cleanup. D1's 5 GB storage cap (see
below) is far away at this project's scale, but if it's ever worth
trimming:

```bash
npx wrangler d1 execute ecs-drive-db --remote --command \
  "DELETE FROM security_events WHERE created_at < datetime('now', '-90 days');"
```

### Abandoned upload sessions

Most clean themselves up: starting a new upload in a folder
opportunistically reclaims that folder's own sessions older than 24
hours (see `reclaimStaleUploadSessions` in `src/db.js`) and cancels them
on Drive's side too. The gap: a folder nobody uploads to again after an
abandoned upload never triggers that cleanup. Harmless (a handful of
small rows, and Google auto-expires the Drive-side incomplete session
after about a week regardless), but if it's ever worth clearing manually:

```bash
npx wrangler d1 execute ecs-drive-db --remote --command \
  "SELECT id, folder_id, original_name, created_at FROM upload_sessions WHERE status = 'active' AND created_at < datetime('now', '-7 days');"
# then, after confirming those are genuinely abandoned:
npx wrangler d1 execute ecs-drive-db --remote --command \
  "UPDATE upload_sessions SET status = 'aborted' WHERE status = 'active' AND created_at < datetime('now', '-7 days');"
```

## Free-tier limitations

Numbers below were checked against Cloudflare's current documentation in
September 2026 — re-verify if it's been a while, since these do change
(see the note below about one that just did).

| | Free tier limit |
|---|---|
| Workers requests | 100,000/day |
| Workers CPU time | 10ms per request |
| Workers subrequests (external `fetch`, e.g. to Drive) | 50 per request |
| D1 storage | 5 GB total |
| D1 row reads | 5,000,000/day |
| D1 row writes | 100,000/day |
| Google Drive storage | whatever the connected account's own quota is (see `docs/Memory.md` for this project's original 400 GB / 320 GB planned figures) |

**As of September 1, 2026**, Cloudflare started actually *enforcing*
D1's free-tier daily read/write caps — queries now hard-fail past the
limit until the next UTC day, rather than continuing to work. If D1
requests start failing for no apparent reason, check whether the daily
cap was hit before assuming something's broken in the code — it'll
surface to a student as a generic `internal_error`, since the API layer
doesn't have a distinct error code for "the platform itself is
throttling us" (D1 throwing is treated like any other unexpected
failure by the global error handler).

At this project's intended scale (one college cohort, casual use),
these limits are generous. Two things worth periodically checking,
given how D1 write usage was found to be undercounted earlier in this
project's build:

- Phase 7's audit logging means a single API call can cost 2–3 D1
  writes instead of 1 (e.g. a failed unlock: one write to
  `rate_limits`, one to `security_events`).
- **Phase 12's chunked uploads cost meaningfully more than that per
  large file** — each chunk PUT that isn't the final one writes a
  progress update to `upload_sessions`, on top of the session's own
  insert/completion writes. At the 8 MiB chunk size this project uses,
  a file near the full 1 GB quota is roughly 128 chunks, so **one large
  upload can cost on the order of 130 D1 writes**, not 1–3. Still
  comfortable at this project's scale (even a very active day of large
  uploads stays a small fraction of the 100,000/day cap), but this is
  the number to actually check — via Cloudflare's dashboard, not
  estimated from memory — if usage ever grows well past "one class's
  worth of students."

GitHub Pages (frontend hosting) and Google Drive (file storage) don't
have Cloudflare-style hard numeric caps that are as actively enforced or
changing — GitHub Pages has long-standing soft guidelines around total
site size and bandwidth, and Drive storage is simply whatever the
connected Google account's own plan provides. Neither was re-verified
against current documentation in this pass; if either becomes a
practical concern, check GitHub's and Google's current published limits
directly rather than trusting a number written here, since neither was
checked as carefully as the Cloudflare numbers above.
