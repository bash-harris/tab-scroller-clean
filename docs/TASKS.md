# Tab Scroller v2 — Execution Plan

> **For kimi-k3:** Follow these 11 tasks in order. Each task has files, code, and verification steps. Do not skip tasks. Do not modify files outside the specified paths.

**Goal:** Rebuild Tab Scroller — premium tab strip UI, AI chat sidebar, smart grouping, session management, cross-browser export/import.

**Architecture:** Chrome MV3, vanilla JS, Shadow DOM, IndexedDB, Django backend (LLM + embeddings). No bundler, no framework.

**Tech:** Chrome Extension Manifest V3, Vanilla JS, Shadow DOM, IndexedDB, Django, Ollama (qwen2.5 + nomic-embed-text)

**Root:** `C:\Users\bkh\Desktop\tab-scroller-clean`

---

## File Structure After Rebuild

```
tab-scroller-clean/
├── manifest.json
├── content.css
├── src/
│   ├── background/
│   │   ├── background.js
│   │   └── executeTool.js (keep as-is)
│   ├── ui/
│   │   └── content.js
│   ├── services/
│   │   ├── TabService.js
│   │   ├── ChatService.js (keep as-is)
│   │   ├── EmbeddingService.js (keep as-is)
│   │   ├── SessionService.js (new)
│   │   └── retrieval/ (all files keep as-is)
│   ├── models/TabCard.js (keep)
│   └── storage/db.js (keep)
├── backend/ (unchanged)
├── tests/
└── icons/ (keep)
```

---

## Task 1: Delete Dead Code + Update Manifest

**Delete these root-level files:**
```
background.js
command-agent.js
content.js
db.js
embed.js
indexer.js
recall-tabs.js
session-memory.js
tab-cards.js
session-manager.js
session-manager.html
session-manager.css
bookmarks.js
bookmarks.html
options.js
options.html
content.css (root level)
```

**Replace `manifest.json` with:**
```json
{
  "manifest_version": 3,
  "name": "Tab Scroller",
  "version": "2.0.0",
  "description": "AI-powered tab management with smart grouping and session save/restore.",
  "permissions": ["tabs", "storage", "tabGroups", "activeTab", "scripting", "history", "bookmarks", "alarms"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "src/background/background.js"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "options_page": "src/ui/options.html",
  "action": {
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/ui/content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["content.css"],
      "matches": ["<all_urls>"]
    }
  ],
  "commands": {
    "open-ai-chat": {
      "suggested_key": {
        "default": "Ctrl+Shift+G",
        "mac": "Command+Shift+G"
      },
      "description": "Open AI Chat Sidebar"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**Verify:**
```bash
cd C:\Users\bkh\Desktop\tab-scroller-clean
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('Valid JSON')"
```
Expected: `Valid JSON`

---

## Task 2: Create `content.css`

Create `content.css` in the project root (same level as `manifest.json`):

```css
/* Tab Strip Container */
.ts-strip {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: 10000;
  transition: height 0.25s ease-out;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.ts-strip:hover, .ts-strip.pinned { height: 42px; }

.ts-strip-inner {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 8px;
  gap: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.2) transparent;
}
.ts-strip-inner::-webkit-scrollbar { height: 4px; }
.ts-strip-inner::-webkit-scrollbar-track { background: transparent; }
.ts-strip-inner::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }

.ts-controls-left {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0;
  padding-right: 8px; border-right: 1px solid rgba(255,255,255,0.1); margin-right: 4px;
}
.ts-ctrl-btn {
  width: 28px; height: 28px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 14px; color: rgba(255,255,255,0.6);
  transition: all 0.15s ease; background: transparent; border: none; flex-shrink: 0;
}
.ts-ctrl-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.9); }

.ts-controls-right {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0;
  padding-left: 8px; border-left: 1px solid rgba(255,255,255,0.1); margin-left: 4px;
}

.ts-tab {
  display: flex; align-items: center; height: 30px; padding: 0 10px;
  border-radius: 6px; cursor: pointer; flex-shrink: 0;
  max-width: 180px; min-width: 40px; transition: background 0.1s ease;
  position: relative; gap: 6px;
}
.ts-tab:hover { background: rgba(255,255,255,0.08); }
.ts-tab.active { background: rgba(255,255,255,0.12); }
.ts-tab.dragging { opacity: 0.4; }
.ts-tab.drag-over { border-left: 2px solid #0078d7; }

.ts-tab-favicon { width: 16px; height: 16px; border-radius: 2px; flex-shrink: 0; object-fit: contain; }
.ts-tab-favicon-fallback {
  width: 16px; height: 16px; border-radius: 2px; flex-shrink: 0;
  background: rgba(255,255,255,0.15); display: flex; align-items: center;
  justify-content: center; font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.7);
}
.ts-tab-title {
  font-size: 12px; color: rgba(255,255,255,0.85); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; line-height: 1.2;
}
.ts-tab-close {
  width: 18px; height: 18px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: rgba(255,255,255,0.4); cursor: pointer;
  opacity: 0; transition: all 0.1s ease; flex-shrink: 0;
}
.ts-tab:hover .ts-tab-close { opacity: 1; }
.ts-tab-close:hover { background: rgba(255, 77, 77, 0.8); color: #fff; }

.ts-group-label {
  display: flex; align-items: center; padding: 0 8px; height: 30px;
  font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.5);
  text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0;
  cursor: pointer; border-radius: 4px; gap: 4px;
}
.ts-group-label:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
.ts-group-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

.ts-tab-pinned { font-size: 10px; color: rgba(255, 200, 0, 0.8); }
.ts-tab-muted { font-size: 10px; color: rgba(255, 100, 100, 0.6); }
.ts-tab-loading {
  width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.2);
  border-top-color: #0078d7; border-radius: 50%;
  animation: ts-spin 0.8s linear infinite;
}
@keyframes ts-spin { to { transform: rotate(360deg); } }

