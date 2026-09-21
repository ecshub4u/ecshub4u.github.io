/**
 * Helpers for sub-folders ("virtual paths") and for collecting the files
 * inside a dropped/picked folder.
 *
 * Sub-folders are virtual: every file just records the path it sits in
 * (e.g. "calendar/css"), and the file list shows those paths as folders.
 * Nothing in this file touches the page or the network, so all of it can be
 * tested on its own in Node (see backend/test/paths.test.js).
 */

/** A single drop or pick with more files than this is refused with a
 * friendly message -- a whole project folder can hide thousands of files
 * (dependencies, build output) that nobody meant to upload. */
export const MAX_FILES_PER_DROP = 500;

// Never worth uploading: operating-system clutter files ...
const IGNORED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
// ... and folders that are huge, auto-generated, and re-creatable.
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git"]);

// ---------- Path helpers ----------

/** joinPath("a", "b/c") -> "a/b/c";  joinPath("", "b") -> "b" */
export function joinPath(...parts) {
  return parts.filter(Boolean).join("/");
}

/** parentPath("a/b/c") -> "a/b";  parentPath("a") -> "" */
export function parentPath(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** True if `filePath` is `dirPath` itself or anywhere below it. */
export function isInside(filePath, dirPath) {
  if (!dirPath) return true;
  return filePath === dirPath || filePath.startsWith(`${dirPath}/`);
}

// ---------- What to show for one level ----------

/**
 * Splits a folder's flat file list into what to display at `currentPath`:
 *   folders -- the sub-folders directly below it (with file count + size,
 *              counting everything nested inside them)
 *   files   -- the files sitting directly at this level
 * `files` keeps the order it was given (newest first from the server).
 */
export function buildView(allFiles, currentPath) {
  const prefix = currentPath ? `${currentPath}/` : "";
  const folders = new Map();
  const files = [];

  for (const file of allFiles) {
    const filePath = file.path || "";
    if (filePath === currentPath) {
      files.push(file);
      continue;
    }
    if (prefix && !filePath.startsWith(prefix)) continue; // elsewhere in the tree

    const name = filePath.slice(prefix.length).split("/")[0];
    let entry = folders.get(name);
    if (!entry) {
      entry = { name, path: joinPath(currentPath, name), fileCount: 0, sizeBytes: 0 };
      folders.set(name, entry);
    }
    entry.fileCount += 1;
    entry.sizeBytes += Number(file.sizeBytes) || 0;
  }

  const sorted = [...folders.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
  return { folders: sorted, files };
}

// ---------- Collecting files from a drop / a folder picker ----------

function newResult() {
  return {
    items: [], // [{ file, dir }] -- dir is relative to where the user is now
    skipped: { empty: 0, junk: 0, dirs: [] },
    tooMany: false,
  };
}

/** Applies the skip rules and, if the file is fine, adds it to the result. */
function addItem(result, file, dir, maxFiles) {
  if (IGNORED_FILE_NAMES.has(file.name.toLowerCase())) {
    result.skipped.junk += 1;
    return;
  }
  const ignoredDir = dir.split("/").find((segment) => IGNORED_DIR_NAMES.has(segment.toLowerCase()));
  if (ignoredDir) {
    if (!result.skipped.dirs.includes(ignoredDir)) result.skipped.dirs.push(ignoredDir);
    return;
  }
  if (file.size === 0) {
    // The server refuses empty files, so don't even try.
    result.skipped.empty += 1;
    return;
  }
  if (result.items.length >= maxFiles) {
    result.tooMany = true;
    return;
  }
  result.items.push({ file, dir });
}

/** Turns the result's skip counts into one short sentence ("" if nothing). */
export function describeSkipped(skipped) {
  const parts = [];
  if (skipped.empty) parts.push(`${skipped.empty} empty file${skipped.empty === 1 ? "" : "s"}`);
  if (skipped.junk) parts.push(`${skipped.junk} system file${skipped.junk === 1 ? "" : "s"}`);
  for (const name of skipped.dirs) parts.push(`the "${name}" folder`);
  return parts.length ? `Skipped ${parts.join(", ")}.` : "";
}

/**
 * Files chosen with a file picker ("choose files" or "choose a folder").
 * A folder pick gives every file a webkitRelativePath like
 * "calendar/css/style.css" -- that's where each file's folder comes from.
 */
export function itemsFromFileList(fileList, { maxFiles = MAX_FILES_PER_DROP } = {}) {
  const result = newResult();
  for (const file of Array.from(fileList)) {
    const relative = file.webkitRelativePath || "";
    addItem(result, file, relative ? parentPath(relative) : "", maxFiles);
  }
  return result;
}

function readAllEntries(reader) {
  // A directory reader hands back its entries in batches (Chrome: 100 at a
  // time) and signals the end with an empty batch, so keep asking.
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        readBatch();
      }, reject);
    readBatch();
  });
}

async function walkEntry(entry, parentDir, result, maxFiles) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    addItem(result, file, parentDir, maxFiles);
    return;
  }
  if (entry.isDirectory) {
    if (IGNORED_DIR_NAMES.has(entry.name.toLowerCase())) {
      // Don't even walk into it -- it can hold thousands of files.
      if (!result.skipped.dirs.includes(entry.name)) result.skipped.dirs.push(entry.name);
      return;
    }
    const children = await readAllEntries(entry.createReader());
    for (const child of children) {
      if (result.tooMany) return;
      await walkEntry(child, joinPath(parentDir, entry.name), result, maxFiles);
    }
  }
}

/**
 * Files and folders dropped onto the page. `entries` are the results of
 * DataTransferItem.webkitGetAsEntry() (files or whole folders, folders may
 * contain folders). Returns the same shape as itemsFromFileList.
 */
export async function collectFromEntries(entries, { maxFiles = MAX_FILES_PER_DROP } = {}) {
  const result = newResult();
  for (const entry of entries) {
    if (result.tooMany) break;
    await walkEntry(entry, "", result, maxFiles);
  }
  return result;
}
