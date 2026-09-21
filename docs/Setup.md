# Getting Started

For someone picking up this project for the first time — a new ECS
maintainer, or you, six months from now. For the deep reference on any
one piece, see `backend/README.md` (backend internals) or
`docs/Deployment.md` (going live). This page is the short path from
"just cloned the repo" to "have it running."

## What this project is, in one paragraph

A public file-storage portal for ECS students: no student accounts,
just a link to manage a folder you create. Files live in the project
owner's own Google Drive; a Cloudflare Worker + D1 database handles
folder metadata, passwords, and quota. See `docs/PRD.md` and
`docs/Architecture.md` for the full design reasoning.

## Prerequisites

- Node.js 22+ (needed for the backend's test suite, which uses
  `node:sqlite` — a Node 22 feature)
- A Cloudflare account (free) — for the backend
- A Google account whose Drive will hold the files — for Drive storage
- A GitHub account — for hosting the frontend and running CI

None of these need to be the same person/account long-term, but
whoever holds the Google account in step 3 below is the one whose Drive
storage this project uses.

## 1. Clone and look around

```bash
git clone <this-repo-url>
cd ecs-drive
```

Read `docs/Memory.md` first — it's the running project log: what's
built, what's been tested (and what hasn't), what decisions were made
and why, and what's left. It's more useful than reading every phase of
`docs/Phases.md` in order.

## 2. Run the frontend locally

No build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

It'll show a "can't reach the server" error until the backend (next
step) is also running — that's expected, not broken.

## 3. Run the backend locally

```bash
cd backend
npm install
npx wrangler login
npx wrangler d1 create ecs-drive-db   # paste the printed database_id into wrangler.toml
npm run db:migrate:local
npm run dev
```

This alone gets you `GET /api/health` responding and folder
creation/listing working — but folder creation will fail until Google
Drive is connected (next step), since every folder needs a real Drive
folder behind it.

## 4. Connect Google Drive

Full steps (OAuth Playground, obtaining a refresh token) are in
`backend/README.md` > "Google Drive setup" — it's a one-time process,
maybe 10 minutes. Once done, you'll have three secrets to set locally in
`backend/.dev.vars` (copy from `.dev.vars.example`) and a root Drive
folder ID to put in `wrangler.toml`.

## 5. Run the tests

```bash
cd backend
npm test
```

Should show all tests passing (crypto/password/validation/session/DB
logic, plus the full API integration suite against a real Hono app —
see `backend/README.md` > "Testing" for exactly what's covered and how).

## 6. Deploy

When ready to go live: `docs/Deployment.md` has the complete checklist —
GitHub Pages for the frontend, the Worker for the backend, production
secrets, and a post-deploy smoke test. There's also `docs/Operations.md`
for once it's live: what to do if a management token is lost, if the
Drive connection breaks, and the current free-tier ceilings to watch.

## If something's confusing

Check `docs/Memory.md`'s phase-by-phase log first — most non-obvious
decisions (why PBKDF2 instead of Argon2id, why public/protected folders
have different upload rules, why the frontend uses hash routing) are
explained there, with the reasoning that led to them, not just the
outcome.
