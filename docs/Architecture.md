# ECS Drive — Architecture

## 1. Recommended Stack
- Frontend: HTML5, CSS3, vanilla JavaScript (or a lightweight framework only if later justified).
- Static hosting: GitHub Pages.
- Backend: a free-tier serverless/edge backend suitable for secure API calls.
- Metadata database: free-tier relational/document database.
- File storage: owner's Google Drive via Google Drive API.
- Authentication model: no user accounts; folder management uses high-entropy secret management tokens.
- Password protection: server-side password hashing.

## 2. High-Level Flow

Browser
  -> HTTPS
  -> Frontend on GitHub Pages
  -> Backend API
  -> Metadata database
  -> Google Drive API
  -> Owner's Google Drive

## 3. Why a Backend Is Required
Google Drive credentials must never be placed in GitHub Pages JavaScript. The backend performs privileged Drive operations and returns only the minimum data required by the browser.

## 4. Suggested Data Model

### folders
- id
- parent_folder_id
- drive_folder_id
- name
- password_hash (nullable)
- management_token_hash
- created_at
- updated_at
- status

### files
- id
- folder_id
- drive_file_id
- original_name
- mime_type
- size_bytes
- created_at
- status

### rate_limits / security_events
- key
- event_type
- count
- window_start
- created_at

## 5. API Sketch
GET    /api/folders
POST   /api/folders
GET    /api/folders/:id
POST   /api/folders/:id/unlock
POST   /api/folders/:id/files
GET    /api/files/:id
DELETE /api/files/:id
PATCH  /api/folders/:id
DELETE /api/folders/:id

Management endpoints must require the secret management token. Public read endpoints must not reveal management credentials or password hashes.

## 6. Google Drive Structure

ECS Drive/
  Student Folder 001/
  Student Folder 002/
  ...
  Student Folder 320/

Each top-level student folder receives a 1 GB aggregate quota.

## 7. Upload Strategy
Because the user requested no artificial per-file limit, the backend should avoid imposing a custom per-file cap. However, the implementation must account for Google Drive API and hosting-provider upload/request limits. If direct-to-Drive/resumable uploads are used, the backend should authorize the upload and verify the final file size before accepting it into the quota.

## 8. Security Boundaries
- Frontend is untrusted.
- Backend is trusted for authorization and quota checks.
- Database stores hashes/metadata, not Google credentials.
- Google credentials live only in server-side secrets.
- Management tokens are shown once and stored hashed.