.ts-search-bar {
  position: absolute; top: 100%; right: 40px;
  background: rgba(30, 30, 30, 0.95); backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
  padding: 8px 12px; display: none; z-index: 10001;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4); width: 300px;
}
.ts-search-bar.visible { display: flex; align-items: center; gap: 8px; }
.ts-search-bar input { flex: 1; background: transparent; border: none; color: #fff; font-size: 13px; outline: none; }
.ts-search-bar input::placeholder { color: rgba(255,255,255,0.3); }

.ts-context-menu {
  position: fixed; background: rgba(30,30,30,0.95); backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 4px;
  z-index: 10003; box-shadow: 0 8px 32px rgba(0,0,0,0.5); min-width: 180px;
}
.ts-context-item {
  padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 13px;
  color: rgba(255,255,255,0.85); display: flex; align-items: center; gap: 8px;
}
.ts-context-item:hover { background: rgba(255,255,255,0.08); }
.ts-context-item.danger { color: #ff6b6b; }
.ts-context-separator { height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0; }

.ts-toast {
  position: fixed; bottom: 24px; left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: rgba(30,30,30,0.95); backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
  padding: 10px 20px; color: #fff; font-size: 13px; z-index: 10004;
  opacity: 0; transition: all 0.3s ease; pointer-events: none;
}
.ts-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
.ts-toast.success { border-left: 3px solid #4caf50; }
.ts-toast.error { border-left: 3px solid #f44336; }
.ts-toast.warning { border-left: 3px solid #ff9800; }
.ts-toast.info { border-left: 3px solid #2196f3; }
```

**Verify:** `wc -l content.css` — should be ~120+ lines.

---

## Task 3: Rewrite `src/ui/content.js`

Replace the entire file with:

```javascript
// content.js — Tab Scroller v2: Tab Strip + AI Chat Sidebar
(function () {
  "use strict";

  if (document.getElementById("tab-scroller-host")) return;
  if (!chrome.runtime?.id) return;

  // === SHADOW DOM ===
  const host = document.createElement("div");
  host.id = "tab-scroller-host";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  fetch(chrome.runtime.getURL("content.css"))
    .then(r => r.text())
    .then(css => { style.textContent = css; });
  shadow.appendChild(style);

  // === STATE ===
  let tabs = [];
  let isPinned = false;
  let isSearchOpen = false;
  let contextMenu = null;
  let activeTabId = null;

  // === MESSAGING ===
  function sendMessage(msg, callback) {
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[TabScroller]', chrome.runtime.lastError.message);
          if (callback) callback(null);
          return;
        }
        if (callback) callback(resp);
      });
    } catch (e) {
      console.warn('[TabScroller] Send failed:', e.message);
    }
  }

  // === TAB STRIP ===
  const strip = document.createElement("div");
  strip.className = "ts-strip";
  strip.tabIndex = 0;

  const stripInner = document.createElement("div");
  stripInner.className = "ts-strip-inner";
  strip.appendChild(stripInner);

  // Controls - Left
  const controlsLeft = document.createElement("div");
  controlsLeft.className = "ts-controls-left";

  const centerBtn = document.createElement("button");
  centerBtn.className = "ts-ctrl-btn";
  centerBtn.title = "Center on active tab";
  centerBtn.textContent = "⊙";
  centerBtn.onclick = () => {
    const activeEl = stripInner.querySelector(".ts-tab.active");
    if (activeEl) activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  };
  controlsLeft.appendChild(centerBtn);

  const pinBtn = document.createElement("button");
  pinBtn.className = "ts-ctrl-btn";
  pinBtn.title = "Pin strip open";
  pinBtn.textContent = "📌";
  pinBtn.onclick = () => {
    isPinned = !isPinned;
    strip.classList.toggle("pinned", isPinned);
    pinBtn.style.color = isPinned ? "#ffc800" : "";
    chrome.storage.sync.set({ stripPinned: isPinned });
  };
  controlsLeft.appendChild(pinBtn);
  strip.appendChild(controlsLeft);

  // Controls - Right
  const controlsRight = document.createElement("div");
  controlsRight.className = "ts-controls-right";

  const undoBtn = document.createElement("button");
  undoBtn.className = "ts-ctrl-btn";
  undoBtn.title = "Undo last action";
  undoBtn.textContent = "↩️";
  undoBtn.style.display = "none";
  undoBtn.onclick = () => {
    sendMessage({ type: "UNDO_LAST_ACTION" }, (resp) => {
      if (resp?.success) showToast(resp.message, "success");
      else showToast(resp?.message || "Nothing to undo", "warning");
      undoBtn.style.display = "none";
    });
  };
  controlsRight.appendChild(undoBtn);

  const searchBtn = document.createElement("button");
  searchBtn.className = "ts-ctrl-btn";
  searchBtn.title = "Search tabs (Ctrl+F)";
  searchBtn.textContent = "🔍";
  searchBtn.onclick = () => toggleSearch();
  controlsRight.appendChild(searchBtn);

  const aiBtn = document.createElement("button");
  aiBtn.className = "ts-ctrl-btn";
  aiBtn.title = "AI Chat (Ctrl+Shift+G)";
  aiBtn.textContent = "🤖";
  aiBtn.onclick = () => toggleChatSidebar();
  controlsRight.appendChild(aiBtn);

  strip.appendChild(controlsRight);

  // === SEARCH ===
  const searchBar = document.createElement("div");
  searchBar.className = "ts-search-bar";
  const searchInput = document.createElement("input");
  searchInput.placeholder = "Search tabs...";
  searchInput.spellcheck = false;
  searchBar.appendChild(searchInput);
  shadow.appendChild(searchBar);

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    stripInner.querySelectorAll(".ts-tab").forEach(el => {
      const title = (el.dataset.title || "").toLowerCase();
      const url = (el.dataset.url || "").toLowerCase();
      const match = !q || title.includes(q) || url.includes(q);
      el.style.display = match ? "" : "none";
      el.style.opacity = match ? "1" : "0.3";
    });
  });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleSearch(); });

  function toggleSearch() {
    isSearchOpen = !isSearchOpen;
    searchBar.classList.toggle("visible", isSearchOpen);
    if (isSearchOpen) {
      searchInput.value = "";
      searchInput.focus();
      stripInner.querySelectorAll(".ts-tab").forEach(el => { el.style.display = ""; el.style.opacity = "1"; });
    }
  }

  // === RENDER TABS ===
  function render() {
    stripInner.innerHTML = "";
    const groups = new Map();
    const ungrouped = [];

    for (const tab of tabs) {
      if (tab.groupId && tab.groupId > 0) {
        if (!groups.has(tab.groupId)) groups.set(tab.groupId, []);
        groups.get(tab.groupId).push(tab);
      } else {
        ungrouped.push(tab);
      }
    }

    for (const tab of ungrouped) stripInner.appendChild(createTabElement(tab));

    for (const [groupId, groupTabs] of groups) {
      const firstTab = groupTabs[0];
      const groupLabel = document.createElement("div");
      groupLabel.className = "ts-group-label";
      const dot = document.createElement("span");
      dot.className = "ts-group-dot";
      dot.style.background = getGroupColor(firstTab.groupColor);
      groupLabel.appendChild(dot);
      const label = document.createElement("span");
      label.textContent = firstTab.groupTitle || "Group";
      groupLabel.appendChild(label);
      stripInner.appendChild(groupLabel);
      for (const tab of groupTabs) stripInner.appendChild(createTabElement(tab));
    }
  }

  function createTabElement(tab) {
    const el = document.createElement("div");
    el.className = "ts-tab" + (tab.active ? " active" : "");
    el.dataset.tabId = tab.id;
    el.dataset.title = tab.title || "";
    el.dataset.url = tab.url || "";
    el.draggable = true;

    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.className = "ts-tab-favicon";
      img.src = tab.favIconUrl;
      img.onerror = () => img.replaceWith(makeFallbackIcon(tab));
      el.appendChild(img);
    } else {
      el.appendChild(makeFallbackIcon(tab));
    }

    const title = document.createElement("span");
    title.className = "ts-tab-title";
    title.textContent = tab.title || "Untitled";
    el.appendChild(title);

    if (tab.pinned) {
      const pin = document.createElement("span");
      pin.className = "ts-tab-pinned";
      pin.textContent = "📌";
      el.appendChild(pin);
    }
    if (tab.mutedInfo?.muted) {
      const mute = document.createElement("span");
      mute.className = "ts-tab-muted";
      mute.textContent = "🔇";
      el.appendChild(mute);
    }

    const close = document.createElement("div");
    close.className = "ts-tab-close";
    close.textContent = "×";
    close.onclick = (e) => {
      e.stopPropagation();
      sendMessage({ type: "CLOSE_TAB", tabId: tab.id }, () => {
        tabs = tabs.filter(t => t.id !== tab.id);
        render();
      });
    };
    el.appendChild(close);

    el.onclick = () => sendMessage({ type: "SWITCH_TAB", tabId: tab.id });

    el.onmousedown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        sendMessage({ type: "CLOSE_TAB", tabId: tab.id }, () => {
          tabs = tabs.filter(t => t.id !== tab.id);
          render();
        });
      }
    };

    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, tab);
    };

    el.ondragstart = (e) => { e.dataTransfer.setData("text/plain", tab.id); el.classList.add("dragging"); };
    el.ondragend = () => el.classList.remove("dragging");
    el.ondragover = (e) => { e.preventDefault(); el.classList.add("drag-over"); };
    el.ondragleave = () => el.classList.remove("drag-over");
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("drag-over");
      const fromId = parseInt(e.dataTransfer.getData("text/plain"));
      if (fromId && fromId !== tab.id) sendMessage({ type: "MOVE_TAB", fromId, toIndex: tab.index });
    };

    return el;
  }

  function makeFallbackIcon(tab) {
    const fb = document.createElement("div");
    fb.className = "ts-tab-favicon-fallback";
    fb.textContent = (tab.title || "?")[0].toUpperCase();
    return fb;
  }

  function getGroupColor(color) {
    const colors = {
      grey: "#5f6368", blue: "#1a73e8", red: "#ea4335",
      yellow: "#fbbc04", green: "#34a853", pink: "#e91e63",
      purple: "#9334e6", cyan: "#00bcd4", orange: "#ff9800"
    };
    return colors[color] || colors.blue;
  }

  // === CONTEXT MENU ===
  function showContextMenu(x, y, tab) {
    hideContextMenu();
    contextMenu = document.createElement("div");
    contextMenu.className = "ts-context-menu";

    const items = [
      { label: "Close tab", action: () => sendMessage({ type: "CLOSE_TAB", tabId: tab.id }) },
      { label: "Close other tabs", action: () => sendMessage({ type: "CLOSE_OTHER_TABS", tabId: tab.id }) },
      { label: "Close tabs to the right", action: () => sendMessage({ type: "CLOSE_TABS_RIGHT", tabId: tab.id }) },
      { sep: true },
      { label: tab.pinned ? "Unpin tab" : "Pin tab", action: () => sendMessage({ type: "TOGGLE_PIN", tabId: tab.id }) },
      { label: tab.mutedInfo?.muted ? "Unmute tab" : "Mute tab", action: () => sendMessage({ type: "TOGGLE_MUTE", tabId: tab.id }) },
      { sep: true },
      { label: "Bookmark tab", action: () => sendMessage({ type: "BOOKMARK_TAB", tabId: tab.id, title: tab.title, url: tab.url }) },
      { label: "Duplicate tab", action: () => sendMessage({ type: "DUPLICATE_TAB", tabId: tab.id }) },
    ];

    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "ts-context-separator";
        contextMenu.appendChild(sep);
      } else {
        const el = document.createElement("div");
        el.className = "ts-context-item" + (item.danger ? " danger" : "");
        el.textContent = item.label;
        el.onclick = () => { hideContextMenu(); item.action(); };
        contextMenu.appendChild(el);
      }
    }

    shadow.appendChild(contextMenu);
    contextMenu.style.left = x + "px";
    contextMenu.style.top = y + "px";
    setTimeout(() => { document.addEventListener("click", hideContextMenu, { once: true }); }, 0);
  }

  function hideContextMenu() {
    if (contextMenu) { contextMenu.remove(); contextMenu = null; }
  }

  // === TOAST ===
  function showToast(message, type = "info", duration = 3000) {
    const existing = shadow.querySelector(".ts-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `ts-toast ${type}`;
    toast.textContent = message;
    shadow.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    setTimeout(() => { toast.classList.remove("visible"); setTimeout(() => toast.remove(), 300); }, duration);
  }

  // === AI CHAT SIDEBAR ===
  let chatOpen = false;
  let chatSidebar = null;

  function toggleChatSidebar() {
    if (chatOpen) closeChatSidebar();
    else openChatSidebar();
  }

  function openChatSidebar() {
    if (chatSidebar) chatSidebar.remove();
    chatOpen = true;

    chatSidebar = document.createElement("div");
    chatSidebar.id = "ts-chat-sidebar";
    chatSidebar.style.cssText = `
      position: fixed; top: 0; right: 0; width: 380px; height: 100vh;
      background: rgba(22, 22, 26, 0.97); backdrop-filter: blur(16px);
      border-left: 1px solid rgba(255,255,255,0.08);
      z-index: 10002; display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff; box-shadow: -4px 0 24px rgba(0,0,0,0.4);
      transform: translateX(100%); transition: transform 0.25s ease;
    `;

    const header = document.createElement("div");
    header.style.cssText = "padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between;";
    const headerTitle = document.createElement("span");
    headerTitle.style.cssText = "font-size: 14px; font-weight: 600;";
    headerTitle.textContent = "Tab Scroller AI";
    header.appendChild(headerTitle);
    const closeChatBtn = document.createElement("button");
    closeChatBtn.textContent = "×";
    closeChatBtn.style.cssText = "background: none; border: none; color: rgba(255,255,255,0.6); font-size: 20px; cursor: pointer; padding: 0 4px;";
    closeChatBtn.onclick = closeChatSidebar;
    header.appendChild(closeChatBtn);
    chatSidebar.appendChild(header);

    const messagesArea = document.createElement("div");
    messagesArea.id = "ts-chat-messages";
    messagesArea.style.cssText = "flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px;";
    chatSidebar.appendChild(messagesArea);

    const quickActions = document.createElement("div");
    quickActions.style.cssText = "padding: 8px 16px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 6px; flex-wrap: wrap;";
    const quickBtns = [
      { label: "Group All", cmd: "group all tabs by domain" },
      { label: "Clean Up", cmd: "find and close duplicate tabs" },
      { label: "Save Session", cmd: "save current session" },
      { label: "Find Duplicates", cmd: "find duplicate tabs" },
    ];
    for (const qb of quickBtns) {
      const btn = document.createElement("button");
      btn.textContent = qb.label;
      btn.style.cssText = "padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: transparent; color: rgba(255,255,255,0.7); font-size: 11px; cursor: pointer; transition: all 0.15s;";
      btn.onmouseenter = () => { btn.style.background = "rgba(255,255,255,0.08)"; btn.style.color = "#fff"; };
      btn.onmouseleave = () => { btn.style.background = "transparent"; btn.style.color = "rgba(255,255,255,0.7)"; };
      btn.onclick = () => sendAICommand(qb.cmd);
      quickActions.appendChild(btn);
    }
    chatSidebar.appendChild(quickActions);

    const inputArea = document.createElement("div");
    inputArea.style.cssText = "padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 8px; align-items: center;";
    const chatInput = document.createElement("input");
    chatInput.id = "ts-chat-input";
    chatInput.placeholder = "Ask AI anything...";
    chatInput.spellcheck = false;
    chatInput.style.cssText = "flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px 12px; color: #fff; font-size: 13px; outline: none;";
    chatInput.onfocus = () => { chatInput.style.borderColor = "rgba(0,120,215,0.5)"; };
    chatInput.onblur = () => { chatInput.style.borderColor = "rgba(255,255,255,0.1)"; };
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = chatInput.value.trim();
        if (cmd) { sendAICommand(cmd); chatInput.value = ""; }
      }
    });
    inputArea.appendChild(chatInput);
    chatSidebar.appendChild(inputArea);

    shadow.appendChild(chatSidebar);
    requestAnimationFrame(() => { chatSidebar.style.transform = "translateX(0)"; chatInput.focus(); });

    addChatMessage("ai", "Hi! I can help you manage your tabs. Try commands like:\n• \"group all github tabs\"\n• \"close reddit tabs\"\n• \"save session\"\n• \"find duplicates\"");
  }

  function closeChatSidebar() {
    chatOpen = false;
    if (chatSidebar) {
      chatSidebar.style.transform = "translateX(100%)";
      setTimeout(() => { chatSidebar?.remove(); chatSidebar = null; }, 250);
    }
  }

  function addChatMessage(role, text) {
    const messagesArea = shadow.querySelector("#ts-chat-messages");
    if (!messagesArea) return;
    const msg = document.createElement("div");
    msg.style.cssText = role === "user"
      ? "align-self: flex-end; background: #0078d7; color: #fff; padding: 8px 12px; border-radius: 12px 12px 4px 12px; max-width: 85%; font-size: 13px; line-height: 1.4; white-space: pre-wrap;"
      : "align-self: flex-start; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); padding: 8px 12px; border-radius: 12px 12px 12px 4px; max-width: 85%; font-size: 13px; line-height: 1.4; white-space: pre-wrap;";
    msg.textContent = text;
    messagesArea.appendChild(msg);
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function addActionCard(data) {
    const messagesArea = shadow.querySelector("#ts-chat-messages");
    if (!messagesArea) return;
    const card = document.createElement("div");
    card.style.cssText = "align-self: flex-start; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 12px; max-width: 90%;";

    const title = document.createElement("div");
    title.style.cssText = "font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #0078d7;";
    title.textContent = data.title || "Action";
    card.appendChild(title);

    if (data.tabs && data.tabs.length > 0) {
      const tabList = document.createElement("div");
      tabList.style.cssText = "max-height: 200px; overflow-y: auto; margin-bottom: 8px;";
      for (const tab of data.tabs) {
        const tabItem = document.createElement("div");
        tabItem.style.cssText = "padding: 4px 0; font-size: 12px; color: rgba(255,255,255,0.7); display: flex; align-items: center; gap: 6px;";
        const dot = document.createElement("span");
        dot.style.cssText = "width: 6px; height: 6px; border-radius: 50%; background: #0078d7; flex-shrink: 0;";
        tabItem.appendChild(dot);
        const tabText = document.createElement("span");
        tabText.textContent = tab.title || tab.url || "Untitled";
        tabText.style.overflow = "hidden";
        tabText.style.textOverflow = "ellipsis";
        tabText.style.whiteSpace = "nowrap";
        tabItem.appendChild(tabText);
        tabList.appendChild(tabItem);
      }
      card.appendChild(tabList);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding: 6px 14px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: transparent; color: #fff; font-size: 12px; cursor: pointer;";
    cancelBtn.onclick = () => card.remove();
    btnRow.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = `Confirm (${data.tabs?.length || 0})`;
    confirmBtn.style.cssText = "padding: 6px 14px; border-radius: 6px; border: none; background: #0078d7; color: #fff; font-size: 12px; cursor: pointer;";
    confirmBtn.onclick = () => {
      sendMessage({ type: "EXECUTE_ACTION", action: data.action, args: data.args }, (resp) => {
        if (resp?.success) {
          addChatMessage("ai", resp.message || "Done!");
          showToast(resp.message, "success");
          refreshTabs();
        } else {
          addChatMessage("ai", "Error: " + (resp?.message || "Unknown error"));
        }
        card.remove();
      });
    };
    btnRow.appendChild(confirmBtn);
    card.appendChild(btnRow);
    messagesArea.appendChild(card);
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function sendAICommand(command) {
    addChatMessage("user", command);
    addChatMessage("ai", "⏳ Thinking...");
    sendMessage({ type: "AI_COMMAND", command }, (response) => {
      const messages = shadow.querySelectorAll("#ts-chat-messages > div");
      const lastAI = messages[messages.length - 1];
      if (lastAI && lastAI.textContent.includes("Thinking")) lastAI.remove();
      if (!response) { addChatMessage("ai", "Error: No response from background script"); return; }
      if (response.success) {
        addChatMessage("ai", response.message || "Done!");
        showToast(response.message, "success");
        refreshTabs();
      } else if (response.preview) {
        addActionCard(response.preview);
      } else {
        addChatMessage("ai", response.message || "Command failed");
      }
    });
  }

  // === KEYBOARD SHORTCUTS ===
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "G") { e.preventDefault(); toggleChatSidebar(); }
  });
  shadow.addEventListener("click", (e) => { if (!e.target.closest(".ts-context-menu")) hideContextMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && chatOpen) closeChatSidebar(); });

  // === INIT ===
  function init() {
    chrome.storage.sync.get(["stripPinned"], (items) => {
      if (items.stripPinned) { isPinned = true; strip.classList.add("pinned"); pinBtn.style.color = "#ffc800"; }
    });
    refreshTabs();
    (document.documentElement || document.head).appendChild(host);
  }

  function refreshTabs() {
    sendMessage({ type: "GET_TABS" }, (response) => {
      if (response?.tabs) { tabs = response.tabs; activeTabId = tabs.find(t => t.active)?.id; render(); }
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TABS_UPDATED") {
      tabs = msg.tabs;
      render();
    } else if (msg.type === "UNDO_AVAILABLE") {
      undoBtn.style.display = "";
      undoBtn.title = `Undo: ${msg.action}`;
      showToast(msg.message, "success", 5000);
      setTimeout(() => { undoBtn.style.display = "none"; }, 15000);
    } else if (msg.type === "TOAST") {
      showToast(msg.message, msg.toastType || "info");
    }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTabs(); });

  init();
})();
```

**Verify:** `wc -l src/ui/content.js` — should be ~450-500 lines.

---

## Task 4: Rewrite `src/background/background.js`

Replace the entire file with:

```javascript
// background.js — Tab Scroller v2: Message Router
importScripts(
  '../services/TabService.js',
  '../services/ChatService.js',
  '../services/SessionService.js',
  '../services/retrieval/QueryParser.js',
  '../services/retrieval/DomainRetriever.js',
  '../services/retrieval/TitleRetriever.js',
  '../services/retrieval/KeywordRetriever.js',
  '../services/retrieval/EmbeddingRetriever.js',
  '../services/retrieval/CandidateAggregator.js',
  '../services/retrieval/RankingEngine.js',
  '../services/retrieval/RetrievalService.js',
  './executeTool.js'
);

