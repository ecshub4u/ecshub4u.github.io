/**
 * ECS Drive -- Frontend (Phase 8: wired to the real backend API)
 *
 * Single-page app with hash-based routing:
 *   #                        -> dashboard (folder list)
 *   #/folder/:id             -> folder detail (files, upload, manage)
 *   #/folder/:id/p/<path>    -> the same, opened inside a sub-folder
 *                               (path is URL-encoded, e.g. calendar%2Fcss)
 *
 * Auth tokens live in the browser, never on a server:
 *   - management tokens (prove you own a folder) -> localStorage, so they
 *     survive across visits on this device.
 *   - unlock tokens (prove you entered a protected folder's password) ->
 *     sessionStorage, matching their short server-side lifetime (30 min).
 */

import { api, ApiError } from "./api.js";
import {
  joinPath,
  isInside,
  buildView,
  describeSkipped,
  itemsFromFileList,
  collectFromEntries,
  MAX_FILES_PER_DROP,
} from "./paths.js";

const GB = 1024 * 1024 * 1024;

// ---------- Storage helpers ----------
const mgmtKey = (id) => `ecsdrive:mgmt:${id}`;
const unlockKey = (id) => `ecsdrive:unlock:${id}`;

function getManagementToken(id) {
  return localStorage.getItem(mgmtKey(id));
}
function setManagementToken(id, token) {
  localStorage.setItem(mgmtKey(id), token);
}
function clearManagementToken(id) {
  localStorage.removeItem(mgmtKey(id));
}
function getUnlockToken(id) {
  return sessionStorage.getItem(unlockKey(id));
}
function setUnlockToken(id, token) {
  sessionStorage.setItem(unlockKey(id), token);
}

/** Whichever credential this browser already has for a folder, preferring
 * ownership (a management token can view/list a protected folder same as
 * an unlock token can -- see backend's assertFolderViewAccess). */
function accessFor(id) {
  const managementToken = getManagementToken(id);
  if (managementToken) return { managementToken };
  const unlockToken = getUnlockToken(id);
  if (unlockToken) return { unlockToken };
  return {};
}

// ---------- Formatting ----------
function formatBytes(bytes) {
  const gb = bytes / GB;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function quotaClass(usedBytes, quotaBytes) {
  const pct = usedBytes / quotaBytes;
  if (pct >= 0.99) return "is-full";
  if (pct >= 0.8) return "is-high";
  return "";
}
function escapeHtml(str) {
  // Also escapes quotes: file and folder names are user-supplied and get put
  // inside HTML attributes (data-*, aria-label), where a stray " would
  // otherwise let a crafted name inject its own attributes.
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Font Awesome icon class for a file, guessed from its extension --
 * purely cosmetic (falls back to a generic file icon), never affects
 * how the file is actually handled. */
function fileTypeIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = {
    pdf: "fa-file-pdf",
    doc: "fa-file-word", docx: "fa-file-word",
    ppt: "fa-file-powerpoint", pptx: "fa-file-powerpoint",
    xls: "fa-file-excel", xlsx: "fa-file-excel", csv: "fa-file-csv",
    zip: "fa-file-zipper", rar: "fa-file-zipper", "7z": "fa-file-zipper",
    png: "fa-file-image", jpg: "fa-file-image", jpeg: "fa-file-image", gif: "fa-file-image", webp: "fa-file-image", svg: "fa-file-image",
    mp4: "fa-file-video", mov: "fa-file-video", avi: "fa-file-video", mkv: "fa-file-video",
    mp3: "fa-file-audio", wav: "fa-file-audio",
    txt: "fa-file-lines", md: "fa-file-lines",
    js: "fa-file-code", ts: "fa-file-code", py: "fa-file-code", html: "fa-file-code", css: "fa-file-code", java: "fa-file-code", c: "fa-file-code", cpp: "fa-file-code", json: "fa-file-code",
  };
  return map[ext] || "fa-file";
}

// ---------- Elements ----------
const appShell = document.getElementById("app-shell");
const contentEmpty = document.getElementById("content-empty");
const folderView = document.getElementById("folder-view");
const breadcrumbCurrent = document.getElementById("breadcrumb-current");

const grid = document.getElementById("folder-grid");
const skeletonGrid = document.getElementById("folder-skeleton-grid");
const emptyState = document.getElementById("empty-state");
const emptyStateTitle = document.getElementById("empty-state-title");
const emptyStateBody = document.getElementById("empty-state-body");
const resultCount = document.getElementById("result-count");
const searchInput = document.getElementById("search-input");
const dashboardError = document.getElementById("dashboard-error");
const dashboardErrorMessage = document.getElementById("dashboard-error-message");
const dashboardRetry = document.getElementById("dashboard-retry");

const folderLoading = document.getElementById("folder-loading");
const folderErrorBanner = document.getElementById("folder-error");
const folderErrorMessage = document.getElementById("folder-error-message");
const folderRetry = document.getElementById("folder-retry");
const folderContent = document.getElementById("folder-content");
const folderTitle = document.getElementById("folder-title");
const folderLockPill = document.getElementById("folder-lock-pill");
const folderOwnerActions = document.getElementById("folder-owner-actions");
const folderQuotaFill = document.getElementById("folder-quota-fill");
const folderQuotaUsed = document.getElementById("folder-quota-used");
const folderQuotaPct = document.getElementById("folder-quota-pct");

const unlockPanel = document.getElementById("unlock-panel");
const inlineUnlockForm = document.getElementById("inline-unlock-form");
const inlineUnlockError = document.getElementById("inline-unlock-error");
const manageInsteadBtn = document.getElementById("manage-instead-btn");

const managePanel = document.getElementById("manage-panel");
const manageForm = document.getElementById("manage-form");
const manageError = document.getElementById("manage-error");
const manageBadge = document.getElementById("manage-badge");

const folderBody = document.getElementById("folder-body");
const uploadDropzone = document.getElementById("upload-dropzone");
const uploadDisabledHint = document.getElementById("upload-disabled-hint");
const fileInput = document.getElementById("file-input");
const folderInput = document.getElementById("folder-input");
const pathBar = document.getElementById("path-bar");
const uploadProgressList = document.getElementById("upload-progress-list");
const fileListLoading = document.getElementById("file-list-loading");
const fileList = document.getElementById("file-list");
const fileEmptyState = document.getElementById("file-empty-state");

const rotateTokenBtn = document.getElementById("rotate-token-btn");
const changePasswordBtn = document.getElementById("change-password-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const ownerLoginRow = document.getElementById("owner-login-row");
const ownerLoginBtn = document.getElementById("owner-login-btn");
const managePasswordMode = document.getElementById("manage-password-mode");
const manageTokenMode = document.getElementById("manage-token-mode");
const manageLoginForm = document.getElementById("manage-login-form");
const manageLoginError = document.getElementById("manage-login-error");
const forgotPasswordBtn = document.getElementById("forgot-password-btn");
const manageCancelBtn = document.getElementById("manage-cancel-btn");
const recoveryModal = document.getElementById("recovery-modal");
const recoveryForm = document.getElementById("recovery-form");
const recoveryError = document.getElementById("recovery-error");
const changePasswordModal = document.getElementById("change-password-modal");
const changePasswordForm = document.getElementById("change-password-form");
const changePasswordError = document.getElementById("change-password-error");
const renameFolderBtn = document.getElementById("rename-folder-btn");
const deleteFolderBtn = document.getElementById("delete-folder-btn");

const createModal = document.getElementById("create-modal");
const createForm = document.getElementById("create-form");
const createError = document.getElementById("create-error");
const protectToggle = document.getElementById("protect-toggle");
const passwordField = document.getElementById("password-field");

const tokenModal = document.getElementById("token-modal");
const tokenModalTitle = document.getElementById("token-modal-title");
const tokenModalMessage = document.getElementById("token-modal-message");
const tokenValueEl = document.getElementById("token-value");
const copyTokenBtn = document.getElementById("copy-token-btn");
const copyConfirmation = document.getElementById("copy-confirmation");
const tokenContinueBtn = document.getElementById("token-continue-btn");

const deleteFolderModal = document.getElementById("delete-folder-modal");
const cancelDeleteFolder = document.getElementById("cancel-delete-folder");
const confirmDeleteFolder = document.getElementById("confirm-delete-folder");

const toast = document.getElementById("toast");

// ---------- State ----------
let folderCache = []; // last-known folder list, for dashboard search filtering
let currentFolderId = null;
let currentFolder = null;
let currentFiles = [];
let currentPath = ""; // sub-folder being viewed inside the open folder ("" = top level)
let tokenModalOnContinue = null;

// ---------- Toast ----------
let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4200);
}

