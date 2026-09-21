# Deploying ECS Drive

This covers every item in `Phases.md`'s Phase 10 checklist: GitHub Pages
frontend, free-tier backend/database, production secrets, production API
URL, and a final smoke test.

**What this document is, and isn't:** these are exact, tested-as-far-as-
possible steps for *you* to run. Deploying requires a Cloudflare account,
a GitHub repository you control, and Google OAuth credentials — none of
which an assistant can act on directly. Nothing here has been run against
a real deployment; treat the commands as a precise checklist, not a log
of what already happened.

## 1. Is the free tier actually enough? (checked September 2026)

See `docs/Operations.md` > "Free-tier limitations" for the full numbers
and reasoning. Short version: yes, comfortably, at this project's
intended scale — the one D1 write-count nuance from Phase 7's audit
logging is worth a re-check if usage ever grows well past one cohort.

## 2. Production secrets

Set these once, directly via `wrangler` (not through CI — there's no
need to put long-lived Drive/OAuth credentials in GitHub Actions secrets
for a project this size):

```bash
cd backend
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put UNLOCK_SESSION_SECRET   # openssl rand -base64 32
```

See `backend/README.md` > "Google Drive setup" for how to obtain the
three Google values (one-time OAuth Playground flow).

Also set the two non-secret values in `wrangler.toml` for real:
- `GOOGLE_ROOT_FOLDER_ID` — the Drive folder ID that will hold every
  student folder.
- `ALLOWED_ORIGINS` — once you know your GitHub Pages URL (step 3), add
  it here, comma-separated with `http://localhost:8000` if you still
  want local dev to keep working: e.g.
  `ALLOWED_ORIGINS = "http://localhost:8000,https://<username>.github.io"`

## 3. Deploy the backend (Cloudflare Workers)

One-time setup (if not already done in Phase 2/3):

```bash
cd backend
npm install
npx wrangler login
npx wrangler d1 create ecs-drive-db   # paste the printed database_id into wrangler.toml
npm run db:migrate:remote             # safe to re-run any time -- CREATE TABLE IF NOT EXISTS
```

Deploy:

```bash
npm run deploy
```

This prints your Worker's URL, something like
`https://ecs-drive-api.<your-subdomain>.workers.dev`. **Copy this — it's
needed in step 4.**

### Automating this: `.github/workflows/deploy.yml`

This repo includes a GitHub Actions workflow that deploys the backend
(and frontend) on every push to `main`. It needs two repository secrets,
set once under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — create one at
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  using the "Edit Cloudflare Workers" template (needs Workers Scripts:Edit
  and D1:Edit permissions for the account).
- `CLOUDFLARE_ACCOUNT_ID` — found on the right sidebar of any page in the
  Cloudflare dashboard.

The production secrets from step 2 (`GOOGLE_CLIENT_ID`, etc.) are **not**
part of this workflow — they're set once, directly, and persist across
deploys; the workflow only pushes code, not secrets.

## 4. Configure the production API URL (frontend)

Open `index.html` and change the one line noted in its own comment:

```html
<script>
  window.ECS_DRIVE_API_BASE = "https://ecs-drive-api.<your-subdomain>.workers.dev";
</script>
```

Use the exact URL `wrangler deploy` printed in step 3 (or your custom
domain, if you set one up on the Worker).

## 5. Deploy the frontend (GitHub Pages)

**A naming collision to know about:** this repo already has a `docs/`
folder full of planning markdown (`PRD.md`, `Architecture.md`, etc.).
GitHub Pages' simple "Deploy from a branch" setting commonly points at a
`/docs` folder as the site source — which would try to publish those
planning docs as the website, not the actual frontend. This repo's
included workflow sidesteps that entirely by using **GitHub Actions to
build and publish the site**, which doesn't care what any folder in the
repo is named. Use that, not the branch/folder picker in Pages settings.

One-time setup: in the repo's **Settings → Pages**, set **Source** to
**"GitHub Actions"** (not "Deploy from a branch"). Nothing else to
configure there — the included workflow (`deploy.yml`) handles staging
only the frontend files (`index.html`, `css/`, `js/`) and publishing
them, leaving `backend/` and `docs/` out of the published site.

Pushing to `main` (or running the workflow manually) then publishes to
`https://<username>.github.io/<repo-name>/`.

## 6. Final smoke test

After both are deployed, run the included script against your real URLs:

```bash
cd backend
BASE_URL="https://ecs-drive-api.<your-subdomain>.workers.dev" ./scripts/smoke-test.sh
```

It checks: health endpoint reachable and reports a connected DB, folder
creation, listing, unlock rate limiting, and cleans up after itself
(deletes the test folder it creates). See `backend/scripts/smoke-test.sh`
for exactly what it does — it's a thin `curl` script, nothing hidden.

Then, in a real browser, open the deployed GitHub Pages URL and manually
confirm: the folder list loads (proves CORS + the production API URL are
both correct), creating a folder works end-to-end (proves the Drive
OAuth credentials are valid), and uploading/downloading a small file
works (proves the full Drive read/write path).

## Admin recovery

See `docs/Operations.md` — lost management tokens, password resets,
a broken Drive connection, accidental deletes, and investigating
`security_events`. That doc is the living operational reference;
this section intentionally doesn't duplicate it.