// === TAB CARD MODEL ===
class TabCard {
  constructor({ tabId, url, title, summary = '', embedding = [], keywords = [] }) {
    this.tabId = tabId;
    this.url = url;
    this.title = title;
    this.summary = summary;
    this.embedding = embedding;
    this.keywords = keywords.length > 0 ? keywords : extractKeywordsFromText(`${title || ''} ${url || ''}`);
    this.extractedAt = Date.now();
    this.lastIndexed = Date.now();
    this.contentHash = computeHash(`${title}\n${url}\n${summary}`);
    try { this.domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { this.domain = ''; }
  }
}

function extractKeywordsFromText(text) {
  if (!text) return [];
  const stopWords = new Set([
    'the','a','an','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might','shall','can',
    'need','dare','ought','used','to','of','in','for','on','with','at','by','from',
    'up','about','into','through','during','before','after','above','below','between',
    'out','off','over','under','again','further','then','once','here','there','when',
    'where','why','how','all','both','each','few','more','most','other','some','such',
    'no','nor','not','only','own','same','so','than','too','very','just','because',
    'as','until','while','but','and','or','if','this','that','these','those','it',
    'its','my','your','his','her','our','their','what','which','who','whom','http',
    'https','www','com','org','net','html','htm',
  ]);
  return [...new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
  )];
}

function computeHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const chr = str.charCodeAt(i); hash = ((hash << 5) - hash) + chr; hash |= 0; }
  return hash.toString(36);
}

// === INDEXEDDB ===
const TabDB = {
  _db: null, DB_NAME: 'TabScrollerDB', DB_VERSION: 2,
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this._db = request.result; resolve(); };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('tabCards')) db.createObjectStore('tabCards', { keyPath: 'tabId' });
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      };
    });
  },
  async storeTabCard(card) {
    const tx = this._db.transaction('tabCards', 'readwrite');
    tx.objectStore('tabCards').put(card);
    return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  },
  async getTabCard(tabId) {
    const tx = this._db.transaction('tabCards', 'readonly');
    const request = tx.objectStore('tabCards').get(tabId);
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); });
  },
  async deleteTabCard(tabId) {
    const tx = this._db.transaction('tabCards', 'readwrite');
    tx.objectStore('tabCards').delete(tabId);
    return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  },
  async getAllTabCards() {
    const tx = this._db.transaction('tabCards', 'readonly');
    const request = tx.objectStore('tabCards').getAll();
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  },
  cosineSimilarity(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  },
  async search({ queryEmbedding, topK = 10 } = {}) {
    const allCards = await this.getAllTabCards();
    const scored = allCards.filter(card => card.embedding && card.embedding.length > 0)
      .map(card => ({ ...card, similarity: this.cosineSimilarity(queryEmbedding, card.embedding) }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }
};

// === EMBEDDING SERVICE ===
const EmbeddingService = {
  async getEmbedding(text) {
    try {
      const response = await fetch('http://127.0.0.1:8000/api/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.embedding || [];
    } catch { return []; }
  }
};

// === TAB INDEXING ===
async function indexTab(tab) {
  if (!tab || !tab.url || tab.url.startsWith('chrome://')) return;
  try {
    const text = `${tab.title || ''} ${tab.url}`.trim();
    const keywords = extractKeywordsFromText(text);
    let embedding = [];
    try { embedding = await EmbeddingService.getEmbedding(text); } catch {}
    await TabDB.storeTabCard(new TabCard({ tabId: tab.id, url: tab.url, title: tab.title || '', summary: '', embedding, keywords }));
  } catch (err) { console.error('[Background] Failed to index tab:', tab.id, err); }
}

async function indexAllTabs(tabs) {
  const BATCH_SIZE = 10;
  for (let i = 0; i < tabs.length; i += BATCH_SIZE) {
    const batch = tabs.slice(i, i + BATCH_SIZE);
    const texts = batch.map(t => `${t.title || ''} ${t.url}`.trim());
    const results = await Promise.allSettled(texts.map(text => EmbeddingService.getEmbedding(text)));
    const embeddings = results.map(r => r.status === 'fulfilled' ? r.value : []);
    await Promise.all(batch.map((tab, j) => {
      if (!tab || !tab.url || tab.url.startsWith('chrome://')) return Promise.resolve();
      const text = `${tab.title || ''} ${tab.url}`.trim();
      const keywords = extractKeywordsFromText(text);
      return TabDB.storeTabCard(new TabCard({ tabId: tab.id, url: tab.url, title: tab.title || '', summary: '', embedding: embeddings[j] || [], keywords }));
    }));
  }
  console.log(`[Background] Indexed ${tabs.length} tabs`);
}

// === CLEANUP DETECTION ===
function findDuplicateTabs(tabs) {
  const urlMap = new Map();
  for (const tab of tabs) {
    if (!tab.url) continue;
    const normalized = tab.url.toLowerCase().replace(/\/+$/, '');
    if (!urlMap.has(normalized)) urlMap.set(normalized, []);
    urlMap.get(normalized).push(tab);
  }
  const duplicates = [];
  for (const [, group] of urlMap) { if (group.length > 1) duplicates.push(group); }
  return duplicates;
}

function findStaleTabs(tabs, daysThreshold = 7) {
  const cutoff = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);
  return tabs.filter(tab => {
    if (tab.pinned) return false;
    if (tab.active) return false;
    return false; // Will be enhanced with chrome.history API
  });
}

// === CHROME EVENT LISTENERS ===
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await TabDB.init();
    const currentTabs = await TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
    const currentTabIds = new Set(currentTabs.map(t => t.id));
    const allCards = await TabDB.getAllTabCards();
    for (const card of allCards) { if (!currentTabIds.has(card.tabId)) await TabDB.deleteTabCard(card.tabId); }
    await indexAllTabs(currentTabs);
  } catch (err) { console.error('[Background] Startup indexing failed:', err); }
});