function messageFor(err) {
  if (err instanceof ApiError && err.code === "session_expired" && currentFolderId) {
    // Their manager session ended (30 days passed, or the password was
    // changed/reset on another device). Forget it and show the folder as a
    // visitor would see it, so the sign-in link is right there.
    clearManagementToken(currentFolderId);
    loadFolder(currentFolderId);
  }
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

// ---------- Modal helpers (with focus trap) ----------
let lastFocusedElement = null;

function focusableElements(container) {
  return [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.disabled && el.offsetParent !== null
  );
}

function trapFocusKeydown(e, modal) {
  if (e.key === "Escape") {
    hideModal(modal);
    return;
  }
  if (e.key !== "Tab") return;
  const focusable = focusableElements(modal);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

const modalKeyHandlers = new Map();

function showModal(modal) {
  lastFocusedElement = document.activeElement;
  modal.hidden = false;
  const handler = (e) => trapFocusKeydown(e, modal);
  modalKeyHandlers.set(modal, handler);
  document.addEventListener("keydown", handler);
  const focusable = focusableElements(modal);
  (focusable[0] || modal).focus();
}
function hideModal(modal) {
  modal.hidden = true;
  const handler = modalKeyHandlers.get(modal);
  if (handler) document.removeEventListener("keydown", handler);
  modalKeyHandlers.delete(modal);
  if (lastFocusedElement) lastFocusedElement.focus();
}
[createModal, tokenModal, deleteFolderModal, recoveryModal, changePasswordModal].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideModal(overlay);
  });
});

function showFormError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
function hideFormError(el) {
  el.hidden = true;
}

// ---------- Token reveal modal ----------
function openTokenModal({ title, message, token, onContinue }) {
  tokenModalTitle.textContent = title;
  tokenModalMessage.textContent = message;
  tokenValueEl.textContent = token;
  copyConfirmation.textContent = "";
  tokenModalOnContinue = onContinue || null;
  showModal(tokenModal);
}
copyTokenBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(tokenValueEl.textContent);
    copyConfirmation.textContent = "Copied!";
  } catch {
    copyConfirmation.textContent = "Couldn't copy automatically -- select the text and copy manually.";
  }
});
tokenContinueBtn.addEventListener("click", () => {
  hideModal(tokenModal);
  if (tokenModalOnContinue) tokenModalOnContinue();
});

