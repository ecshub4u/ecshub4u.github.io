# ECS Drive — AI Development Rules

## General
1. Build incrementally; do not rewrite working parts without a reason.
2. Keep the code understandable for a beginner.
3. Prefer stable, well-documented libraries.
4. Do not add dependencies unless they solve a real requirement.
5. Keep secrets out of source control.
6. Never commit `.env`, service-account keys, private keys, or tokens.

## Frontend
1. GitHub Pages must contain only public/client-safe code.
2. Never put Google Drive credentials or privileged API secrets in JavaScript.
3. Use accessible buttons, labels, focus states, and responsive layouts.
4. Do not rely on client-side security for authorization.

## Backend
1. Validate every request server-side.
2. Verify folder ownership/management token server-side.
3. Hash folder passwords using a modern password-hashing algorithm such as Argon2id or bcrypt.
4. Hash management tokens before storing them.
5. Use constant-time comparisons where appropriate.
6. Rate-limit password unlock attempts.
7. Validate and normalize filenames.
8. Prevent path traversal and injection attacks.
9. Enforce the 1 GB aggregate quota server-side.
10. Treat Google Drive API errors as untrusted external failures and handle them gracefully.

## Storage
1. Do not expose the owner's Google Drive account.
2. Do not use a user's Google access token as the project's permanent storage credential.
3. Use server-side Google Drive API credentials appropriate for the deployment architecture.
4. Never silently exceed the student's quota.
5. Never delete a Drive file until the application has verified the authorization.

## Errors
- Show friendly user-facing messages.
- Log technical details only server-side.
- Never expose secrets, stack traces, database errors, or API credentials.

## Testing
Before declaring a phase complete, test:
- public folder browsing
- protected folder unlock
- wrong-password rate limiting
- folder creation
- upload
- quota enforcement
- download
- management authorization
- malicious filename/path inputs
- expired/invalid management token
- Google API failure handling

## Design
Use ECSHub as visual inspiration only. Do not copy proprietary assets or source code. Preserve ECS Drive's own identity.
