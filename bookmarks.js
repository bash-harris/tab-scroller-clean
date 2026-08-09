const sourceFolderEl = document.getElementById("sourceFolder");
const targetFolderEl = document.getElementById("targetFolder");
const filterInputEl = document.getElementById("filterInput");
const newFolderNameEl = document.getElementById("newFolderName");
const bookmarkListEl = document.getElementById("bookmarkList");
const countsEl = document.getElementById("counts");
const statusEl = document.getElementById("status");

const selectAllBtn = document.getElementById("selectAllBtn");
const clearSelectionBtn = document.getElementById("clearSelectionBtn");
const refreshBtn = document.getElementById("refreshBtn");
const moveBtn = document.getElementById("moveBtn");
const deleteBtn = document.getElementById("deleteBtn");

let folders = [];
let bookmarks = [];
let filterQuery = "";
let selectedIds = new Set();

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || {});
    });
  });
}

function setStatus(text, persist = false) {
  statusEl.textContent = text || "";
  if (!persist && text) {
    setTimeout(() => {
      if (statusEl.textContent === text) statusEl.textContent = "";
    }, 1800);
  }
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[ch]));
}

function folderLabel(folder) {
  const indent = "— ".repeat(Math.max(0, folder.depth));
  return `${indent}${folder.title}`;
}

function getFaviconMarkup(url, title) {
  try {
    const host = new URL(url).hostname;
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    return `<div class="favicon"><img src="${faviconUrl}" alt="" /></div>`;
  } catch {
    const fallback = escapeHtml((title || "?")[0]?.toUpperCase() || "?");
    return `<div class="favicon">${fallback}</div>`;
  }
}

function getFilteredBookmarks() {
  if (!filterQuery) return bookmarks;
  const q = filterQuery.toLowerCase();
  return bookmarks.filter((b) =>
    (b.title || "").toLowerCase().includes(q) ||
    (b.url || "").toLowerCase().includes(q)
  );
}

function updateCounts() {
  const visible = getFilteredBookmarks().length;
  countsEl.textContent = `${visible} shown • ${selectedIds.size} selected`;
}

function render() {
  const visible = getFilteredBookmarks();

  if (visible.length === 0) {
    bookmarkListEl.innerHTML = `<div class="empty">No bookmarks match this folder / filter.</div>`;
    updateCounts();
    return;
  }

  bookmarkListEl.innerHTML = visible.map((b) => {
    const checked = selectedIds.has(b.id) ? "checked" : "";
    const selectedClass = selectedIds.has(b.id) ? "selected" : "";

    return `
      <label class="bookmark-row ${selectedClass}" data-id="${b.id}">
        <input type="checkbox" class="row-check" data-id="${b.id}" ${checked} />
        ${getFaviconMarkup(b.url, b.title)}
        <div class="title-cell">
          <div class="name">${escapeHtml(b.title || "Untitled Bookmark")}</div>
          <div class="meta">ID: ${escapeHtml(b.id)}</div>
        </div>
        <div class="url-cell" title="${escapeHtml(b.url || "")}">${escapeHtml(b.url || "")}</div>
      </label>
    `;
  }).join("");

  updateCounts();
}

async function loadFolders() {
  const response = await sendMessage({ type: "GET_BOOKMARK_FOLDERS" });
  folders = response.folders || [];

  sourceFolderEl.innerHTML = folders
    .map((f) => `<option value="${f.id}">${escapeHtml(folderLabel(f))}</option>`)
    .join("");

  targetFolderEl.innerHTML = folders
    .map((f) => `<option value="${f.id}">${escapeHtml(folderLabel(f))}</option>`)
    .join("");

  const stored = await chrome.storage.local.get({
    bookmarkManagerSourceFolder: "",
    bookmarkManagerTargetFolder: ""
  });

  if (
    stored.bookmarkManagerSourceFolder &&
    folders.some((f) => f.id === stored.bookmarkManagerSourceFolder)
  ) {
    sourceFolderEl.value = stored.bookmarkManagerSourceFolder;
  }

  if (
    stored.bookmarkManagerTargetFolder &&
    folders.some((f) => f.id === stored.bookmarkManagerTargetFolder)
  ) {
    targetFolderEl.value = stored.bookmarkManagerTargetFolder;
  } else if (folders.length > 0) {
    targetFolderEl.value = folders[0].id;
  }
}