// ================================================================
// DASHBOARD
// ================================================================

function folderCardHtml(folder) {
  const pct = Math.min(100, Math.round((folder.usedBytes / folder.quotaBytes) * 100));
  return `
    <div class="row-avatar${folder.protected ? " is-protected" : ""}">
      <i class="fa-solid ${folder.protected ? "fa-lock" : "fa-folder"}" aria-hidden="true"></i>
    </div>
    <div class="row-body">
      <span class="row-title">${escapeHtml(folder.name)}</span>
      <span class="row-sub">${folder.fileCount} file${folder.fileCount === 1 ? "" : "s"} · ${formatBytes(folder.usedBytes)} used</span>
      <div class="row-quota-track"><div class="row-quota-fill ${quotaClass(folder.usedBytes, folder.quotaBytes)}" style="width:${pct}%"></div></div>
    </div>
  `;
}

function renderFolders(list) {
  grid.innerHTML = "";
  emptyStateTitle.textContent = "No folders match your search";
  emptyStateBody.textContent = "Try a different name, or create a new folder of your own.";
  emptyState.hidden = list.length !== 0;
  resultCount.textContent = list.length ? `${list.length} folder${list.length === 1 ? "" : "s"}` : "";

  for (const folder of list) {
    const card = document.createElement("a");
    card.href = `#/folder/${folder.id}`;
    card.className = "folder-row" + (folder.id === currentFolderId ? " is-active" : "");
    card.setAttribute("aria-label", `Open ${folder.name}${folder.protected ? " (password protected)" : ""}`);
    card.innerHTML = folderCardHtml(folder);
    grid.appendChild(card);
  }
}

function applySearchFilter() {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = q ? folderCache.filter((f) => f.name.toLowerCase().includes(q)) : folderCache;
  renderFolders(filtered);
}
searchInput.addEventListener("input", applySearchFilter);

async function loadFolders() {
  dashboardError.hidden = true;
  skeletonGrid.hidden = false;
  grid.hidden = true;
  emptyState.hidden = true;
  resultCount.textContent = "";

  try {
    const data = await api.listFolders();
    folderCache = data.folders;
    grid.hidden = false;
    skeletonGrid.hidden = true;
    applySearchFilter();
  } catch (err) {
    skeletonGrid.hidden = true;
    grid.hidden = true;
    dashboardErrorMessage.textContent = messageFor(err);
    dashboardError.hidden = false;
  }
}
dashboardRetry.addEventListener("click", loadFolders);

// ================================================================
// FOLDER DETAIL
// ================================================================

function resetFolderView() {
  folderLoading.hidden = false;
  folderErrorBanner.hidden = true;
  folderContent.hidden = true;
  unlockPanel.hidden = true;
  managePanel.hidden = true;
  folderBody.hidden = true;
  hideFormError(inlineUnlockError);
  hideFormError(manageError);
  hideFormError(manageLoginError);
  inlineUnlockForm.reset();
  manageForm.reset();
  manageLoginForm.reset();
  uploadProgressList.innerHTML = "";
}

function renderFolderHeader(folder) {
  folderTitle.textContent = folder.name;
  breadcrumbCurrent.textContent = folder.name;
  folderLockPill.hidden = !folder.protected;

  const pct = Math.min(100, Math.round((folder.usedBytes / folder.quotaBytes) * 100));
  folderQuotaFill.style.width = `${pct}%`;
  folderQuotaFill.className = `quota-fill ${quotaClass(folder.usedBytes, folder.quotaBytes)}`;
  folderQuotaUsed.textContent = `${formatBytes(folder.usedBytes)} used`;
  folderQuotaPct.textContent = `${pct}% of 1 GB`;

  const isOwner = Boolean(getManagementToken(folder.id));
  const passwordMode = folder.managerMode === "password";
  folderOwnerActions.hidden = !isOwner;
  manageBadge.hidden = !isOwner;
  rotateTokenBtn.hidden = passwordMode; // only older, token-managed folders have a token
  changePasswordBtn.hidden = !passwordMode;
  signOutBtn.hidden = !passwordMode;
  // Visitors get a sign-in link -- except on a locked folder that hasn't
  // been unlocked, where the unlock panel already offers "I'm the owner".
  ownerLoginRow.hidden = isOwner || (folder.protected && !getUnlockToken(folder.id));
  manageInsteadBtn.textContent = passwordMode
    ? "I'm the owner — sign in as manager instead"
    : "I'm the owner — manage with my token instead";
}

