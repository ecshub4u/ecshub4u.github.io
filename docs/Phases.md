# ECS Drive — Development Phases

## Phase 0 — Planning
- Finalize requirements.
- Finalize architecture.
- Finalize design system.
- Set up GitHub repository.
- Add documentation files.

## Phase 1 — Frontend Shell
- Build ECS Drive landing/dashboard.
- Implement responsive layout.
- Add folder cards/list.
- Add search UI.
- Add create-folder modal/page.
- No real backend yet.

## Phase 2 — Backend Foundation
- Create API project.
- Add database connection.
- Add environment variables/secrets.
- Add health-check endpoint.
- Add structured error handling.

## Phase 3 — Folder System
- Create folder metadata.
- Create matching Google Drive folders.
- List folders.
- Open folder.
- Generate secret management token.
- Implement management authorization.

## Phase 4 — Password Protection
- Optional password on folder creation.
- Secure hashing.
- Unlock endpoint.
- Temporary unlock session/token.
- Rate limiting.
- Never expose password hashes.

## Phase 5 — File Upload/Download
- Google Drive integration.
- Upload flow.
- File metadata.
- Download flow.
- Delete/rename with management authorization.
- No custom per-file size cap.

## Phase 6 — Quota
- Calculate aggregate folder usage.
- Enforce 1 GB per top-level student folder.
- Reject uploads that would exceed quota.
- Handle concurrent uploads safely.
- Show usage meter.

## Phase 7 — Security Hardening
- Input validation.
- Rate limiting.
- Security headers.
- CORS configuration.
- Token rotation/revocation strategy.
- Audit/security events.
- Error sanitization.

## Phase 8 — UI Polish
- Match ECSHub-inspired visual language.
- Improve mobile experience.
- Empty states.
- Upload progress.
- Loading/error states.
- Accessibility.

## Phase 9 — Testing
- Functional tests.
- Security tests.
- Drive API failure tests.
- Quota tests.
- Mobile/browser tests.

## Phase 10 — Deployment
- GitHub Pages frontend.
- Free-tier backend/database if quotas are sufficient.
- Configure production secrets.
- Configure production API URL.
- Final smoke test.

## Phase 11 — Documentation
- Update Memory.md.
- Add setup instructions.
- Add admin recovery instructions.
- Document free-tier limitations.
