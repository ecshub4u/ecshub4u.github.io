# ECS Drive — Project Requirements Document

## 1. Project Overview
ECS Drive is a public college file-storage and sharing portal for approximately 320 students. It will allow students to create folders, upload files, browse other students' folders, and optionally protect their own folders with a password.

## 2. Goals
- Provide a simple, mobile-friendly file portal.
- Avoid traditional student login/signup.
- Store uploaded files in the project owner's Google Drive.
- Give each student a 1 GB total storage quota.
- Allow public browsing of folders unless a folder is password-protected.
- Keep Google Drive credentials and privileged operations server-side.
- Start with a zero-cost/free-tier deployment where practical.

## 3. Target Users
- College students (~320).
- One project administrator/owner.

## 4. Core Features
### Public
- View folder list.
- Search folders/files.
- Open public folders.
- Enter password for protected folders.
- Download permitted files.

### Folder Management
- Create a folder.
- Set optional folder password during creation.
- Generate a secret management link/token for the folder creator.
- Rename/delete/manage a folder only through its management credential.
- Create subfolders if enabled.

### File Management
- Upload files.
- List files with name, type, size, and date.
- Download files.
- Delete/rename files only with management authorization.
- No artificial per-file size limit; enforce only unavoidable platform/API limits.
- Enforce 1 GB aggregate quota per top-level student folder.

### Security
- Never expose Google Drive credentials in frontend code.
- Store passwords only as secure salted hashes.
- Rate-limit password attempts.
- Validate filenames and paths.
- Prevent path traversal.
- Restrict dangerous/unsupported upload types if required by the backend.
- Use HTTPS.
- Do not trust client-side quota calculations; verify quota server-side.

## 5. Storage Model
- 320 students × 1 GB = 320 GB maximum planned student storage.
- Existing Google Drive capacity: 400 GB.
- Approximate buffer: 80 GB.
- Quota is aggregate per student/top-level folder, not per individual file.

## 6. Non-Goals
- No traditional account/login system in the MVP.
- No direct exposure of the owner's Google Drive.
- No promise of unlimited upload/download traffic.
- No bypassing Google Drive or hosting-provider limits.

## 7. Success Criteria
A student can create a folder, optionally protect it with a password, upload files up to their remaining 1 GB quota, and other students can browse public folders without logging in.