function fileRowHtml(file, isOwner) {
  return `
    <div class="file-icon"><i class="fa-solid ${fileTypeIcon(file.name)}" aria-hidden="true"></i></div>
    <div class="file-row-main">
      <span class="file-name">${escapeHtml(file.name)}</span>
      <span class="file-meta">${formatBytes(file.sizeBytes)} · ${formatDate(file.createdAt)}</span>
    </div>
    <div class="file-row-actions">
      <button type="button" class="btn-text" data-action="download" data-file-id="${file.id}" data-file-name="${escapeHtml(file.name)}" title="Download" aria-label="Download ${escapeHtml(file.name)}"><i class="fa-solid fa-download" aria-hidden="true"></i></button>
      ${
        isOwner
          ? `<button type="button" class="btn-text" data-action="rename" data-file-id="${file.id}" title="Rename" aria-label="Rename ${escapeHtml(file.name)}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
             <button type="button" class="btn-text btn-text-danger" data-action="delete" data-file-id="${file.id}" title="Delete" aria-label="Delete ${escapeHtml(file.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`
          : ""
      }
    </div>
  `;
}

function dirRowHtml(dir, isOwner) {
  const count = `${dir.fileCount} ${dir.fileCount === 1 ? "file" : "files"}`;
  return `
    <button type="button" class="dir-open" data-action="open-dir" data-path="${escapeHtml(dir.path)}" aria-label="Open folder ${escapeHtml(dir.name)}">
      <span class="file-icon dir-icon"><i class="fa-solid fa-folder" aria-hidden="true"></i></span>
      <span class="file-row-main">
        <span class="file-name">${escapeHtml(dir.name)}</span>
        <span class="file-meta">${count} · ${formatBytes(dir.sizeBytes)}</span>
      </span>
    </button>
    <div class="file-row-actions">
      ${
        isOwner
          ? `<button type="button" class="btn-text btn-text-danger" data-action="delete-dir" data-path="${escapeHtml(dir.path)}" title="Delete folder" aria-label="Delete folder ${escapeHtml(dir.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`
          : ""
      }
    </div>
  `;
}

/** "Folder name › calendar › css" -- each part but the last is a link. */
function renderPathBar() {
  if (!currentPath) {
    pathBar.hidden = true;
    pathBar.innerHTML = "";
    return;
  }
  const segments = currentPath.split("/");
  let html = `<button type="button" class="path-crumb" data-path=""><i class="fa-solid fa-house" aria-hidden="true"></i> ${escapeHtml(currentFolder.name)}</button>`;
  let walked = "";
  segments.forEach((segment, i) => {
    walked = joinPath(walked, segment);
    html += `<span class="crumb-sep" aria-hidden="true">›</span>`;
    html +=
      i === segments.length - 1
        ? `<span class="path-crumb is-current" aria-current="page">${escapeHtml(segment)}</span>`
        : `<button type="button" class="path-crumb" data-path="${escapeHtml(walked)}">${escapeHtml(segment)}</button>`;
  });
  pathBar.innerHTML = html;
  pathBar.hidden = false;
}
pathBar.addEventListener("click", (e) => {
  const crumb = e.target.closest("button[data-path]");
  if (crumb) navigate(folderHash(currentFolderId, crumb.dataset.path));
});

function renderFileList() {
  const isOwner = Boolean(getManagementToken(currentFolderId));
  const view = buildView(currentFiles, currentPath);
  renderPathBar();
  fileList.innerHTML = "";
  fileEmptyState.hidden = view.folders.length + view.files.length !== 0;

  for (const dir of view.folders) {
    const li = document.createElement("li");
    li.className = "file-row dir-row";
    li.innerHTML = dirRowHtml(dir, isOwner);
    fileList.appendChild(li);
  }
  for (const file of view.files) {
    const li = document.createElement("li");
    li.className = "file-row";
    li.innerHTML = fileRowHtml(file, isOwner);
    fileList.appendChild(li);
  }
}

async function loadFiles() {
  fileListLoading.hidden = false;
  fileList.innerHTML = "";
  fileEmptyState.hidden = true;

  try {
    const data = await api.listFiles(currentFolderId, accessFor(currentFolderId));
    currentFiles = data.files;
    fileListLoading.hidden = true;
    renderFileList();
  } catch (err) {
    fileListLoading.hidden = true;
    showToast(messageFor(err));
  }
}

function updateUploadAvailability() {
  const isOwner = Boolean(getManagementToken(currentFolderId));
  const canUpload = !currentFolder.protected || isOwner;
  uploadDropzone.hidden = !canUpload;
  uploadDisabledHint.hidden = canUpload;
}

async function enterFolderBody() {
  folderBody.hidden = false;
  updateUploadAvailability();
  await loadFiles();
}

async function loadFolder(id) {
  currentFolderId = id;
  // Refresh the sidebar so the newly-opened folder's row highlights --
  // if the list hasn't loaded yet, loadFolders() will render it with the
  // right highlight once it resolves (currentFolderId is already set).
  if (folderCache.length === 0) loadFolders();
  else applySearchFilter();

  resetFolderView();

  try {
    currentFolder = await api.getFolder(id);
  } catch (err) {
    folderLoading.hidden = true;
    folderErrorMessage.textContent = messageFor(err);
    folderErrorBanner.hidden = false;
    return;
  }

  folderLoading.hidden = true;
  folderContent.hidden = false;
  renderFolderHeader(currentFolder);

  const hasAccess = !currentFolder.protected || getManagementToken(id) || getUnlockToken(id);
  if (hasAccess) {
    await enterFolderBody();
  } else {
    unlockPanel.hidden = false;
  }
}
folderRetry.addEventListener("click", () => loadFolder(currentFolderId));

// ---------- Inline unlock ----------
inlineUnlockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormError(inlineUnlockError);
  const password = document.getElementById("inline-unlock-password").value;
  const submitBtn = inlineUnlockForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const result = await api.unlockFolder(currentFolderId, password);
    setUnlockToken(currentFolderId, result.unlockToken);
    unlockPanel.hidden = true;
    renderFolderHeader(currentFolder);
    await enterFolderBody();
  } catch (err) {
    showFormError(inlineUnlockError, messageFor(err));
  } finally {
    submitBtn.disabled = false;
  }
});

function openManagePanel() {
  const passwordMode = currentFolder.managerMode === "password";
  unlockPanel.hidden = true;
  managePanel.hidden = false;
  managePasswordMode.hidden = !passwordMode;
  manageTokenMode.hidden = passwordMode;
  document.getElementById(passwordMode ? "manage-login-password" : "manage-token-input").focus();
}
manageInsteadBtn.addEventListener("click", openManagePanel);
ownerLoginBtn.addEventListener("click", openManagePanel);

manageCancelBtn.addEventListener("click", () => {
  managePanel.hidden = true;
  hideFormError(manageError);
  hideFormError(manageLoginError);
  const locked = currentFolder.protected && !getManagementToken(currentFolderId) && !getUnlockToken(currentFolderId);
  if (locked) unlockPanel.hidden = false;
});

// ---------- Manager password: sign in / forgot it / change it / sign out ----------

/** Store a manager session and show the folder as its manager. */
async function becomeManager(sessionToken) {
  setManagementToken(currentFolderId, sessionToken);
  managePanel.hidden = true;
  unlockPanel.hidden = true;
  renderFolderHeader(currentFolder);
  await enterFolderBody(); // re-reads the files, now with manager rights
}

manageLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormError(manageLoginError);
  const password = document.getElementById("manage-login-password").value;
  const submitBtn = manageLoginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const result = await api.manageLogin(currentFolderId, password);
    manageLoginForm.reset();
    await becomeManager(result.managementToken);
    showToast("Signed in as manager.");
  } catch (err) {
    showFormError(manageLoginError, messageFor(err));
  } finally {
    submitBtn.disabled = false;
  }
});

forgotPasswordBtn.addEventListener("click", async () => {
  hideFormError(manageLoginError);
  hideFormError(recoveryError);
  try {
    const { questions } = await api.getRecoveryQuestions(currentFolderId);
    recoveryForm.reset();
    document.getElementById("recovery-question-1").textContent = questions[0] || "Question 1";
    document.getElementById("recovery-question-2").textContent = questions[1] || "Question 2";
    showModal(recoveryModal);
  } catch (err) {
    showFormError(manageLoginError, messageFor(err));
  }
});
document.getElementById("cancel-recovery").addEventListener("click", () => hideModal(recoveryModal));
recoveryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormError(recoveryError);
  const submitBtn = recoveryForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const result = await api.resetManagerPassword(currentFolderId, {
      answers: [document.getElementById("recovery-answer-1").value, document.getElementById("recovery-answer-2").value],
      newPassword: document.getElementById("recovery-new-password").value,
    });
    recoveryForm.reset();
    hideModal(recoveryModal);
    await becomeManager(result.managementToken);
    showToast("New manager password set. You're signed in.");
  } catch (err) {
    showFormError(recoveryError, messageFor(err));
  } finally {
    submitBtn.disabled = false;
  }
});

changePasswordBtn.addEventListener("click", () => {
  changePasswordForm.reset();
  hideFormError(changePasswordError);
  showModal(changePasswordModal);
});
document.getElementById("cancel-change-password").addEventListener("click", () => hideModal(changePasswordModal));
changePasswordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormError(changePasswordError);
  const submitBtn = changePasswordForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const result = await api.changeManagerPassword(
      currentFolderId,
      {
        currentPassword: document.getElementById("current-manager-password").value,
        newPassword: document.getElementById("new-manager-password").value,
      },
      getManagementToken(currentFolderId)
    );
    setManagementToken(currentFolderId, result.managementToken);
    changePasswordForm.reset();
    hideModal(changePasswordModal);
    showToast("Manager password changed.");
  } catch (err) {
    if (err instanceof ApiError && err.code === "session_expired") hideModal(changePasswordModal);
    showFormError(changePasswordError, messageFor(err));
  } finally {
    submitBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => {
  clearManagementToken(currentFolderId);
  showToast("Signed out on this device.");
  loadFolder(currentFolderId);
});

// ---------- Paste-a-token (manage) ----------
manageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormError(manageError);
  const token = document.getElementById("manage-token-input").value.trim();
  const submitBtn = manageForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    // Validate by actually using it, rather than trusting it blindly --
    // a management token is also valid for viewing, so this doubles as
    // the first file-list fetch on success.
    const data = await api.listFiles(currentFolderId, { managementToken: token });
    setManagementToken(currentFolderId, token);
    currentFiles = data.files;
    managePanel.hidden = true;
    renderFolderHeader(currentFolder);
    await enterFolderBodyWithoutRefetch();
  } catch (err) {
    showFormError(manageError, err instanceof ApiError && err.status === 401 ? "Invalid management token." : messageFor(err));
  } finally {
    submitBtn.disabled = false;
  }
});

async function enterFolderBodyWithoutRefetch() {
  folderBody.hidden = false;
  fileListLoading.hidden = true;
  updateUploadAvailability();
  renderFileList();
}

// ---------- Upload ----------
function addProgressRow(fileName) {
  const row = document.createElement("div");
  row.className = "upload-progress-row";
  row.innerHTML = `
    <div class="upload-progress-info">
      <span class="upload-progress-name">${escapeHtml(fileName)}</span>
      <span class="upload-progress-pct">0%</span>
    </div>
    <div class="upload-progress-track"><div class="upload-progress-fill" style="width:0%"></div></div>
  `;
  uploadProgressList.appendChild(row);
  return {
    setPercent(pct) {
      row.querySelector(".upload-progress-fill").style.width = `${pct}%`;
      row.querySelector(".upload-progress-pct").textContent = `${pct}%`;
    },
    setError(message, label = "Failed") {
      row.classList.add("is-error");
      row.querySelector(".upload-progress-pct").textContent = label;
      const msg = document.createElement("p");
      msg.className = "upload-progress-error";
      msg.textContent = message;
      row.appendChild(msg);
    },
    remove() {
      row.remove();
    },
  };
}

// Files are sent a few at a time: fast enough for a whole project folder,
// gentle enough not to hammer the server. (The server's own per-connection
// upload limit is in backend/src/rateLimit.js.)
const UPLOAD_CONCURRENCY = 3;
// If the server says one of these, every other file would fail the same way,
// so stop instead of trying the rest.
const STOP_UPLOAD_STATUSES = new Set([401, 403, 413, 429]);

/**
 * Uploads a list of { file, dir } items into the folder that's open right
 * now. `dir` is the file's folder *inside what was dropped* ("" for loose
 * files, "calendar/css" for a file in a dropped folder); it's added on top
 * of the sub-folder the person is currently viewing.
 * One file gets its own progress bar; several share one overall bar.
 */
async function uploadItems(items, note = "") {
  if (items.length === 0) {
    showToast(note || "Nothing to upload.");
    return;
  }

  // Remember where this started: the person may open another folder
  // while the upload is still running.
  const folderId = currentFolderId;
  const basePath = currentPath;
  const managementToken = getManagementToken(folderId) || undefined;

  const single = items.length === 1;
  const progress = addProgressRow(single ? items[0].file.name : `Uploading ${items.length} files`);
  const fractions = new Array(items.length).fill(0);
  const showOverall = () =>
    progress.setPercent(Math.round((fractions.reduce((sum, f) => sum + f, 0) / items.length) * 100));

  let nextIndex = 0;
  let uploadedCount = 0;
  let stopped = false;
  const problems = [];

  async function worker() {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex++;
      const { file, dir } = items[index];
      try {
        const uploaded = await api.uploadFile(folderId, file, {
          managementToken,
          dirPath: joinPath(basePath, dir),
          onProgress: (fraction) => {
            fractions[index] = fraction;
            showOverall();
          },
        });
        fractions[index] = 1;
        showOverall();
        uploadedCount += 1;

        if (currentFolderId === folderId && currentFolder) {
          currentFiles = [uploaded, ...currentFiles];
          currentFolder.usedBytes += uploaded.sizeBytes;
          currentFolder.fileCount += 1;
          renderFileList();
          renderFolderHeader(currentFolder);
        }
      } catch (err) {
        fractions[index] = 1;
        showOverall();
        problems.push(`${joinPath(dir, file.name)}: ${messageFor(err)}`);
        if (err instanceof ApiError && STOP_UPLOAD_STATUSES.has(err.status)) stopped = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, worker));

  if (problems.length === 0) {
    progress.setPercent(100);
    setTimeout(() => progress.remove(), 600);
    const done = single ? `${items[0].file.name} uploaded.` : `${uploadedCount} files uploaded.`;
    showToast(note ? `${done} ${note}` : done);
    return;
  }

  const notTried = items.length - uploadedCount - problems.length;
  if (single) {
    progress.setError(problems[0].split(": ").slice(1).join(": "));
  } else {
    progress.setError(
      `${uploadedCount} of ${items.length} uploaded, ${problems.length} failed` +
        (notTried > 0 ? `, ${notTried} not tried` : "") +
        `. First problem -- ${problems[0]}`,
      "Some failed"
    );
    console.warn("Upload problems:", problems);
  }
}

/** Takes the result of itemsFromFileList / collectFromEntries and uploads it. */
async function startUploads({ items, skipped, tooMany }) {
  if (tooMany) {
    showToast(`That's more than ${MAX_FILES_PER_DROP} files. Upload it in smaller parts, or zip it first.`);
    return;
  }
  await uploadItems(items, describeSkipped(skipped));
}

