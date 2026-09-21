import { Hono } from "hono";
import { getFileWithFolder, softDeleteFile, renameFile } from "../db.js";
import { downloadDriveFile, trashDriveFile, renameDriveFolder } from "../drive.js";
import { assertFolderViewAccess, assertManagementAccess } from "../auth.js";
import { validateFileName } from "../validate.js";
import { getClientIp } from "../rateLimit.js";
import { logSecurityEvent } from "../audit.js";
import { Errors } from "../errors.js";

export const files = new Hono();

function requireActiveFile(file) {
  if (!file || file.file_status !== "active" || file.folder_status !== "active") {
    throw Errors.notFound("File");
  }
}

function folderRefFrom(file) {
  // The pieces assertFolderViewAccess/assertManagementAccess need, pulled
  // out of the joined row from getFileWithFolder.
  return {
    id: file.folder_id,
    password_hash: file.password_hash,
    management_token_hash: file.management_token_hash,
    manager_version: file.manager_version,
  };
}

function contentDisposition(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /api/files/:id — streams the file's bytes straight from Drive
 * through the Worker (never a direct Drive link — that would mean either
 * exposing a Drive credential to the client or making the file public on
 * Drive itself, bypassing folder protection). Same view rules as browsing
 * the folder: open for public folders, unlock-token or management-token
 * gated for protected ones.
 */
files.get("/:id", async (c) => {
  const file = await getFileWithFolder(c, c.req.param("id"));
  requireActiveFile(file);
  await assertFolderViewAccess(c, folderRefFrom(file));

  const driveResponse = await downloadDriveFile(c.env, file.drive_file_id);

  const headers = new Headers({
    "Content-Type": file.mime_type || "application/octet-stream",
    "Content-Disposition": contentDisposition(file.original_name),
  });
  const length = driveResponse.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);

  return new Response(driveResponse.body, { headers });
});

/**
 * PATCH /api/files/:id — rename. Requires the folder's management token.
 * body: { name: string }
 * Reuses renameDriveFolder — Drive's `files.update` name change works
 * identically for files and folders, so no separate Drive helper is needed.
 */
files.patch("/:id", async (c) => {
  const file = await getFileWithFolder(c, c.req.param("id"));
  requireActiveFile(file);
  await assertManagementAccess(c, folderRefFrom(file));

  const body = await c.req.json().catch(() => ({}));
  const newName = validateFileName(body.name);

  await renameDriveFolder(c.env, file.drive_file_id, newName);
  await renameFile(c, file.id, newName);

  return c.json({ id: file.id, name: newName });
});

/**
 * DELETE /api/files/:id — always requires the folder's management token,
 * regardless of whether the folder is public or protected. Deleting is
 * destructive, so it stays owner-only even where uploading doesn't.
 */
files.delete("/:id", async (c) => {
  const file = await getFileWithFolder(c, c.req.param("id"));
  requireActiveFile(file);
  await assertManagementAccess(c, folderRefFrom(file));

  await trashDriveFile(c.env, file.drive_file_id);
  await softDeleteFile(c, file.id);
  await logSecurityEvent(c, "file_deleted", {
    folderId: file.folder_id,
    clientIp: getClientIp(c),
    detail: file.original_name,
  });

  return c.json({ deleted: true });
});