chrome.tabs.onCreated.addListener((tab) => indexTab(tab));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (changeInfo.title || changeInfo.url) indexTab(tab); });
chrome.tabs.onRemoved.addListener((tabId) => { TabDB.deleteTabCard(tabId).catch(() => {}); });

// === UNDO SYSTEM ===
let lastAction = null;
function saveUndoState(action, data) {
  lastAction = { action, data, timestamp: Date.now() };
  setTimeout(() => { lastAction = null; }, 15000);
}

// === MESSAGE HANDLER ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  (async () => {
    try {
      switch (msg.type) {
        case "GET_TABS": {
          const windowId = sender.tab?.windowId || chrome.windows.WINDOW_ID_CURRENT;
          const tabs = await TabService.getAllTabs(windowId);
          sendResponse({ tabs });
          break;
        }
        case "SWITCH_TAB": { await TabService.focusTab(msg.tabId); sendResponse({ success: true }); break; }
        case "CLOSE_TAB": { await TabService.closeTabs([msg.tabId]); sendResponse({ success: true }); break; }
        case "CLOSE_OTHER_TABS": {
          const allTabs = await TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
          const otherIds = allTabs.filter(t => t.id !== msg.tabId && !t.pinned).map(t => t.id);
          if (otherIds.length > 0) await TabService.closeTabs(otherIds);
          sendResponse({ success: true });
          break;
        }
        case "CLOSE_TABS_RIGHT": {
          const allTabs = await TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
          const targetTab = allTabs.find(t => t.id === msg.tabId);
          if (targetTab) {
            const rightIds = allTabs.filter(t => t.index > targetTab.index && !t.pinned).map(t => t.id);
            if (rightIds.length > 0) await TabService.closeTabs(rightIds);
          }
          sendResponse({ success: true });
          break;
        }
        case "TOGGLE_PIN": {
          const tab = await chrome.tabs.get(msg.tabId);
          await TabService.pinTabs([msg.tabId], !tab.pinned);
          sendResponse({ success: true });
          break;
        }
        case "TOGGLE_MUTE": {
          const tab = await chrome.tabs.get(msg.tabId);
          await chrome.tabs.update(msg.tabId, { muted: !tab.mutedInfo?.muted });
          sendResponse({ success: true });
          break;
        }
        case "BOOKMARK_TAB": {
          const tab = await chrome.tabs.get(msg.tabId);
          await chrome.bookmarks.create({
            parentId: (await chrome.bookmarks.getBar())[0].id,
            title: msg.title || tab.title, url: msg.url || tab.url,
          });
          sendResponse({ success: true, message: "Bookmarked" });
          break;
        }
        case "DUPLICATE_TAB": { await chrome.tabs.duplicate(msg.tabId); sendResponse({ success: true }); break; }
        case "MOVE_TAB": { await chrome.tabs.move(msg.fromId, { index: msg.toIndex }); sendResponse({ success: true }); break; }

        case "AI_COMMAND": {
          const currentTabs = await TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
          const currentTabIds = new Set(currentTabs.map(t => t.id));
          const activeTab = currentTabs.find(t => t.active);

          let allTabCards;
          try { allTabCards = await TabDB.getAllTabCards(); } catch { await TabDB.init(); allTabCards = await TabDB.getAllTabCards(); }
          const liveTabCards = allTabCards.filter(c => currentTabIds.has(c.tabId));

          let retrievalResult;
          try {
            retrievalResult = await RetrievalService.retrieve(msg.command, liveTabCards, EmbeddingService, activeTab?.id, 20);
          } catch {
            retrievalResult = {
              parsed: { action: 'group', target: msg.command, type: 'fallback', domain: null },
              candidates: liveTabCards.map(c => ({ tabId: c.tabId, title: c.title || '', url: c.url || '', score: 0 })),
            };
          }

          const compactTabs = retrievalResult.candidates.map(c => ({ id: c.tabId, title: c.title, url: c.url, score: c.score }));
          if (compactTabs.length === 0) { sendResponse({ success: false, message: 'No matching tabs found' }); return; }

          const parsed = retrievalResult.parsed;

          // FAST PATH: Deterministic queries skip LLM
          if (parsed.type === 'deterministic' && parsed.domain && parsed.action) {
            const selectedIds = compactTabs.map(t => t.id);
            const toolName = parsed.action === 'focus' ? 'focus_tab' : `${parsed.action}_tabs`;
            const args = { tabIds: selectedIds };
            if (parsed.action === 'group') {
              args.groupName = parsed.domain.replace(/\.\w+$/, '').replace(/^www\./, '');
              args.groupName = args.groupName.charAt(0).toUpperCase() + args.groupName.slice(1);
            }
            if (parsed.action === 'bookmark') {
              args.folderName = parsed.domain.replace(/\.\w+$/, '').replace(/^www\./, '');
              args._tabs = compactTabs.map(t => ({ id: t.id, title: t.title, url: t.url }));
            }
            const toolResult = await executeTool(toolName, args);
            saveUndoState(toolName, { tabIds: selectedIds });
            sendResponse(toolResult);
            return;
          }

          // LLM PATH
          const chatResult = await ChatService.execute(msg.command, compactTabs);
          if (chatResult.error) { sendResponse({ success: false, message: chatResult.error }); return; }
          if (!chatResult.tool || !chatResult.arguments) { sendResponse({ success: false, message: 'Model returned invalid response' }); return; }

          const args = { ...chatResult.arguments };
          const selectedIds = compactTabs.map(t => t.id);
          switch (chatResult.tool) {
            case 'group_tabs': case 'close_tabs': case 'pin_tabs': case 'bookmark_tabs':
              args.tabIds = selectedIds; break;
            case 'focus_tab':
              args.tabId = selectedIds[0]; break;
          }
          if (chatResult.tool === 'bookmark_tabs') args._tabs = compactTabs.map(t => ({ id: t.id, title: t.title, url: t.url }));

          const toolResult = await executeTool(chatResult.tool, args);
          saveUndoState(chatResult.tool, { tabIds: selectedIds });
          sendResponse(toolResult);
          break;
        }

        case "EXECUTE_ACTION": {
          const toolResult = await executeTool(msg.action, msg.args);
          sendResponse(toolResult);
          break;
        }

        case "UNDO_LAST_ACTION": {
          if (!lastAction) { sendResponse({ success: false, message: "Nothing to undo" }); break; }
          const { action, data } = lastAction;
          lastAction = null;
          try {
            if (action === 'close_tabs' && data.tabIds) {
              for (const id of data.tabIds) { try { await chrome.tabs.sendMessage(id, {}); } catch {} }
              sendResponse({ success: true, message: "Undo attempted" });
            } else if (action === 'group_tabs' && data.tabIds) {
              await TabService.ungroupTabs(data.tabIds);
              sendResponse({ success: true, message: "Ungrouped tabs" });
            } else {
              sendResponse({ success: false, message: "Cannot undo this action" });
            }
          } catch (err) { sendResponse({ success: false, message: err.message }); }
          break;
        }

        // === SESSION HANDLERS ===
        case "SAVE_SESSION": {
          const allTabs = await TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
          const session = await SessionService.saveSession(msg.name, allTabs);
          sendResponse({ success: true, session });
          break;
        }
        case "GET_SESSIONS": {
          const sessions = await SessionService.getSessions();
          sendResponse({ sessions });
          break;
        }
        case "RESTORE_SESSION": {
          const result = await SessionService.restoreSession(msg.sessionId, msg.options || {});
          sendResponse(result);
          break;
        }
        case "DELETE_SESSION": {
          await SessionService.deleteSession(msg.sessionId);
          sendResponse({ success: true });
          break;
        }
        case "EXPORT_SESSION": {
          const data = await SessionService.exportSession(msg.sessionId);
          sendResponse({ success: true, data });
          break;
        }
        case "EXPORT_ALL_SESSIONS": {
          const data = await SessionService.exportAll();
          sendResponse({ success: true, data });
          break;
        }
        case "IMPORT_SESSION": {
          try {
            const result = await SessionService.importSession(msg.data);
            sendResponse({ success: true, count: result });
          } catch (e) { sendResponse({ success: false, message: e.message }); }
          break;
        }

        // === CLEANUP HANDLERS ===
        case "FIND_DUPLICATES": {
          const allTabs = await TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
          const duplicates = findDuplicateTabs(allTabs);
          sendResponse({ duplicates, count: duplicates.length });
          break;
        }

        default:
          sendResponse({ error: "Unsupported message type" });
          break;
      }
    } catch (err) {
      console.error("[Background] Error:", err);
      sendResponse({ success: false, message: err.message || "Internal error" });
    }
  })();

  return true;
});
```

**Verify:** `wc -l src/background/background.js` — should be ~350-400 lines.

---

## Task 5: Update `src/services/TabService.js`

Replace the entire file with:

```javascript
(() => {
  const TabService = {
    async getAllTabs(windowId) { return chrome.tabs.query({ windowId }); },
    async queryTabs(queryInfo = {}) { return chrome.tabs.query(queryInfo); },

    async groupTabs(tabIds, groupName = '', color = '') {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      if (ids.length === 0) return null;
      let groupId;
      try {
        groupId = await chrome.tabs.group({ tabIds: ids });
      } catch (e) {
        const successIds = [];
        for (const id of ids) {
          try { const gid = await chrome.tabs.group({ tabIds: [id] }); successIds.push(id); if (!groupId) groupId = gid; } catch {}
        }
        if (successIds.length === 0) return { groupId: null, grouped: 0, skipped: ids.length, error: e.message };
      }
      if (groupId) {
        const updateProperties = {};
        if (groupName) updateProperties.title = groupName;
        if (color) updateProperties.color = color;
        if (Object.keys(updateProperties).length > 0) {
          try { await chrome.tabGroups.update(groupId, updateProperties); } catch (e) { console.warn(`[TabService] Failed to update group: ${e.message}`); }
        }
      }
      return { groupId, grouped: ids.length, skipped: 0 };
    },

    async ungroupTabs(tabIds) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const id of ids) { try { await chrome.tabs.ungroup(id); } catch {} }
    },

    async closeTabs(tabIds) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      if (ids.length === 0) return;
      await chrome.tabs.remove(ids);
    },

    async focusTab(tabId) { await chrome.tabs.update(tabId, { active: true }); },

    async pinTabs(tabIds, pinned = true) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const id of ids) await chrome.tabs.update(id, { pinned });
    },

    async bookmarkTabs(tabs, folderName) {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0].children[0];
      let folder = bar.children.find(c => c.title === folderName && !c.url);
      let isNewFolder = false;
      if (!folder) { folder = await chrome.bookmarks.create({ parentId: bar.id, title: folderName }); isNewFolder = true; }
      let count = 0;
      for (const tab of tabs) { if (!tab.url) continue; await chrome.bookmarks.create({ parentId: folder.id, title: tab.title, url: tab.url }); count++; }
      return { success: true, count, folderId: folder.id, isNewFolder };
    },

    async extractText(tabId) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000) : ''
        });
        return results?.[0]?.result || '';
      } catch { return ''; }
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { TabService };
  if (typeof self !== 'undefined') self.TabService = TabService;
})();
```

---

## Task 6: Create `src/services/SessionService.js`

Create new file:

```javascript
(() => {
  const SESSION_STORE = 'sessions';

  const SessionService = {
    async saveSession(name, tabs) {
      const session = {
        id: crypto.randomUUID(),
        name: name || `Session ${new Date().toLocaleString()}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tabs: tabs.map(t => ({
          url: t.url, title: t.title, pinned: t.pinned || false,
          muted: t.mutedInfo?.muted || false,
          group: t.groupId ? { id: t.groupId, name: t.groupTitle || '', color: t.groupColor || '' } : null,
          index: t.index,
        })),
        metadata: {
          tabCount: tabs.length,
          domains: [...new Set(tabs.map(t => { try { return new URL(t.url).hostname; } catch { return ''; } }).filter(Boolean))],
        },
      };
      const db = await this._getDb();
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.objectStore(SESSION_STORE).put(session);
      return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(session); tx.onerror = () => reject(tx.error); });
    },

    async getSessions() {
      const db = await this._getDb();
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const request = tx.objectStore(SESSION_STORE).getAll();
      return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
    },

    async getSession(id) {
      const db = await this._getDb();
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const request = tx.objectStore(SESSION_STORE).get(id);
      return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); });
    },

    async deleteSession(id) {
      const db = await this._getDb();
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.objectStore(SESSION_STORE).delete(id);
      return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    },

    async exportSession(id) {
      const session = await this.getSession(id);
      if (!session) return null;
      return { format: 'tab-scroller-session', version: '2.0', exportedAt: new Date().toISOString(), session };
    },

    async exportAll() {
      const sessions = await this.getSessions();
      return { format: 'tab-scroller-session', version: '2.0', exportedAt: new Date().toISOString(), sessions };
    },

    async importSession(data) {
      if (data.format !== 'tab-scroller-session') throw new Error('Invalid session format');
      if (data.session) {
        const session = data.session;
        session.id = crypto.randomUUID();
        session.importedAt = Date.now();
        const db = await this._getDb();
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        tx.objectStore(SESSION_STORE).put(session);
        return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(session); tx.onerror = () => reject(tx.error); });
      }
      if (data.sessions) {
        const db = await this._getDb();
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        for (const session of data.sessions) { session.id = crypto.randomUUID(); session.importedAt = Date.now(); tx.objectStore(SESSION_STORE).put(session); }
        return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(data.sessions.length); tx.onerror = () => reject(tx.error); });
      }
    },

    async restoreSession(sessionId, options = {}) {
      const session = await this.getSession(sessionId);
      if (!session) throw new Error('Session not found');
      const { newWindow = false } = options;
      const windowId = newWindow
        ? (await chrome.windows.create({ url: session.tabs[0]?.url || 'chrome://newtab' })).id
        : chrome.windows.WINDOW_ID_CURRENT;
      const tabIds = [];
      for (const tab of session.tabs) {
        try {
          const created = await chrome.tabs.create({ url: tab.url, pinned: tab.pinned, muted: tab.muted, active: false, windowId });
          tabIds.push(created.id);
        } catch (e) { console.warn('[SessionService] Failed to open tab:', tab.url, e); }
      }
      const groups = new Map();
      for (let i = 0; i < session.tabs.length; i++) {
        const tab = session.tabs[i];
        if (tab.group) {
          const key = tab.group.name + tab.group.color;
          if (!groups.has(key)) groups.set(key, { name: tab.group.name, color: tab.group.color, tabIds: [] });
          if (tabIds[i]) groups.get(key).tabIds.push(tabIds[i]);
        }
      }
      for (const [, group] of groups) {
        if (group.tabIds.length > 0) {
          try {
            const groupId = await chrome.tabs.group({ tabIds: group.tabIds });
            await chrome.tabGroups.update(groupId, { title: group.name, color: group.color });
          } catch (e) { console.warn('[SessionService] Failed to create group:', e); }
        }
      }
      return { success: true, tabCount: tabIds.length };
    },

    async _getDb() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('TabScrollerDB', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(SESSION_STORE)) {
            const tx = db.transaction(SESSION_STORE, 'readwrite');
            tx.objectStore(SESSION_STORE);
          }
          resolve(db);
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        };
      });
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { SessionService };
  if (typeof self !== 'undefined') self.SessionService = SessionService;
})();
```

---

## Task 7: Run Tests and Verify

```bash
cd C:\Users\bkh\Desktop\tab-scroller-clean
npx jest tests/ --forceExit 2>&1 | head -50
```

Fix any test failures from API changes (ungroupTabs added, groupTabs simplified). Run again:

```bash
npx jest tests/ --forceExit
```

All tests must pass.

---

## Task 8: Final Packaging Check

```bash
cd C:\Users\bkh\Desktop\tab-scroller-clean
node -e "
const m = JSON.parse(require('fs').readFileSync('manifest.json','utf8'));
console.log('Permissions:', m.permissions);
console.log('Content scripts:', m.content_scripts?.length);
console.log('Background:', m.background?.service_worker);
console.log('Version:', m.version);
"
```

Verify all referenced files exist:
```bash
ls -la src/background/background.js src/background/executeTool.js src/ui/content.js src/services/TabService.js src/services/SessionService.js src/services/ChatService.js content.css icons/*.png
```

---

## What NOT to Modify

These files stay as-is:
- `src/background/executeTool.js`
- `src/services/ChatService.js`
- `src/services/EmbeddingService.js`
- `src/services/retrieval/*.js` (all 8 files)
- `src/models/TabCard.js`
- `src/storage/db.js`
- `backend/**`
- `icons/**`