fileInput.addEventListener("change", () => {
  const picked = Array.from(fileInput.files);
  fileInput.value = "";
  startUploads(itemsFromFileList(picked));
});
folderInput.addEventListener("change", () => {
  const picked = Array.from(folderInput.files);
  folderInput.value = "";
  startUploads(itemsFromFileList(picked));
});

["dragover", "dragenter"].forEach((evt) =>
  uploadDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadDropzone.classList.add("is-dragover");
  })
);
["dragleave", "dragend"].forEach((evt) =>
  uploadDropzone.addEventListener(evt, () => uploadDropzone.classList.remove("is-dragover"))
);
uploadDropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  uploadDropzone.classList.remove("is-dragover");

  // Everything from the drop must be read right now, before any "await":
  // the browser empties the dropped data as soon as this handler pauses.
  const entries = Array.from(e.dataTransfer.items || [])
    .map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  const plainFiles = Array.from(e.dataTransfer.files || []);

  try {
    // Dropped folders come through as "entries" (which keep their structure);
    // older browsers without that support fall back to the plain file list.
    startUploads(entries.length > 0 ? await collectFromEntries(entries) : itemsFromFileList(plainFiles));
  } catch (err) {
    console.error(err);
    showToast("Couldn't read what you dropped. Try again, or use the choose buttons.");
  }
});

