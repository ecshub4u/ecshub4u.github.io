# ECS Drive

A public file-storage and sharing portal for ~320 ECS students. No student
logins — folders are created with a secret management link, browsed
publicly unless password-protected, and files live in the project owner's
Google Drive behind a server-side API.

Full specs live in [`docs/`](docs): `PRD.md`, `Architecture.md`,
`Design.md`, `Rules.md`, `Phases.md`, `Memory.md` (the running project log —
read this first when picking work back up).

## Status

**All 12 phases are built, documented, and tested as far as this
environment allowed.** Phase 12 was an unplanned addition: an external
review correctly caught that the original file-upload implementation
(buffered whole-file, single request) silently contradicted the "no
artificial per-file limit" requirement — Cloudflare's free plan hard-caps
request bodies at 100 MB, at the platform edge, before a Worker even
runs. Uploads are now chunked via Google Drive's resumable upload
protocol, proxied through the Worker so Drive credentials never reach
the browser. See `docs/Memory.md`'s Phase 12 entry for the full design
and the rest of that audit (CORS, auth, rate limiting, quota races, Drive
failure cleanup).

Nothing has actually been deployed — that needs the owner's own
Cloudflare account, GitHub repo, and Google OAuth credentials, none of
which existed while this was built. `docs/Deployment.md` has the exact
remaining checklist; `docs/Setup.md` is the onboarding path for a new
maintainer; `docs/Operations.md` covers admin recovery and free-tier
limits once it's live.

Also still open: `backend/test/routes.test.js` (the ~25-test integration
suite) has never actually run — it needs `hono` installed, which this
environment couldn't reach over the network; the included CI workflow
will run it for real on the first push. 53 of 54 backend test files
*have* actually run and pass, including the new `drive.test.js`, which
verifies the resumable-upload logic itself with no Hono dependency. The
frontend has never been tested in a real browser either. See
`docs/Memory.md`'s "Current Status" section for the honest, current
summary — and its Implementation Log for the reasoning behind every
non-obvious decision along the way, including a notable trade-off from
Phase 4: folder passwords use PBKDF2 rather than Argon2id/bcrypt,
necessary to fit Cloudflare Workers' free-tier CPU budget (see
`backend/README.md` > "Why no bcrypt/argon2").

## Running it locally

Frontend (no build step):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Backend (Cloudflare Worker):

```bash
cd backend
npm install
npx wrangler dev
curl http://localhost:8787/api/health
```

See `backend/README.md` for D1 setup and the one-time Google Drive
authorization needed before folder creation will work.

## Structure

```
index.html            Dashboard + folder-detail views (hash routing)
css/styles.css          Design tokens + all styles
js/api.js                 Fetch/XHR wrapper for every backend endpoint
js/app.js                   Routing, rendering, all UI wiring
backend/                Cloudflare Worker API (Hono + D1 + Google Drive) — see backend/README.md
docs/                    Planning + operational docs, including Deployment.md
.github/workflows/       CI (backend-ci.yml) and deploy (deploy.yml)
```

## Documentation map

- [`docs/Setup.md`](docs/Setup.md) — start here if you're new to this project
- [`docs/Deployment.md`](docs/Deployment.md) — the checklist for going live
- [`docs/Operations.md`](docs/Operations.md) — admin recovery + free-tier limits, for once it's live
- [`docs/Memory.md`](docs/Memory.md) — the running project log: what's built, what's verified, why

## Next up

Actually deploying (see `docs/Deployment.md`), the real browser
click-through of the frontend that's been pending since Phase 8, and
running `backend/test/routes.test.js` for real via CI. After that, this
project is in the state described throughout `docs/Memory.md` — built
and internally consistent, but only as trustworthy as what's actually
been exercised for real, which this log is deliberately honest about
throughout.