async function loadBookmarks() {
  const folderId = sourceFolderEl.value;

  if (!folderId) {
    bookmarks = [];
    selectedIds.clear();
    render();
    return;
  }

  setStatus("Loading...");

  const response = await sendMessage({
    type: "GET_BOOKMARKS_IN_FOLDER",
    folderId
  });

  bookmarks = (response.bookmarks || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  selectedIds = new Set(
    [...selectedIds].filter((id) => bookmarks.some((b) => b.id === id))
  );

  await chrome.storage.local.set({
    bookmarkManagerSourceFolder: sourceFolderEl.value,
    bookmarkManagerTargetFolder: targetFolderEl.value
  });

  render();
  setStatus(`${bookmarks.length} bookmarks loaded`);
}

function getSelectedBookmarkIds() {
  return Array.from(selectedIds);
}

async function moveSelected() {
  const bookmarkIds = getSelectedBookmarkIds();

  if (bookmarkIds.length === 0) {
    setStatus("Select at least one bookmark first");
    return;
  }

  let targetFolderId = targetFolderEl.value;
  const newFolderName = newFolderNameEl.value.trim();

  if (!targetFolderId) {
    setStatus("Choose a target folder");
    return;
  }

  moveBtn.disabled = true;
  deleteBtn.disabled = true;

  try {
    if (newFolderName) {
      setStatus("Creating folder...", true);

      const createRes = await sendMessage({
        type: "CREATE_BOOKMARK_FOLDER",
        parentId: targetFolderId,
        title: newFolderName
      });

      if (!createRes.ok || !createRes.folder?.id) {
        throw new Error(createRes.error || "Failed to create folder");
      }

      targetFolderId = createRes.folder.id;
      newFolderNameEl.value = "";

      await loadFolders();
      targetFolderEl.value = targetFolderId;
    }

    setStatus("Moving bookmarks...", true);

    const moveRes = await sendMessage({
      type: "MOVE_BOOKMARKS",
      bookmarkIds,
      targetFolderId
    });

    if (!moveRes.ok) {
      throw new Error(moveRes.error || "Move failed");
    }

    selectedIds.clear();
    await loadBookmarks();
    setStatus(`Moved ${bookmarkIds.length} bookmark${bookmarkIds.length === 1 ? "" : "s"}`);
  } catch (error) {
    setStatus(error.message || "Move failed", true);
  } finally {
    moveBtn.disabled = false;
    deleteBtn.disabled = false;
  }
}

async function deleteSelected() {
  const bookmarkIds = getSelectedBookmarkIds();

  if (bookmarkIds.length === 0) {
    setStatus("Select at least one bookmark first");
    return;
  }

  const confirmed = confirm(
    `Delete ${bookmarkIds.length} selected bookmark${bookmarkIds.length === 1 ? "" : "s"}?`
  );

  if (!confirmed) return;

  moveBtn.disabled = true;
  deleteBtn.disabled = true;

  try {
    setStatus("Deleting bookmarks...", true);

    const deleteRes = await sendMessage({
      type: "DELETE_BOOKMARKS",
      bookmarkIds
    });

    if (!deleteRes.ok) {
      throw new Error(deleteRes.error || "Delete failed");
    }

    selectedIds.clear();
    await loadBookmarks();
    setStatus(`Deleted ${bookmarkIds.length} bookmark${bookmarkIds.length === 1 ? "" : "s"}`);
  } catch (error) {
    setStatus(error.message || "Delete failed", true);
  } finally {
    moveBtn.disabled = false;
    deleteBtn.disabled = false;
  }
}

sourceFolderEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ bookmarkManagerSourceFolder: sourceFolderEl.value });
  selectedIds.clear();
  await loadBookmarks();
});

targetFolderEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ bookmarkManagerTargetFolder: targetFolderEl.value });
});

filterInputEl.addEventListener("input", () => {
  filterQuery = filterInputEl.value.trim().toLowerCase();
  render();
});

bookmarkListEl.addEventListener("change", (e) => {
  const checkbox = e.target.closest(".row-check");
  if (!checkbox) return;

  const id = checkbox.dataset.id;
  if (checkbox.checked) selectedIds.add(id);
  else selectedIds.delete(id);

  render();
});

bookmarkListEl.addEventListener("click", (e) => {
  const row = e.target.closest(".bookmark-row");
  if (!row || e.target.closest(".row-check")) return;

  const checkbox = row.querySelector(".row-check");
  checkbox.checked = !checkbox.checked;

  const id = checkbox.dataset.id;
  if (checkbox.checked) selectedIds.add(id);
  else selectedIds.delete(id);

  render();
});

selectAllBtn.addEventListener("click", () => {
  for (const b of getFilteredBookmarks()) {
    selectedIds.add(b.id);
  }
  render();
});

clearSelectionBtn.addEventListener("click", () => {
  selectedIds.clear();
  render();
});

refreshBtn.addEventListener("click", async () => {
  await loadFolders();
  await loadBookmarks();
});

moveBtn.addEventListener("click", moveSelected);
deleteBtn.addEventListener("click", deleteSelected);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    for (const b of getFilteredBookmarks()) {
      selectedIds.add(b.id);
    }
    render();
  }

  if (e.key === "Delete") {
    const active = document.activeElement;
    if (active !== filterInputEl && active !== newFolderNameEl) {
      deleteSelected();
    }
  }
});

(async function init() {
  await loadFolders();
  await loadBookmarks();
})();