// ---------- File row actions (download / rename / delete) ----------
fileList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const fileId = btn.dataset.fileId;
  const action = btn.dataset.action;

  if (action === "open-dir") {
    navigate(folderHash(currentFolderId, btn.dataset.path));
    return;
  }
  if (action === "delete-dir") {
    await deleteSubfolder(btn.dataset.path);
    return;
  }

  if (action === "download") {
    try {
      await api.downloadFile(fileId, btn.dataset.fileName, accessFor(currentFolderId));
    } catch (err) {
      showToast(messageFor(err));
    }
    return;
  }

  const managementToken = getManagementToken(currentFolderId);

  if (action === "rename") {
    const file = currentFiles.find((f) => f.id === fileId);
    const newName = window.prompt("Rename file to:", file?.name || "");
    if (!newName || newName === file?.name) return;
    try {
      const updated = await api.renameFile(fileId, newName, managementToken);
      currentFiles = currentFiles.map((f) => (f.id === fileId ? { ...f, name: updated.name } : f));
      renderFileList();
    } catch (err) {
      showToast(messageFor(err));
    }
    return;
  }

  if (action === "delete") {
    const file = currentFiles.find((f) => f.id === fileId);
    if (!window.confirm(`Delete "${file?.name}"? This can't be undone.`)) return;
    try {
      await api.deleteFile(fileId, managementToken);
      const deletedBytes = file?.sizeBytes || 0;
      currentFiles = currentFiles.filter((f) => f.id !== fileId);
      renderFileList();
      currentFolder.usedBytes = Math.max(0, currentFolder.usedBytes - deletedBytes);
      currentFolder.fileCount = Math.max(0, currentFolder.fileCount - 1);
      renderFolderHeader(currentFolder);
      showToast("File deleted.");
    } catch (err) {
      showToast(messageFor(err));
    }
  }
});

// ---------- Delete a sub-folder ----------
async function deleteSubfolder(path) {
  const folderId = currentFolderId;
  const name = path.split("/").pop();
  const count = currentFiles.filter((f) => isInside(f.path || "", path)).length;
  if (!window.confirm(`Delete the folder "${name}" and the ${count} file${count === 1 ? "" : "s"} inside it? This can't be undone.`)) {
    return;
  }

  const managementToken = getManagementToken(folderId);
  let failure = null;
  try {
    // The server removes a limited number of files per request; keep going
    // until none are left (or it stops making progress).
    for (;;) {
      const result = await api.deletePath(folderId, path, managementToken);
      if (result.remaining === 0 || result.deleted === 0) break;
    }
  } catch (err) {
    failure = err;
  }

  if (currentFolderId !== folderId) return; // moved elsewhere meanwhile
  try {
    // Re-read from the server so the list and the storage numbers are exact,
    // whether everything was deleted or it stopped part-way.
    const [files, folder] = await Promise.all([
      api.listFiles(folderId, accessFor(folderId)),
      api.getFolder(folderId),
    ]);
    currentFiles = files.files;
    currentFolder = folder;
    if (!currentFiles.some((f) => isInside(f.path || "", currentPath))) currentPath = ""; // nothing left here
    renderFolderHeader(currentFolder);
    renderFileList();
    if (!currentFiles.some((f) => isInside(f.path || "", path))) navigateBackIfInside(path);
  } catch (err) {
    showToast(messageFor(err));
    return;
  }
  showToast(failure ? messageFor(failure) : `Deleted "${name}".`);
}

/** If the person is standing inside a folder that was just deleted, step
 * out of it (to the top of the folder). */
function navigateBackIfInside(deletedPath) {
  if (isInside(currentPath, deletedPath)) navigate(folderHash(currentFolderId, ""));
}

// ---------- Rotate token / rename / delete folder ----------
renameFolderBtn.addEventListener("click", async () => {
  const newName = window.prompt("Rename folder to:", currentFolder.name);
  if (!newName || newName === currentFolder.name) return;
  const managementToken = getManagementToken(currentFolderId);
  try {
    const updated = await api.renameFolder(currentFolderId, newName, managementToken);
    currentFolder.name = updated.name;
    renderFolderHeader(currentFolder);
    const cached = folderCache.find((f) => f.id === currentFolderId);
    if (cached) cached.name = updated.name;
    showToast("Folder renamed.");
  } catch (err) {
    showToast(messageFor(err));
  }
});

rotateTokenBtn.addEventListener("click", async () => {
  const managementToken = getManagementToken(currentFolderId);
  try {
    const result = await api.rotateToken(currentFolderId, managementToken);
    setManagementToken(currentFolderId, result.managementToken);
    openTokenModal({
      title: "Token rotated",
      message: "Your old management token no longer works. Save this new one now -- it won't be shown again.",
      token: result.managementToken,
    });
  } catch (err) {
    showToast(messageFor(err));
  }
});

deleteFolderBtn.addEventListener("click", () => showModal(deleteFolderModal));
cancelDeleteFolder.addEventListener("click", () => hideModal(deleteFolderModal));
confirmDeleteFolder.addEventListener("click", async () => {
  const managementToken = getManagementToken(currentFolderId);
  confirmDeleteFolder.disabled = true;
  try {
    await api.deleteFolder(currentFolderId, managementToken);
    clearManagementToken(currentFolderId);
    folderCache = folderCache.filter((f) => f.id !== currentFolderId);
    hideModal(deleteFolderModal);
    showToast("Folder deleted.");
    navigate("");
  } catch (err) {
    showToast(messageFor(err));
  } finally {
    confirmDeleteFolder.disabled = false;
  }
});

// ================================================================
// CREATE FOLDER
// ================================================================

// Simple questions a student can answer years later. The last option lets
// them write their own -- often a better choice, since classmates may know
// the answers to the common ones.
const RECOVERY_QUESTIONS = [
  "What was the name of your first school?",
  "What was your childhood nickname?",
  "What is the name of your favourite teacher?",
  "What is the name of your best friend from school?",
  "What is the name of the village or town you grew up in?",
  "What was your first mobile phone?",
  "What is your favourite movie?",
  "What is your dream job?",
];
const CUSTOM_QUESTION = "__custom__";

function fillRecoverySelect(select) {
  select.innerHTML = "";
  for (const question of RECOVERY_QUESTIONS) select.add(new Option(question, question));
  select.add(new Option("Write my own question…", CUSTOM_QUESTION));
}
[1, 2].forEach((n) => {
  const select = document.getElementById(`recovery-q${n}`);
  const custom = document.getElementById(`recovery-q${n}-custom`);
  fillRecoverySelect(select);
  select.addEventListener("change", () => {
    custom.hidden = select.value !== CUSTOM_QUESTION;
    if (!custom.hidden) custom.focus();
  });
});

function resetRecoveryQuestions() {
  document.getElementById("recovery-q1").selectedIndex = 0;
  document.getElementById("recovery-q2").selectedIndex = 1; // a different one by default
  [1, 2].forEach((n) => (document.getElementById(`recovery-q${n}-custom`).hidden = true));
}
function chosenQuestion(n) {
  const select = document.getElementById(`recovery-q${n}`);
  return select.value === CUSTOM_QUESTION
    ? document.getElementById(`recovery-q${n}-custom`).value.trim()
    : select.value;
}

document.getElementById("open-create-folder").addEventListener("click", () => {
  createForm.reset();
  resetRecoveryQuestions();
  passwordField.hidden = true;
  hideFormError(createError);
  showModal(createModal);
});
document.getElementById("cancel-create").addEventListener("click", () => hideModal(createModal));
protectToggle.addEventListener("change", () => {
  passwordField.hidden = !protectToggle.checked;
});

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideFormError(createError);
  const name = document.getElementById("folder-name-input").value.trim();
  const wantsPassword = protectToggle.checked;
  const password = document.getElementById("folder-password-input").value;

  if (wantsPassword && !password) {
    return showFormError(createError, "Enter a password, or turn off folder protection.");
  }

  const managerPassword = document.getElementById("manager-password-input").value;
  if (managerPassword.length < 6) {
    return showFormError(createError, "The manager password needs at least 6 characters.");
  }
  if (wantsPassword && managerPassword === password) {
    return showFormError(createError, "The manager password must be different from the folder's viewing password.");
  }
  const recovery = [1, 2].map((n) => ({
    question: chosenQuestion(n),
    answer: document.getElementById(`recovery-a${n}`).value,
  }));
  if (recovery.some((r) => r.question.length < 5)) {
    return showFormError(createError, "Write out both recovery questions (at least 5 characters each).");
  }
  if (recovery[0].question.toLowerCase() === recovery[1].question.toLowerCase()) {
    return showFormError(createError, "Pick two different recovery questions.");
  }

  const submitBtn = createForm.querySelector('button[type="submit"]');
  const label = submitBtn.querySelector(".btn-label");
  submitBtn.disabled = true;
  label.textContent = "Creating…";

  try {
    const result = await api.createFolder({
      name,
      password: wantsPassword ? password : undefined,
      managerPassword,
      recovery,
    });
    // The server signs the creator in as manager right away; the browser
    // keeps that session quietly -- there is nothing for the person to copy.
    setManagementToken(result.id, result.managementToken);
    folderCache = [result, ...folderCache];
    hideModal(createModal);
    showToast("Folder created 🎉 Remember your manager password.");
    navigate(`#/folder/${result.id}`);
  } catch (err) {
    showFormError(createError, messageFor(err));
  } finally {
    submitBtn.disabled = false;
    label.textContent = "Create folder";
  }
});

// ================================================================
// ROUTING
// ================================================================

const FOLDER_ROUTE = /^#\/folder\/([^/]+)(?:\/p\/(.+))?$/;

/** The address for a folder, optionally opened inside a sub-folder. */
function folderHash(id, path = "") {
  return `#/folder/${encodeURIComponent(id)}${path ? `/p/${encodeURIComponent(path)}` : ""}`;
}

function navigate(hash) {
  if (location.hash === hash) {
    router();
  } else {
    location.hash = hash;
  }
}

document.querySelectorAll('[data-nav="dashboard"]').forEach((el) =>
  el.addEventListener("click", (e) => {
    e.preventDefault();
    navigate("");
  })
);

function router() {
  const match = location.hash.match(FOLDER_ROUTE);
  if (match) {
    // Mobile only (see the @media rule in styles.css) -- on desktop both
    // panels stay visible regardless of this class, matching ECSHub's
    // #app.chat-open pattern.
    appShell.classList.add("is-detail-open");
    contentEmpty.hidden = true;
    folderView.hidden = false;

    const id = decodeURIComponent(match[1]);
    const path = match[2] ? decodeURIComponent(match[2]) : "";
    currentPath = path;
    if (id === currentFolderId && currentFolder && !folderBody.hidden) {
      // Just moving between sub-folders of the folder that's already open:
      // nothing to reload, only the list to redraw.
      renderFileList();
    } else {
      loadFolder(id);
    }
  } else {
    appShell.classList.remove("is-detail-open");
    folderView.hidden = true;
    contentEmpty.hidden = false;
    currentFolderId = null; // clears the sidebar's active-row highlight below
    if (folderCache.length === 0) loadFolders();
    else applySearchFilter();
  }
}
window.addEventListener("hashchange", router);

// ---------- Init ----------
router();
