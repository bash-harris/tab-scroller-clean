// content.js
// Injects the tab scroller micro-bar into the page using Shadow DOM.

(function () {
  "use strict";

  // Prevent double injection
  if (document.getElementById("tab-scroller-host")) return;

  // Guard: Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.warn('[TabScroller] Extension context invalidated, skipping initialization');
    return;
  }

  // Guard wrapper for Chrome APIs
  function safeChromeCall(fn, fallback) {
    try {
      if (!chrome.runtime?.id) {
        return fallback;
      }
      return fn();
    } catch (e) {
      console.warn('[TabScroller] Chrome API call failed:', e.message);
      return fallback;
    }
  }

  // Safe storage wrapper
  function safeStorageGet(defaults, callback) {
    if (!chrome.runtime?.id) {
      if (callback) callback(defaults);
      return;
    }
    try {
      chrome.storage.sync.get(defaults, (items) => {
        if (chrome.runtime.lastError) {
          console.warn('[TabScroller] Storage get failed:', chrome.runtime.lastError.message);
          if (callback) callback(defaults);
          return;
        }
        if (callback) callback(items);
      });
    } catch (e) {
      console.warn('[TabScroller] Storage call failed:', e.message);
      if (callback) callback(defaults);
    }
  }

  // --- Push page content down so it doesn't get covered by the fixed bar ---
  //
  // STRATEGY: padding-top on <html> + explicit offset of position:fixed elements
  //
  // WHY NOT TRANSFORM? The old approach (body { transform: translateY(44px) })
  // breaks YouTube's hardware-accelerated video renderer (black screen) and
  // gets overridden by SPA hydration causing the page to "settle back".
  //
  // NEW APPROACH:
  // 1. html { padding-top: 44px } — pushes all flow content down
  // 2. Scan for position:fixed elements at top≈0 and shift them down
  // 3. Defer injection until page is fully loaded (prevents SPA revert)
  // 4. Periodic re-scan catches dynamically added fixed elements
  //
  const PUSH_HEIGHT = 36;
  const STYLE_ID = 'tab-scroller-page-push';
  const FIXED_ATTR = 'data-ts-fixed-pushed';

  function buildPushCSS(enabled) {
    if (!enabled) return '/* tab-scroller push disabled */';
    return `
      html {
        padding-top: ${PUSH_HEIGHT}px !important;
      }
    `;
  }

  function ensurePushStyle(enabled) {
    let el = document.getElementById(STYLE_ID);
    const css = buildPushCSS(enabled);
    if (el) {
      if (el.textContent !== css) el.textContent = css;
      el.disabled = false;
    } else {
      el = document.createElement('style');
      el.id = STYLE_ID;
      el.setAttribute('data-tab-scroller', 'push');
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  let pushEnabled = false; // Start disabled — enabled after page load

  function applyPush(enabled) {
    pushEnabled = enabled;
    ensurePushStyle(enabled);
  }

  // --- Fixed element offset system ---
  // Scans the DOM for position:fixed elements near top:0 and shifts them down
  function offsetFixedElements(enabled) {
    if (enabled) {
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.id === 'tab-scroller-host' || el.id === STYLE_ID) continue;
        if (el.closest && el.closest('#tab-scroller-host')) continue;
        if (el.hasAttribute(FIXED_ATTR)) continue;
        let computed;
        try { computed = getComputedStyle(el); } catch (e) { continue; }
        if (computed.position !== 'fixed') continue;
        const topVal = parseFloat(computed.top);
        if (isNaN(topVal) || topVal >= PUSH_HEIGHT) continue;
        // Save original inline top for restoration
        const savedTop = el.style.getPropertyValue('top');
        const savedPri = el.style.getPropertyPriority('top');
        el.setAttribute(FIXED_ATTR, JSON.stringify({ t: savedTop, p: savedPri }));
        el.style.setProperty('top', `${topVal + PUSH_HEIGHT}px`, 'important');
      }
    } else {
      // Restore all pushed elements
      const pushed = document.querySelectorAll(`[${FIXED_ATTR}]`);
      for (const el of pushed) {
        try {
          const saved = JSON.parse(el.getAttribute(FIXED_ATTR));
          if (saved.t) {
            el.style.setProperty('top', saved.t, saved.p || '');
          } else {
            el.style.removeProperty('top');
          }
        } catch (e) {
          el.style.removeProperty('top');
        }
        el.removeAttribute(FIXED_ATTR);
      }
    }
  }

  // MutationObserver: re-inject push style if removed by SPA navigation
  let pushObserver = null;
  function startPushObserver() {
    if (pushObserver) pushObserver.disconnect();
    pushObserver = new MutationObserver(() => {
      if (!pushEnabled) return;
      if (!document.getElementById(STYLE_ID)) {
        ensurePushStyle(true);
      }
    });
    if (document.head) {
      pushObserver.observe(document.head, { childList: true });
    }
  }

  // Periodic re-scan: catches new fixed elements from SPA navigation
  let fixedScanInterval = null;
  function startFixedElementScanner() {
    if (fixedScanInterval) clearInterval(fixedScanInterval);
    fixedScanInterval = setInterval(() => {
      if (!pushEnabled) return;
      if (!document.getElementById(STYLE_ID)) ensurePushStyle(true);
      offsetFixedElements(true); // re-scan for newly added fixed elements
    }, 3000);
  }

  function stopFixedElementScanner() {
    if (fixedScanInterval) { clearInterval(fixedScanInterval); fixedScanInterval = null; }
  }

  // --- Full push apply/remove helpers ---
  function applyFullPush() {
    applyPush(true);
    requestAnimationFrame(() => offsetFixedElements(true));
    startPushObserver();
    startFixedElementScanner();
  }

  function removeFullPush() {
    applyPush(false);
    offsetFixedElements(false);
    stopFixedElementScanner();
  }

  // --- Deferred initialization: wait for page to fully load ---
  let pageReady = false;

  function initPagePush() {
    pageReady = true;
    // Apply push if bar should be visible (always_show or not yet collapsed)
    if (!isCollapsed) {
      applyFullPush();
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(initPagePush, 500);
  } else {
    window.addEventListener('load', () => {
      setTimeout(initPagePush, 500);
    });
  }

  // --- Create Shadow DOM host ---
  const host = document.createElement("div");
  host.id = "tab-scroller-host";
  const shadow = host.attachShadow({ mode: "closed" });

  // --- Inject CSS ---
  const style = document.createElement("style");
  const cssPromise = fetch(chrome.runtime.getURL("content.css"))
    .then((r) => r.text())
    .then((css) => {
      style.textContent = css;
    });
  shadow.appendChild(style);

  // --- Build DOM ---
  const trigger = document.createElement("div");
  trigger.className = "ts-trigger"; // Always visible, docked below Chrome tabs

  const track = document.createElement("div");
  track.className = "ts-track";
  trigger.appendChild(track);

  // Scroll arrow indicators
  const arrowLeft = document.createElement("div");
  arrowLeft.className = "ts-arrow ts-arrow-left";
  arrowLeft.textContent = "\u2039"; // ‹
  trigger.appendChild(arrowLeft);

  const arrowRight = document.createElement("div");
  arrowRight.className = "ts-arrow ts-arrow-right";
  arrowRight.textContent = "\u203A"; // ›
  trigger.appendChild(arrowRight);

  // --- Release Phase 1: Center Button ---
  const centerBtn = document.createElement("div");
  centerBtn.className = "ts-center-btn";
  centerBtn.title = "Center on active tab";
  centerBtn.tabIndex = 0;
  centerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    scrollActiveTabIntoView(true);
  });
  centerBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      scrollActiveTabIntoView(true);
    }
  });
  trigger.insertBefore(centerBtn, track);

  // --- Pin/Unpin Button ---
  const pinBtn = document.createElement("div");
  pinBtn.className = "ts-pin-btn";
  pinBtn.title = "Toggle always show / auto-hide";
  pinBtn.textContent = "📌";
  pinBtn.style.cssText = "font-size: 10px; cursor: pointer; padding: 2px 6px; opacity: 0.6; transition: opacity 0.2s; flex-shrink: 0;";
  pinBtn.tabIndex = 0;
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (userSettings.displayMode === 'auto_hide') {
      chrome.storage.sync.set({ displayMode: 'always_show' });
      pinBtn.style.opacity = '1';
      pinBtn.title = "Click to enable auto-hide";
    } else {
      chrome.storage.sync.set({ displayMode: 'auto_hide' });
      pinBtn.style.opacity = '0.4';
      pinBtn.title = "Click to keep always visible";
    }
  });
  pinBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pinBtn.click();
    }
  });
  trigger.insertBefore(pinBtn, track);

  // --- Release Phase 2: Search Input ---
  const searchContainer = document.createElement("div");
  searchContainer.className = "ts-search-container";
  
  const searchIcon = document.createElement("span");
  searchIcon.textContent = "🔍";
  searchIcon.style.fontSize = "12px";
  searchIcon.style.marginRight = "4px";
  searchContainer.appendChild(searchIcon);

  const searchInput = document.createElement("input");
  searchInput.className = "ts-search-input";
  searchInput.placeholder = "Search tabs...";
  searchInput.spellcheck = false;
  searchContainer.appendChild(searchInput);

  trigger.insertBefore(searchContainer, track);

  // Dedicated Search Button (always visible)
  const searchBtn = document.createElement("div");
  searchBtn.className = "ts-search-btn";
  searchBtn.title = "Search tabs (Ctrl+K)";
  searchBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
  searchBtn.tabIndex = 0;
  searchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startSearch();
  });
  searchBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      startSearch();
    }
  });
  trigger.insertBefore(searchBtn, searchContainer);

  const cleanupBtn = document.createElement("div");
  cleanupBtn.className = "ts-cleanup-btn";
  cleanupBtn.title = "Purge duplicate tabs";
  cleanupBtn.textContent = "🧹";
  cleanupBtn.tabIndex = 0;
  cleanupBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    performPurgeAnimation();
    setTimeout(() => {
      safeSendMessage({ type: "PURGE_DUPLICATES" });
    }, 400); // Wait for animation
  });
  cleanupBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      performPurgeAnimation();
      setTimeout(() => {
        safeSendMessage({ type: "PURGE_DUPLICATES" });
      }, 400);
    }
  });
  const shieldBtn = document.createElement("div");
  shieldBtn.className = "ts-shield-btn";
  shieldBtn.title = "AI Privacy Shield";
  shieldBtn.textContent = "🛡️";
  shieldBtn.tabIndex = 0;
  shieldBtn.style.display = "none"; // Hidden by default, toggled by setting
  shieldBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    safeSendMessage({ type: "SHIELD_ACTIVATE" });
  });
  shieldBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      safeSendMessage({ type: "SHIELD_ACTIVATE" });
    }
  });
  trigger.insertBefore(shieldBtn, searchContainer);

  // Sync Shield visibility from settings
  safeStorageGet({ enableShield: false }, (items) => {
    shieldBtn.style.display = items.enableShield ? '' : 'none';
  });

  const bookmarkBtn = document.createElement("div");
  bookmarkBtn.className = "ts-bookmark-btn";
  bookmarkBtn.title = "Open Bookmark Organizer";
  bookmarkBtn.textContent = "🔖";
  bookmarkBtn.tabIndex = 0;
  bookmarkBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    safeSendMessage({ type: "OPEN_BOOKMARK_MANAGER" });
  });
  bookmarkBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      safeSendMessage({ type: "OPEN_BOOKMARK_MANAGER" });
    }
  });

  trigger.insertBefore(bookmarkBtn, searchContainer);

  // ===== SESSION MEMORY BUTTON =====
  const sessionBtn = document.createElement("div");
  sessionBtn.className = "ts-session-btn";
  sessionBtn.title = "Session Memory";
  sessionBtn.innerHTML = `📋<span class="ts-session-dot"></span>`;
  sessionBtn.tabIndex = 0;
  sessionBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Open session manager page
    const url = chrome.runtime.getURL("session-manager.html");
    window.open(url, '_blank');
  });
  sessionBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const url = chrome.runtime.getURL("session-manager.html");
      window.open(url, '_blank');
    }
  });
  trigger.insertBefore(sessionBtn, searchContainer);

  // Check if session is active and show indicator dot
  safeSendMessage({ type: "SESSION_GET_ACTIVE" }, (resp) => {
    if (resp && resp.session) {
      sessionBtn.classList.add("ts-session-active");
    }
  });

  // ===== UNDO BUTTON =====
  const undoBtn = document.createElement("div");
  undoBtn.className = "ts-undo-btn";
  undoBtn.title = "Undo last action";
  undoBtn.textContent = "↩️";
  undoBtn.tabIndex = 0;
  undoBtn.style.display = "none"; // Hidden until an undoable action occurs
  undoBtn.style.cssText += `
    cursor: pointer; font-size: 14px; padding: 2px 6px;
    border-radius: 6px; transition: all 0.2s ease;
    opacity: 0.8; min-width: 20px; text-align: center;
  `;
  undoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    safeSendMessage({ type: "UNDO_LAST_ACTION" }, (response) => {
      if (response && response.success) {
        showToast(response.message, "success");
      } else {
        showToast(response?.message || "Nothing to undo", "warning");
      }
      undoBtn.style.display = "none";
    });
  });
  undoBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      undoBtn.click();
    }
  });
  trigger.insertBefore(undoBtn, searchContainer);

  shadow.appendChild(trigger);
  
  let tabs = [];
  let contextValid = true;
  let suggestedCloseIds = new Set();
  let selectedTabIds = new Set();
  let quarantinedTabIds = new Set();

  // Drag and drop state
  let draggedTabId = null;
  let insertionLine = document.createElement("div");
  insertionLine.className = "insertion-line";
  let scrollInterval = null;

  // Release Phase 1 Settings
  let userSettings = { autoScroll: true, theme: 'system', displayMode: 'always_show', collapseDelay: 1500, dockPosition: 'bottom' };
  let isCollapsed = false;
  let hideTimeout = null;
  let aiPanelOpen = false;

  // --- Auto-hide functionality ---
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function highlightMatch(text, query) {
    if (!query || !text) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }

  function startHideTimer() {
    clearTimeout(hideTimeout);
    // Don't hide if search is active
    if (userSettings.displayMode !== 'auto_hide' || isCollapsed || isSearchActive) return;
    hideTimeout = setTimeout(() => {
      collapseBar();
    }, userSettings.collapseDelay || 1500);
  }

  function expandBar() {
    if (!isCollapsed) return;
    isCollapsed = false;
    trigger.classList.remove("collapsed");
    // Re-enable page push (padding + fixed-element offset)
    if (pageReady) {
      applyFullPush();
    }
    startHideTimer();
  }

  function collapseBar() {
    if (isCollapsed) return;
    isCollapsed = true;
    trigger.classList.add("collapsed");
    // Remove page push entirely to avoid blank space when bar is hidden
    removeFullPush();
  }

  function toggleCollapse() {
    if (isCollapsed) {
      expandBar();
    } else {
      collapseBar();
    }
  }

  // Show bar on mouse approach (only in auto_hide mode)
  document.addEventListener("mousemove", (e) => {
    if (userSettings.displayMode !== 'auto_hide') return;
    if (e.clientY <= 2) { // Only trigger when mouse reaches the very top line (within 2px)
      expandBar();
    }
  });

  // --- Always show trigger (mouse over bar keeps it open) ---
  trigger.addEventListener("mouseenter", () => {
    if (userSettings.displayMode === 'auto_hide') {
      clearTimeout(hideTimeout);
    }
  });

  trigger.addEventListener("mouseleave", () => {
    // Don't collapse if search is active
    if (userSettings.displayMode === 'auto_hide' && !isSearchActive) {
      startHideTimer();
    }
  });

  // --- Search Popup Dropdown ---
  const searchPopup = document.createElement("div");
  searchPopup.className = "ts-search-popup";
  searchPopup.innerHTML = `
    <div class="ts-search-popup-header">
      <svg class="ts-search-popup-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" class="ts-search-popup-input" placeholder="Search tabs..." spellcheck="false">
      <span class="ts-search-popup-close">✕</span>
    </div>
    <div class="ts-search-popup-results"></div>
  `;
  trigger.appendChild(searchPopup);

  // Position popup below the search button (now inside trigger)
  function positionSearchPopup() {
    const btnRect = searchBtn.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const popupWidth = 480;
    const leftPos = (btnRect.left - triggerRect.left) + (btnRect.width / 2) - (popupWidth / 2);
    searchPopup.style.position = 'absolute';
    searchPopup.style.top = '100%';
    searchPopup.style.left = Math.max(0, leftPos) + 'px';
    searchPopup.style.marginTop = '8px';
  }

  const searchPopupInput = searchPopup.querySelector(".ts-search-popup-input");
  const searchPopupResults = searchPopup.querySelector(".ts-search-popup-results");
  const searchPopupClose = searchPopup.querySelector(".ts-search-popup-close");

  searchPopupClose.addEventListener("click", () => {
    stopSearch();
  });

  // Close search when clicking outside strip and popup
  document.addEventListener("click", (e) => {
    if (!isSearchActive) return;
    
    const isClickOnStrip = trigger.contains(e.target);
    const isClickOnPopup = searchPopup.contains(e.target);
    
    if (!isClickOnStrip && !isClickOnPopup) {
      stopSearch();
    }
  });

  // Prevent clicks inside popup from closing it
  searchPopup.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  searchPopupInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase();
    // Sync with original search input
    searchInput.value = e.target.value;
    focusedIndex = -1;
    render();
    updateSearchPopupResults();

    // Auto-scroll to first match
    if (searchQuery) {
      const firstMatchIndex = tabs.findIndex(t => isTabMatch(t, searchQuery));
      if (firstMatchIndex !== -1) {
        scrollActiveTabIntoView(true, firstMatchIndex);
      }
    }
  });

  // Keyboard navigation in popup
  let popupSelectedIndex = -1;
  searchPopupInput.addEventListener("keydown", (e) => {
    const results = searchPopupResults.querySelectorAll('.ts-search-popup-result');
    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      popupSelectedIndex = Math.min(popupSelectedIndex + 1, results.length - 1);
      updatePopupSelection(results);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      popupSelectedIndex = Math.max(popupSelectedIndex - 1, 0);
      updatePopupSelection(results);
    } else if (e.key === "Enter" && popupSelectedIndex >= 0) {
      e.preventDefault();
      results[popupSelectedIndex].click();
    } else if (e.key === "Escape") {
      stopSearch();
    }
  });

  function updatePopupSelection(results) {
    results.forEach((r, i) => r.classList.toggle('selected', i === popupSelectedIndex));
    if (results[popupSelectedIndex]) {
      results[popupSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function updateSearchPopupResults() {
    if (!searchQuery) {
      searchPopupResults.innerHTML = '<div class="ts-search-popup-empty">⌕ Type to search tabs...</div>';
      return;
    }

    const matchingTabs = tabs.filter(t => isTabMatch(t, searchQuery));
    if (matchingTabs.length === 0) {
      searchPopupResults.innerHTML = '<div class="ts-search-popup-empty">✕ No matching tabs found</div>';
      return;
    }

    // Show only top 8 tabs
    const topTabs = matchingTabs.slice(0, 8);
    const hasMore = matchingTabs.length > 8;

    let html = '';
    if (hasMore) {
      html += `<div class="ts-search-popup-count">${matchingTabs.length} tabs found</div>`;
    }
    
    html += topTabs.map((tab, idx) => {
      const domain = new URL(tab.url || 'http://').hostname;
      const highlightedTitle = searchQuery 
        ? highlightMatch(escapeHtml(tab.title || 'Untitled'), searchQuery)
        : escapeHtml(tab.title || 'Untitled');
      
      return `
        <div class="ts-search-popup-result" data-tab-index="${tabs.indexOf(tab)}">
          <span class="ts-search-popup-favicon">${tab.favIconUrl ? `<img src="${tab.favIconUrl}">` : '<span>📄</span>'}</span>
          <div class="ts-search-popup-info">
            <span class="ts-search-popup-title">${highlightedTitle}</span>
            <span class="ts-search-popup-domain">${escapeHtml(domain)}</span>
          </div>
          ${idx < 4 ? `<span class="ts-search-popup-shortcut">${idx + 1}</span>` : ''}
        </div>
      `;
    }).join('');

    searchPopupResults.innerHTML = html;

    // Add click handlers
    searchPopupResults.querySelectorAll('.ts-search-popup-result').forEach(el => {
      el.addEventListener('click', () => {
        const tabIndex = parseInt(el.dataset.tabIndex);
        const tab = tabs[tabIndex];
        if (tab) {
          safeSendMessage({ type: "SWITCH_TAB", tabId: tab.id });
          stopSearch();
          searchPopup.style.display = "none";
        }
      });
    });
  }

  // Release Phase 2 Search & Nav
  let searchQuery = "";
  let focusedIndex = -1;
  let isSearchActive = false;
  let searchHasFocus = false;

  // Custom Sort (Task 8)
  let currentSortMode = 'default';

  // AI Command Debouncing
  let aiCommandInProgress = false;

  // Release Phase 3 Hover Preview
  let hoverTimeout = null;
  const hoverCard = document.createElement("div");
  hoverCard.className = "ts-hover-card";
  shadow.appendChild(hoverCard);

  // --- Context Menu Setup ---
  const contextMenu = document.createElement("div");
  contextMenu.className = "ts-context-menu";
  shadow.appendChild(contextMenu);

  let activeContextMenuTabId = null;

  function closeContextMenu() {
    contextMenu.classList.remove("visible");
    activeContextMenuTabId = null;
  }

  // Close the menu if clicking anywhere else
  window.addEventListener("click", closeContextMenu);
  window.addEventListener("blur", closeContextMenu);
  track.addEventListener("scroll", closeContextMenu); // Close if user scrolls the ribbon

  contextMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    const item = e.target.closest(".ts-menu-item");
    if (!item || !activeContextMenuTabId) return;

    const action = item.dataset.action;
    const tabId = activeContextMenuTabId;

    switch (action) {
      case "new_right": safeSendMessage({ type: "NEW_TAB_RIGHT", tabId }); break;
      case "reload": safeSendMessage({ type: "RELOAD_TAB", tabId }); break;
      case "duplicate": safeSendMessage({ type: "DUPLICATE_TAB", tabId }); break;
      case "pin": safeSendMessage({ type: "TOGGLE_PIN", tabId }); break;
      case "mute": safeSendMessage({ type: "TOGGLE_MUTE", tabId }); break;
      case "close": safeSendMessage({ type: "CLOSE_TAB", tabId }); break;
      case "close_other": safeSendMessage({ type: "CLOSE_OTHER_TABS", tabId }); break;
      case "close_right": safeSendMessage({ type: "CLOSE_TABS_RIGHT", tabId }); break;

    }
    closeContextMenu();
  });
  
  // Hover card click delegation
  hoverCard.addEventListener("click", (e) => {
    const muteBtn = e.target.closest(".ts-hc-mute-btn");
    if (muteBtn) {
      e.stopPropagation();
      const tabId = parseInt(muteBtn.dataset.tabId);
      const isMuted = muteBtn.dataset.muted === "true";
      safeSendMessage({ type: "TOGGLE_MUTE", tabId: tabId });
      // Update local state temporarily for immediate feedback
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        tab.muted = !isMuted;
        showHoverCard(tab, shadow.querySelector(`[data-tab-id="${tabId}"]`));
      }
    }
  });

  // --- Safe messaging (handles extension reload) ---
  function safeSendMessage(msg, callback) {
    try {
      if (!chrome.runtime?.id) {
        contextValid = false;
        showReloadHint();
        return;
      }
      if (callback) {
        // Expects a response — pass callback
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            contextValid = false;
            showReloadHint();
            return;
          }
          callback(response);
        });
      } else {
        // Fire-and-forget (e.g. SWITCH_TAB) — no response expected
        chrome.runtime.sendMessage(msg);
      }
    } catch (e) {
      contextValid = false;
      showReloadHint();
    }
  }

  function showReloadHint() {
    track.innerHTML = "";
    const hint = document.createElement("div");
    hint.style.cssText = "color:#fff;font-size:11px;padding:8px 12px;opacity:0.7;white-space:nowrap;";
    hint.textContent = "⟳ Extension updated — refresh this page";
    track.appendChild(hint);
  }

  // --- Idle Hide Logic — REMOVED (bar is now permanent below Chrome tabs) ---
  // No showBar/startHideTimer needed - bar is always visible

  // --- Arrow visibility (Throttled) ---
  let arrowUpdatePending = false;
  function updateArrows() {
    if (arrowUpdatePending) return;
    arrowUpdatePending = true;
    requestAnimationFrame(() => {
      arrowUpdatePending = false;
      const atStart = track.scrollLeft <= 4;
      const atEnd =
        track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
      arrowLeft.classList.toggle("visible", !atStart);
      arrowRight.classList.toggle("visible", !atEnd);
    });
  }

  track.addEventListener("scroll", () => {
    updateArrows();
    scheduleVisibleInsightsPrefetch();
  });

  // --- Drag and Drop Track Events ---
  track.addEventListener("dragenter", (e) => {
    e.preventDefault();
  });

  track.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!draggedTabId) return;
    
    e.dataTransfer.dropEffect = "move";

    // Auto-scroll logic
    const rect = track.getBoundingClientRect();
    const scrollThreshold = 30;
    const scrollSpeed = 5;

    clearInterval(scrollInterval);
    if (e.clientX < rect.left + scrollThreshold) {
      scrollInterval = setInterval(() => track.scrollLeft -= scrollSpeed, 16);
    } else if (e.clientX > rect.right - scrollThreshold) {
      scrollInterval = setInterval(() => track.scrollLeft += scrollSpeed, 16);
    } else {
      scrollInterval = null;
    }

    // Insertion line logic
    const domTabs = Array.from(track.querySelectorAll('.ts-tab:not(.dragging)'));
    let insertBeforeEl = null;

    for (const tabEl of domTabs) {
      const elRect = tabEl.getBoundingClientRect();
      if (e.clientX < elRect.left + elRect.width / 2) {
        insertBeforeEl = tabEl;
        break;
      }
    }

    if (insertBeforeEl) {
      insertBeforeEl.parentNode.insertBefore(insertionLine, insertBeforeEl);
    } else {
      track.appendChild(insertionLine);
    }
  });

  track.addEventListener("dragleave", (e) => {
    if (!track.contains(e.relatedTarget)) {
      if (insertionLine.parentNode) insertionLine.remove();
      clearInterval(scrollInterval);
      scrollInterval = null;
    }
  });

  track.addEventListener("drop", (e) => {
    e.preventDefault();
    clearInterval(scrollInterval);
    scrollInterval = null;

    if (!draggedTabId) {
      if (insertionLine.parentNode) insertionLine.remove();
      return;
    }

    // Calculate new index based on insertionLine position before removing it
    const domChildren = Array.from(track.querySelectorAll('.ts-tab:not(.dragging), .insertion-line'));
    const dropIndex = domChildren.indexOf(insertionLine);

    if (insertionLine.parentNode) insertionLine.remove();
    if (dropIndex === -1) return;

    const originalIndex = tabs.findIndex(t => t.id === draggedTabId);
    if (originalIndex === -1) return;

    // Optimistic UI updates
    const [tabToMove] = tabs.splice(originalIndex, 1);

    // Adjust target index based on array modification
    let targetIndex = dropIndex;
    if (originalIndex < dropIndex) targetIndex--;
    // TargetIndex here is within the tab scroller's DOM list, which maps closely to Chrome's tab index
    // if we consider this covers all tabs in window.
    // background.js uses the absolute tab indexes. Assuming tab scroller shows all tabs in sequence.
    tabs.splice(targetIndex, 0, tabToMove);
    render();

    // Map the relative DOM index to the absolute chrome tab index
    // If targetIndex is the end of the list, use the last tab's index + 1
    // Actually, background.js requires native chrome tab index.
    // The tab scroller array `tabs` is ordered exactly like chrome tabs in the window.
    // Since we just updated `tabs` optimistically, `targetIndex` is the new position.
    
    // We must pass the new absolute index. If we are dragging past other tabs, 
    // we want it to literally take `targetIndex` within the window's tabs.
    // Because the tab cache is sorted by `index`.
    
    const absNewIndex = targetIndex; 

    safeSendMessage({ type: "MOVE_TAB", tabId: draggedTabId, toIndex: absNewIndex });
  });

  // --- Lazy Loading Observer ---
  const iconObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            const src = img.dataset.src;
            // Prevent mixed content: skip http:// favicons on https:// pages
            const isMixed = location.protocol === 'https:' && src.startsWith('http://');
            if (!isMixed) {
              img.src = src;
            } else {
              // Replace with fallback to avoid blocked request
              const fallback = document.createElement('span');
              fallback.textContent = '🌐';
              fallback.className = img.className;
              fallback.style.cssText = 'font-size:12px;display:inline-flex;align-items:center;justify-content:center;';
              img.replaceWith(fallback);
            }
            img.removeAttribute("data-src");
          }
          iconObserver.unobserve(img);
        }
      });
    },
    { root: track, rootMargin: "20px" }
  );

  // --- Search Filtering ---
  function fuzzyMatch(query, text) {
    if (!query) return true;
    if (!text) return false;
    const t = text.toLowerCase();
    let qIdx = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === query[qIdx]) {
        qIdx++;
        if (qIdx === query.length) return true;
      }
    }
    return false;
  }

  function isTabMatch(tab, query) {
    if (!query) return true;
    return (
      fuzzyMatch(query, tab.title) ||
      (tab.url && fuzzyMatch(query, tab.url)) ||
      (tab.groupTitle && fuzzyMatch(query, tab.groupTitle))
    );
  }

  // --- Render (Surgical DOM Updates) ---
  function render() {
    const visibleItems = []; // { type: 'header'|'tab', data: group|tab }
    let lastGroupId = -1;

    let tabsToRender = [...tabs];

    if (currentSortMode === 'domain') {
      tabsToRender.sort((a, b) => {
        const getHost = (url) => {
          try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
          catch(e) { return ''; }
        };
        return getHost(a.url).localeCompare(getHost(b.url));
      });
    } else if (currentSortMode === 'title') {
      tabsToRender.sort((a, b) => (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase()));
    }

    tabsToRender.forEach((tab) => {
      const gId = (tab.groupId !== undefined && tab.groupId !== -1) ? tab.groupId : -1;
      
      // If start of a new group (Only show groups in default sort mode)
      if (currentSortMode === 'default' && gId !== -1 && gId !== lastGroupId) {
        visibleItems.push({
          type: "header",
          id: `group-${gId}`,
          groupId: gId,
          title: tab.groupTitle || "Unnamed Group",
          color: tab.groupColor || "grey",
          collapsed: !!tab.groupCollapsed,
        });
      }

      // Show tab if not collapsed OR if in custom sort mode (where we ignore groups)
      if (currentSortMode !== 'default' || !tab.groupCollapsed) {
        visibleItems.push({ type: "tab", id: tab.id.toString(), tab: tab });
      }

      lastGroupId = gId;
    });

    // 2. Fast lookup for items in track
    const currentItemIds = new Set(visibleItems.map((item) => item.id));

    // 3. Remove obsolete DOM elements (tabs or headers)
    Array.from(track.children).forEach((el) => {
      if (!currentItemIds.has(el.dataset.id)) {
        el.remove();
      }
    });

    // 4. Update or create elements in correct order
    visibleItems.forEach((item, index) => {
      let el = track.querySelector(`[data-id="${item.id}"]`);

      if (!el) {
        if (item.type === "header") {
          el = document.createElement("div");
          el.className = `ts-group-header ts-group-${item.color}`;
          el.dataset.id = item.id;
          el.textContent = item.title;
          el.tabIndex = 0;
          const toggleGroup = () => {
            safeSendMessage({
              type: "TOGGLE_GROUP",
              groupId: item.groupId,
              collapsed: !item.collapsed,
            });
          };
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleGroup();
          });
          el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              toggleGroup();
            }
          });
        } else {
          // Tab Creation (refactored from previous version)
          el = createTabElement(item.tab);
        }
      }

      // Update state for existing elements
      if (item.type === "header") {
        el.className = `ts-group-header ts-group-${item.color}`;
        el.classList.toggle("collapsed", item.collapsed);
        if (el.textContent !== item.title) el.textContent = item.title;
      } else {
        updateTabElement(el, item.tab);
      }

      // Ensure correct DOM order
      if (track.children[index] !== el) {
        track.insertBefore(el, track.children[index]);
      }
    });

    scrollActiveTabIntoView();
    updateArrows();
    scheduleVisibleInsightsPrefetch();
  }

  function createTabElement(tab) {
    const tabIdStr = tab.id.toString();
    const el = document.createElement("button");
    // Using Tailwind classes instead of pure ts-tab
    el.className = "w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center text-on-surface hover:bg-primary-fixed hover:text-on-primary-fixed transition-colors relative group border border-surface-variant cursor-pointer ts-tab";
    el.dataset.tabId = tabIdStr;
    el.dataset.id = tabIdStr;
    el.draggable = true;
    el.tabIndex = 0;

    el.addEventListener("dragstart", (e) => {
      draggedTabId = tab.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tabIdStr);
      requestAnimationFrame(() => el.classList.add("dragging"));
    });

    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      draggedTabId = null;
      if (insertionLine.parentNode) insertionLine.remove();
      clearInterval(scrollInterval);
      scrollInterval = null;
    });

    // Group Color Bar
    const groupBar = document.createElement("div");
    groupBar.className = "ts-tab-group-bar absolute top-0 left-1 right-1 h-[3px] rounded-b-sm z-10";
    el.appendChild(groupBar);

    const audioIndicator = document.createElement("div");
    audioIndicator.className = "ts-tab-audio-indicator absolute -bottom-1 -right-1 w-3 h-3 bg-white text-[8px] rounded-full flex items-center justify-center shadow-sm z-20 cursor-pointer text-primary transition-transform hover:scale-125";
    audioIndicator.title = "Click to mute/unmute";
    audioIndicator.addEventListener("click", (e) => {
      e.stopPropagation();
      const tabId = parseInt(tab.id);
      safeSendMessage({ type: "TOGGLE_MUTE", tabId: tabId });
      tab.muted = !tab.muted;
      updateTabElement(el, tab);
    });
    el.appendChild(audioIndicator);

    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.className = "w-4 h-4 object-cover opacity-80 rounded-sm pointer-events-none";
      img.dataset.src = tab.favIconUrl;
      img.alt = "";
      img.onerror = () => img.replaceWith(makeFallback(tab));
      el.appendChild(img);
      iconObserver.observe(img);
    } else {
      el.appendChild(makeFallback(tab));
    }

    const tooltip = document.createElement("div");
    tooltip.className = "ts-tooltip";
    el.appendChild(tooltip);

    // Hover Preview Logic
    el.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        const hoveredId = tab.id;
        const neighborIds = tabs
          .map((t) => t.id)
          .filter((id) => Math.abs(tabs.findIndex((x) => x.id === id) - tabs.findIndex((x) => x.id === hoveredId)) <= 4)
          .slice(0, 9);

        safeSendMessage({ type: 'PREFETCH_TAB_INSIGHTS', tabIds: neighborIds }, () => {
          showHoverCard(tab, el);
        });
      }, 250);
    });

    el.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimeout);
      hideHoverCard();
    });

    el.addEventListener("click", (e) => {
      e.stopPropagation();

      if (quarantinedTabIds.has(tab.id)) {
        if (!confirm("This tab looks suspicious. Are you sure you want to switch to it?")) {
          return;
        }
        quarantinedTabIds.delete(tab.id);
        el.classList.remove("quarantined");
      }

      if (e.shiftKey) {
        if (selectedTabIds.has(tab.id)) {
          selectedTabIds.delete(tab.id);
        } else {
          selectedTabIds.add(tab.id);
        }
        
        if (selectedTabIds.size > 1) {
          searchInput.placeholder = "Ask AI to extract data...";
        } else {
          searchInput.placeholder = "Search tabs...";
        }
        render();
        return;
      }
      
      const ripple = document.createElement("span");
      ripple.className = "ts-ripple";
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
      el.appendChild(ripple);
      setTimeout(() => ripple.remove(), 400);

      safeSendMessage({ type: "SWITCH_TAB", tabId: tab.id });
      hideHoverCard();
      selectedTabIds.clear();
      searchInput.placeholder = "Search tabs...";
      render();
    });

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        safeSendMessage({ type: "SWITCH_TAB", tabId: tab.id });
        hideHoverCard();
      }
    });

    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.stopPropagation();
        safeSendMessage({ type: "CLOSE_TAB", tabId: tab.id });
      }
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (suggestedCloseIds.has(tab.id)) {
        suggestedCloseIds.delete(tab.id);
        el.classList.remove("suggested-close");
      }

      activeContextMenuTabId = tab.id;

      contextMenu.innerHTML = `
        <div class="ts-menu-item" data-action="new_right">New tab to the right</div>
        <div class="ts-menu-divider"></div>
        <div class="ts-menu-item" data-action="reload">
          Reload <span class="ts-menu-shortcut">Ctrl+R</span>
        </div>
        <div class="ts-menu-item" data-action="duplicate">Duplicate</div>
        <div class="ts-menu-item" data-action="pin">${tab.pinned ? 'Unpin' : 'Pin'}</div>
        <div class="ts-menu-item" data-action="mute">${tab.muted ? 'Unmute site' : 'Mute site'}</div>
        <div class="ts-menu-divider"></div>
        <div class="ts-menu-item" data-action="close">
          Close <span class="ts-menu-shortcut">Ctrl+W</span>
        </div>
        <div class="ts-menu-item" data-action="close_other">Close other tabs</div>
        <div class="ts-menu-item" data-action="close_right">Close tabs to the right</div>

      `;

      let x = e.clientX;
      let y = e.clientY;

      contextMenu.classList.add("visible");
      const menuRect = contextMenu.getBoundingClientRect();
      
      if (x + menuRect.width > window.innerWidth) {
        x = window.innerWidth - menuRect.width - 5;
      }
      if (y + menuRect.height > window.innerHeight) {
        y = window.innerHeight - menuRect.height - 5;
      }

      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;
    });

    return el;
  }

  function updateTabElement(el, tab) {
    el.classList.toggle("active", tab.active);
    el.draggable = (currentSortMode === 'default');
    el.style.cursor = el.draggable ? 'pointer' : 'default';
    el.classList.toggle("discarded", !!tab.discarded);
    el.classList.toggle("selected", selectedTabIds.has(tab.id));

    // Group bar update
    const groupBar = el.querySelector(".ts-tab-group-bar");
    const gId = (tab.groupId !== undefined && tab.groupId !== -1) ? tab.groupId : -1;
    if (gId !== -1) {
      groupBar.className = `ts-tab-group-bar ${tab.groupColor || "grey"}`;
      groupBar.style.display = "block";
    } else {
      groupBar.style.display = "none";
    }

    el.classList.toggle("suggested-close", suggestedCloseIds.has(tab.id));
    el.classList.toggle("quarantined", quarantinedTabIds.has(tab.id));

    // Search & Focus states
    const isMatch = isTabMatch(tab, searchQuery);
    el.classList.toggle("search-dimmed", !isMatch);

    const filteredTabs = tabs.filter((t) => isTabMatch(t, searchQuery));
    const isFocused =
      focusedIndex !== -1 && filteredTabs[focusedIndex]?.id === tab.id;
    el.classList.toggle("focused", isFocused);

    // Update tooltip title
    const tooltip = el.querySelector(".ts-tooltip");
    const fullTitle = tab.groupTitle
      ? `[${tab.groupTitle}] ${tab.title || "Untitled"}`
      : tab.title || "Untitled";
    if (tooltip && tooltip.textContent !== fullTitle) {
      tooltip.textContent = fullTitle;
    }

    // Audio Indicator
    const audioInd = el.querySelector(".ts-tab-audio-indicator");
    if (audioInd) {
      audioInd.style.display = (tab.audible || tab.muted) ? "block" : "none";
      audioInd.innerHTML = tab.muted ? "🔇" : "🔊";
      audioInd.classList.toggle("muted", tab.muted);
    }

    // Update favicon safely
    const currentMedia = el.querySelector("img, .ts-fallback");
    if (tab.favIconUrl) {
      if (
        !currentMedia ||
        currentMedia.tagName !== "IMG" ||
        (currentMedia.dataset.src !== tab.favIconUrl &&
          currentMedia.src !== tab.favIconUrl)
      ) {
        const newImg = document.createElement("img");
        newImg.dataset.src = tab.favIconUrl;
        newImg.alt = "";
        newImg.onerror = () => newImg.replaceWith(makeFallback(tab.title));
        if (currentMedia) currentMedia.replaceWith(newImg);
        else el.insertBefore(newImg, tooltip);
        iconObserver.observe(newImg);
      }
    } else {
      const fallbackContent = tab.emoji ? tab.emoji : (tab.title || "?")[0].toUpperCase();
      if (!currentMedia || currentMedia.tagName !== "DIV" || currentMedia.textContent !== fallbackContent) {
        const newFallback = makeFallback(tab);
        if (currentMedia) currentMedia.replaceWith(newFallback);
        else el.insertBefore(newFallback, tooltip);
      }
    }
  }




  // --- Release Phase 2 Search & Nav Logic ---
  function startSearch() {
    isSearchActive = true;
    searchContainer.classList.add("active");
    searchInput.focus();
    // Show popup dropdown
    positionSearchPopup();
    searchPopup.classList.add("open");
    searchPopupInput.focus();
    updateSearchPopupResults();
    // Ensure bar stays visible
    if (userSettings.displayMode === 'auto_hide' && isCollapsed) {
      expandBar();
    }
    clearTimeout(hideTimeout); // Prevent auto-hide while searching
    focusedIndex = -1;
    render();
  }

  function stopSearch() {
    isSearchActive = false;
    searchQuery = "";
    searchInput.value = "";
    searchContainer.classList.remove("active");
    searchInput.blur();
    searchPopup.classList.remove("open");
    searchPopupInput.value = "";
    focusedIndex = -1;
    render();
  }

  searchInput.addEventListener("focus", () => { searchHasFocus = true; });
  searchInput.addEventListener("click", (e) => {
    e.stopPropagation();
    // Show popup when search input is clicked
    if (!isSearchActive) {
      startSearch();
    }
  });
  searchInput.addEventListener("blur", () => { searchHasFocus = false; });

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase();
    // Sync with popup input
    searchPopupInput.value = e.target.value;
    updateSearchPopupResults();
    focusedIndex = -1; // Reset focus on search change
    render();
    
    // Auto-scroll to first match
    if (searchQuery) {
      const firstMatchIndex = tabs.findIndex(t => isTabMatch(t, searchQuery));
      if (firstMatchIndex !== -1) {
        scrollActiveTabIntoView(true, firstMatchIndex);
      }
    }
  });

  function handleKeyDown(e) {
    // Ctrl+K to search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      startSearch();
      return;
    }

    // Esc to close search
    if (e.key === "Escape") {
      if (isSearchActive) {
        stopSearch();
      }
      return;
    }

    // Keyboard Nav (don't interfere if typing in search UNLESS it's enter/delete)
    const navigating = ["Enter", "Delete", "Backspace"].includes(e.key);
    if (!navigating && isSearchActive) return;

    // AI commands must be checked BEFORE filteredTabs guard — when user types
    // "> query", no tabs match the ">" character, causing early return otherwise.
    if (e.key === "Enter" && searchHasFocus) {
      if (searchInput.value.length > 0) {
        e.preventDefault();
 
        const commandText = searchInput.value.trim();
                
        // Clear input and disable BEFORE sending to prevent repeat fires
        searchInput.value = "";
        searchInput.disabled = true;

        safeSendMessage({ type: "AI_COMMAND", command: commandText }, (response) => {
          aiCommandInProgress = false; // Clear flag when done
          searchInput.disabled = false; // Re-enable
          searchInput.focus();

          if (response && response.awaitingConfirmation) {
            // Confirmation modal will be handled by CONFIRM_TOOL_CALL message
            // Wait for user to confirm or cancel
            return;
          }

          if (response && response.success) {
            if (typeof showToast !== 'undefined') showToast(response.message, "success");
          } else {
            if (typeof showToast !== 'undefined') showToast(response?.message || "Error", "error");
          }
        });
        return;
      }
      if (selectedTabIds.size > 1) {
        e.preventDefault();
        safeSendMessage({ type: "AI_EXTRACT", query: searchInput.value, tabIds: Array.from(selectedTabIds) });
        searchInput.value = "";
        searchInput.placeholder = "⏳ Extracting...";
        searchInput.disabled = true;
        setTimeout(() => { searchInput.disabled = false; searchInput.placeholder = "Search tabs..."; }, 8000);
        return;
      }
    }

    const filteredTabs = tabs.filter(t => isTabMatch(t, searchQuery));

    if (filteredTabs.length === 0) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIndex !== -1) {
        safeSendMessage({ type: "SWITCH_TAB", tabId: filteredTabs[focusedIndex].id });
        if (isSearchActive) stopSearch();
      }
    } else if (e.key === "Delete" || (e.altKey && e.key === "Backspace")) {
      e.preventDefault();
      if (focusedIndex !== -1) {
        const tabToClose = filteredTabs[focusedIndex];
        safeSendMessage({ type: "CLOSE_TAB", tabId: tabToClose.id });
        focusedIndex = Math.min(focusedIndex, filteredTabs.length - 2);
      }
    }
  }

  window.addEventListener("keydown", handleKeyDown, true);

  function scrollActiveTabIntoView(force = false, specificIndex = -1) {
    if (!force && !userSettings.autoScroll) return;
    
    let targetEl;
    if (specificIndex !== -1) {
      const tabId = tabs[specificIndex]?.id;
      targetEl = track.querySelector(`.ts-tab[data-tab-id="${tabId}"]`);
    } else {
      targetEl = track.querySelector(".ts-tab.active");
    }

    if (targetEl) {
      targetEl.scrollIntoView({
        inline: "center",
        behavior: "smooth",
        block: "nearest",
      });
    }
  }

  function showHoverCard(tab, el) {
    hoverCard.dataset.currentTabId = tab.id.toString();
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const barRect = trigger.getBoundingClientRect();

    const showMute = tab.audible || tab.muted;
    const muteIcon = tab.muted ? "🔇" : "🔊";
    const muteText = tab.muted ? "Unmute Tab" : "Mute Tab";

    // Glassmorphism card structure matching Stitch design
    hoverCard.innerHTML = `
      <div class="bg-surface-container-lowest border border-surface-variant rounded-xl p-3 flex flex-col gap-3 relative transition-all duration-200 shadow-[0_4px_12px_rgba(0,0,0,0.02)] min-w-[280px]">
        
        <div class="flex items-center gap-3 w-full group">
          <div class="w-8 h-8 rounded-md bg-white shadow-sm flex items-center justify-center flex-shrink-0 border border-surface-variant ts-hc-icon-container">
             <span class="ts-fallback text-on-surface font-bold">${(tab.title || "?")[0].toUpperCase()}</span>
          </div>
          <div class="flex-1 min-w-0">
             <h3 class="font-h2 text-body-md text-on-surface truncate">${tab.title || "Untitled"}</h3>
             <p class="font-body-sm text-body-sm text-outline truncate">${tab.url ? tab.url.replace(/^https?:\/\//, "").split("/")[0] : ""}</p>
          </div>
          <button class="w-6 h-6 rounded-full hover:bg-surface-variant text-outline hover:text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 bg-surface-container-low shadow-sm ts-close-hover" data-tab-id="${tab.id}">
             <span class="text-[16px] font-bold">&times;</span>
          </button>
        </div>

        ${tab.groupTitle ? `
        <div class="flex gap-1">
           <span class="bg-primary/10 text-primary font-label-caps text-[10px] px-2 py-0.5 rounded-full">${tab.groupTitle}</span>
        </div>` : ""}
        
        ${showMute ? `
        <div class="mt-2 border-t border-surface-variant pt-2">
          <button class="ts-hc-mute-btn flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-surface-variant text-on-surface text-sm transition-colors" data-tab-id="${tab.id}" data-muted="${tab.muted}">
             <span class="text-[16px]">${muteIcon}</span>
             <span>${muteText}</span>
          </button>
        </div>` : ""}
      </div>
    `;

    // The Close button listener
    const closeBtn = hoverCard.querySelector('.ts-close-hover');
    if (closeBtn) {
       closeBtn.addEventListener('click', (e) => {
         e.stopPropagation();
         safeSendMessage({ type: "CLOSE_TAB", tabId: tab.id });
         hideHoverCard();
       });
    }

    // Fetch thumbnail on-demand
    safeSendMessage({ type: "GET_THUMBNAIL", tabId: tab.id }, (response) => {
      if (response && response.dataUrl && hoverCard.dataset.currentTabId === tab.id.toString()) {
        const container = hoverCard.querySelector(".ts-hc-icon-container");
        if(container) {
           container.innerHTML = `<img class="w-6 h-6 object-cover rounded-sm" src="${response.dataUrl}" />`;
        }
      }
    });

    safeSendMessage({ type: "GET_AI_SUMMARY", tabId: tab.id }, (response) => {
      if (response && response.summary && hoverCard.dataset.currentTabId === tab.id.toString()) {
        const cardInner = hoverCard.firstElementChild;
        const summaryDiv = document.createElement("div");
        summaryDiv.className = "mt-2 pt-2 border-t border-surface-variant text-body-sm text-on-surface-variant italic font-body-sm opacity-90";
        summaryDiv.textContent = "✨ " + response.summary;
        cardInner.appendChild(summaryDiv);
      }
    });
    
    hoverCard.style.left = `${centerX}px`;

    // Position hover card below the bar (bar is always below Chrome tabs)
      const topPosition = barRect.bottom + 10;
      hoverCard.style.top = `${topPosition}px`;
      hoverCard.style.bottom = 'auto';

    hoverCard.style.pointerEvents = "auto";
    hoverCard.classList.add("visible");
  }

  function hideHoverCard() {
    hoverCard.classList.remove("visible");
  }

  function applyTheme(theme) {
    host.classList.remove("ts-theme-light", "ts-theme-dark");
    if (theme === "light") {
      host.classList.add("ts-theme-light");
    } else if (theme === "dark") {
      host.classList.add("ts-theme-dark");
    } else if (theme === "system") {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      host.classList.add(isDark ? "ts-theme-dark" : "ts-theme-light");
    }
  }

  // --- Settings Sync ---
  function updateSettings(changes) {
    if (changes.theme) {
      userSettings.theme = changes.theme.newValue;
      applyTheme(userSettings.theme);
    }
    if (changes.stripColor) {
      userSettings.stripColor = changes.stripColor.newValue;
      applyStripColor(userSettings.stripColor);
    }
    if (changes.displayMode) {
      userSettings.displayMode = changes.displayMode.newValue;
      if (userSettings.displayMode === 'always_show') {
        expandBar();
      } else {
        startHideTimer();
      }
    }
    if (changes.collapseDelay) {
      userSettings.collapseDelay = changes.collapseDelay.newValue;
    }
  }

  function applyStripColor(color) {
    if (color) {
      host.style.setProperty('--ts-bg', color);
      host.style.setProperty('--ts-bg-solid', color);
    } else {
      host.style.removeProperty('--ts-bg');
      host.style.removeProperty('--ts-bg-solid');
    }
  }

  function applyDockPosition(position) {
    // Bar is now permanently docked below Chrome tabs - position is fixed
    // dockPosition setting is deprecated for this layout
  }

  // Wrap storage change listener
  if (chrome.runtime?.id) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") {
          updateSettings(changes);
          // Sync Shield visibility in real-time
          if (changes.enableShield) {
            shieldBtn.style.display = changes.enableShield.newValue ? '' : 'none';
          }
        }
      });
    } catch (e) {
      console.warn('[TabScroller] Storage listener failed:', e.message);
    }
  }

  // Defer settings loading to the initialization promises block below to prevent visual flash

  function makeFallback(tab) {
    const fb = document.createElement("div");
    fb.className = "ts-fallback";
    if (tab.emoji) {
      fb.textContent = tab.emoji;
      fb.style.fontSize = "14px";
    } else {
      fb.textContent = (tab.title || "?")[0].toUpperCase();
      fb.style.fontSize = "";
    }
    return fb;
  }

  // ===== TOAST NOTIFICATION SYSTEM =====
  let undoAutoHideTimer = null;

  function showToast(message, type = 'info', duration = 4000) {
    // Remove existing toast
    const existing = shadow.querySelector('.ts-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `ts-toast ts-toast-${type}`;
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
      padding: 12px 24px; border-radius: 12px; font-size: 13px; font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      z-index: 10001; opacity: 0; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: auto; max-width: 90vw; text-align: center; white-space: nowrap;
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    `;

    switch (type) {
      case 'success':
        toast.style.background = 'rgba(34, 197, 94, 0.9)';
        toast.style.color = '#fff';
        toast.style.border = '1px solid rgba(34, 197, 94, 0.3)';
        break;
      case 'error':
        toast.style.background = 'rgba(239, 68, 68, 0.9)';
        toast.style.color = '#fff';
        toast.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        break;
      case 'warning':
        toast.style.background = 'rgba(245, 158, 11, 0.9)';
        toast.style.color = '#fff';
        toast.style.border = '1px solid rgba(245, 158, 11, 0.3)';
        break;
      default:
        toast.style.background = 'rgba(30, 30, 30, 0.9)';
        toast.style.color = '#fff';
        toast.style.border = '1px solid rgba(255, 255, 255, 0.1)';
    }

    toast.textContent = message;
    shadow.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);

    return toast;
  }

  // ===== CLARIFICATION MODAL (§5) =====
  function showClarificationModal(data) {
    const modal = document.createElement("div");
    modal.className = "ts-clarify-modal";
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      z-index: 10000; opacity: 0; transition: opacity 0.2s ease;
      pointer-events: none;
    `;

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px);
    `;
    modal.appendChild(overlay);

    const content = document.createElement("div");
    content.style.cssText = `
      position: relative; background: var(--ts-bg, #222); padding: 24px;
      border-radius: 12px; max-width: 420px; width: 90%;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1);
      color: var(--ts-text, #fff); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const question = document.createElement("h3");
    question.textContent = data.question || "Which tabs do you mean?";
    question.style.cssText = "margin: 0 0 16px 0; font-size: 16px; font-weight: 600;";
    content.appendChild(question);

    const optionsList = document.createElement("div");
    optionsList.style.cssText = "display: flex; flex-direction: column; gap: 8px;";

    (data.options || []).forEach((option) => {
      const btn = document.createElement("button");
      btn.textContent = option.label;
      btn.style.cssText = `
        padding: 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;
        font-size: 14px; text-align: left; transition: background 0.15s ease;
      `;
      btn.addEventListener("mouseenter", () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
      btn.addEventListener("mouseleave", () => { btn.style.background = 'rgba(255,255,255,0.05)'; });
      btn.addEventListener("click", () => close(option));
      optionsList.appendChild(btn);
    });

    content.appendChild(optionsList);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
      width: 100%; margin-top: 12px; padding: 10px 16px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.2); background: transparent;
      color: inherit; cursor: pointer; font-size: 14px; opacity: 0.7;
    `;
    cancelBtn.addEventListener("click", () => close(null));
    content.appendChild(cancelBtn);

    modal.appendChild(content);
    shadow.appendChild(modal);

    requestAnimationFrame(() => {
      modal.style.opacity = "1";
      modal.style.pointerEvents = "auto";
    });

    function close(selectedOption) {
      modal.style.opacity = "0";
      modal.style.pointerEvents = "none";
      setTimeout(() => modal.remove(), 200);

      if (selectedOption) {
        safeSendMessage({
          type: "CLARIFICATION_RESPONSE",
          functionCall: data.functionCall,
          selectedOption: selectedOption.value || selectedOption
        }, (response) => {
          if (response && response.success) {
            showToast(response.message, "success");
          } else {
            showToast(response?.message || "Error", "error");
          }
        });
      }
    }

    overlay.addEventListener("click", () => close(null));
  }

  // --- Smooth momentum scrolling ---
  let scrollVelocity = 0;
  let scrollAnimFrame = null;

  function animateScroll() {
    if (Math.abs(scrollVelocity) < 0.5) {
      scrollVelocity = 0;
      scrollAnimFrame = null;
      return;
    }
    track.scrollLeft += scrollVelocity;
    scrollVelocity *= 0.92; // friction
    scrollAnimFrame = requestAnimationFrame(animateScroll);
  }

  trigger.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      scrollVelocity += e.deltaY > 0 ? 15 : -15;
      // Clamp velocity
      scrollVelocity = Math.max(-80, Math.min(80, scrollVelocity));
      if (!scrollAnimFrame) {
        scrollAnimFrame = requestAnimationFrame(animateScroll);
      }
    },
    { passive: false }
  );

  // Bar is always visible — no hover expand/collapse needed.

  // --- Task 5: AI Insight Prefetching ---
  let prefetchTimer = null;

  function getVisibleTabIdsForPrefetch(limit = 20) {
    const ids = [];
    const trackRect = track.getBoundingClientRect();
    const tabEls = Array.from(track.querySelectorAll('.ts-tab'));

    for (const el of tabEls) {
      const rect = el.getBoundingClientRect();
      const visible = rect.right >= trackRect.left && rect.left <= trackRect.right;
      if (!visible) continue;

      const id = parseInt(el.dataset.tabId, 10);
      if (!Number.isNaN(id)) ids.push(id);
      if (ids.length >= limit) break;
    }

    return ids;
  }

  function scheduleVisibleInsightsPrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      safeStorageGet({ aiInsightBatchSize: 20, enableAi: false }, (items) => {
        if (!items.enableAi) return;
        const ids = getVisibleTabIdsForPrefetch(items.aiInsightBatchSize || 20);
        if (ids.length === 0) return;
        safeSendMessage({ type: 'PREFETCH_TAB_INSIGHTS', tabIds: ids });
      });
    }, 350);
  }

  // --- Initialization: wait for CSS, initial tabs AND settings before showing ---
  const tabsPromise = new Promise((resolve) => {
    safeSendMessage({ type: "GET_TABS" }, (response) => {
      if (response && response.tabs) {
        tabs = response.tabs;
      }
      resolve();
    });
  });

  const settingsPromise = new Promise((resolve) => {
    safeStorageGet({ autoScroll: true, theme: 'system', displayMode: 'always_show', collapseDelay: 1500, enableShield: false, dockPosition: 'bottom', stripColor: '' }, (items) => {
      userSettings = items;
      applyTheme(userSettings.theme);
      applyStripColor(userSettings.stripColor);
      applyDockPosition(userSettings.dockPosition || 'bottom');
      shieldBtn.style.display = items.enableShield ? '' : 'none';
      // Update pin button state
      pinBtn.style.opacity = items.displayMode === 'always_show' ? '1' : '0.4';
      
      // Determine initial collapse state dynamically
      if (items.displayMode === 'always_show') {
        isCollapsed = false;
        trigger.classList.remove("collapsed");
      } else {
        isCollapsed = true;
        trigger.classList.add("collapsed");
      }
      resolve();
    });
  });

  Promise.all([cssPromise, tabsPromise, settingsPromise]).then(() => {
    document.documentElement.appendChild(host);
    render();
    
    // Initialize AI Command interface
    initializeCommandInterface();
    
    // Apply correct bar collapse and body push states immediately
    if (userSettings.displayMode === 'always_show') {
      isCollapsed = false;
      trigger.classList.remove("collapsed");
      if (pageReady) {
        applyFullPush();
      }
    } else {
      isCollapsed = true;
      trigger.classList.add("collapsed");
      removeFullPush();
    }
  });

  // --- Listen for live updates ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Handle case where extension context is invalidated
    if (!chrome.runtime?.id) {
      return false;
    }
    
    try {
      if (msg.type === 'FALLBACK_NOTIFICATION') {
        if (typeof showToast !== 'undefined') {
          showToast(
            `⚠️ ${msg.fromModel} rate-limited. Using ${msg.toModel}`,
            'warning'
          );
        }
      } else if (msg.type === 'ALL_MODELS_FAILED') {
        if (typeof showToast !== 'undefined') {
          showToast(
            `❌ All AI models rate-limited (tried ${msg.attemptCount}). Wait a few minutes.`,
            'error'
          );
        }
      } else if (msg.type === "TABS_UPDATED") {
      tabs = msg.tabs;
      render();
    } else if (msg.type === "DECLUTTER_RESULTS") {
      if (msg.tabIds && msg.tabIds.length > 0) {
        msg.tabIds.forEach(id => suggestedCloseIds.add(id));
        render();
      }
    } else if (msg.type === "AI_EXTRACT_RESULT") {
      if (msg.result && msg.result.startsWith("Error")) {
        searchInput.value = "Error: extraction failed";
        setTimeout(() => { searchInput.value = ""; searchInput.placeholder = "Search tabs..."; }, 2000);
      } else if (msg.result) {
        navigator.clipboard.writeText(msg.result).then(() => {
          searchInput.placeholder = "Search tabs...";
          searchInput.value = "Copied!";
          setTimeout(() => { searchInput.value = ""; }, 2000);
        });
      }
      selectedTabIds.clear();
      render();
    } else if (msg.type === "AI_WORKSPACE_DONE") {
      searchInput.disabled = false;
      searchInput.value = "";
      if (msg.error) {
        searchInput.placeholder = "⚠️ " + msg.error;
      } else {
        searchInput.placeholder = "✅ Workspace ready!";
      }
      setTimeout(() => { searchInput.placeholder = "Search tabs..."; }, 3000);
      if (isSearchActive) stopSearch();
    } else if (msg.type === "QUARANTINE_TAB") {
      quarantinedTabIds.add(msg.tabId);
      render();
    } else if (msg.type === "TOGGLE_SCROLLER") {
      // Toggle collapse state
      toggleCollapse();
    } else if (msg.type === "CONFIRM_TOOL_CALL") {
      (async () => {
        const confirmed = await showConfirmationModal(msg);
        if (confirmed) {
          safeSendMessage({
            type: "EXECUTE_CONFIRMED_TOOL_CALL",
            functionCall: msg.functionCall
          }, (response) => {
            if (response && response.success) {
              if (typeof showToast !== 'undefined') showToast(response.message, "success");
              // Clear search and reset UI if successful
              searchInput.value = "";
              render();
            } else {
              if (typeof showToast !== 'undefined') showToast(response?.message || "Error", "error");
            }
          });
        }
      })();
    } else if (msg.type === "UNDO_AVAILABLE") {
      undoBtn.style.display = "";
      undoBtn.title = `Undo: ${msg.action} (${msg.count} tabs)`;
      showToast(msg.message, "success", 5000);
      // Auto-hide undo button after 15 seconds
      clearTimeout(undoAutoHideTimer);
      undoAutoHideTimer = setTimeout(() => { undoBtn.style.display = "none"; }, 15000);
    } else if (msg.type === "CLARIFICATION_NEEDED") {
      showClarificationModal(msg);
    } else if (msg.type === "PREVIEW_PLAN") {
      (async () => {
        const checkedTabIds = await showPlanPreviewModal(msg);
        if (checkedTabIds && checkedTabIds.length > 0) {
          safeSendMessage({
            type: "EXECUTE_PLAN",
            planId: msg.planId,
            checkedTabIds: checkedTabIds
          }, (response) => {
            if (response && response.success) {
              if (typeof showToast !== 'undefined') showToast(response.message, "success");
            } else {
              if (typeof showToast !== 'undefined') showToast(response?.message || "Error", "error");
            }
          });
        } else {
          if (typeof showToast !== 'undefined') showToast("Action cancelled", "info");
        }
      })();
    }
  } catch (e) {
    // Extension context may have been invalidated
      console.warn('[TabScroller] Message handler error:', e.message);
    }
  });

  // ===== CONFIRMATION MODAL =====
  function showConfirmationModal(data) {
    const modal = document.createElement("div");
    modal.className = "ts-confirm-modal";
    
    // Add missing CSS for modal inline to avoid relying on external CSS
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      z-index: 10000; opacity: 0; transition: opacity 0.2s ease;
      pointer-events: none;
    `;
    
    const overlay = document.createElement("div");
    overlay.className = "ts-modal-overlay";
    overlay.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px);
    `;
    modal.appendChild(overlay);
    
    const content = document.createElement("div");
    content.className = "ts-modal-content";
    content.style.cssText = `
      position: relative; background: var(--ts-bg, #222); padding: 24px;
      border-radius: 12px; max-width: 400px; width: 90%; text-align: center;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1);
      color: var(--ts-text, #fff); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    
    const title = document.createElement("h3");
    title.textContent = data.message;
    title.style.cssText = "margin: 0 0 12px 0; font-size: 18px; font-weight: 600;";
    content.appendChild(title);
    
    const details = document.createElement("p");
    details.textContent = data.details || "";
    details.style.cssText = "margin: 0 0 24px 0; font-size: 14px; opacity: 0.8; line-height: 1.5; color: var(--ts-text-dim, #aaa);";
    content.appendChild(details);
    
    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; gap: 12px; justify-content: center;";
    
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
      flex: 1; padding: 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2);
      background: transparent; color: inherit; cursor: pointer; font-size: 14px; font-weight: 500;
    `;
    buttons.appendChild(cancelBtn);
    
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm";
    confirmBtn.style.cssText = `
      flex: 1; padding: 10px 16px; border-radius: 8px; border: none;
      background: var(--ts-accent, #0078d7); color: white; cursor: pointer; font-size: 14px; font-weight: 500;
    `;
    buttons.appendChild(confirmBtn);
    
    content.appendChild(buttons);
    modal.appendChild(content);
    shadow.appendChild(modal);
    
    requestAnimationFrame(() => {
      modal.style.opacity = "1";
      modal.style.pointerEvents = "auto";
    });
    
    return new Promise((resolve) => {
      const close = (result) => {
        modal.style.opacity = "0";
        modal.style.pointerEvents = "none";
        setTimeout(() => modal.remove(), 200);
        resolve(result);
      };
      
      confirmBtn.onclick = () => close(true);
      cancelBtn.onclick = () => close(false);
      overlay.onclick = () => close(false);
    });
  }

  function refreshTabs() {
    safeSendMessage({ type: "GET_TABS" }, (response) => {
      if (response && response.tabs) {
        tabs = response.tabs;
        render();
      }
    });
  }

  function performPurgeAnimation() {
    const urlMap = new Map();
    tabs.forEach(tab => {
      if (!tab.url) return;
      if (!urlMap.has(tab.url)) urlMap.set(tab.url, []);
      urlMap.get(tab.url).push(tab);
    });

    urlMap.forEach(instances => {
      if (instances.length > 1) {
        const activeInstance = instances.find(inst => inst.active);
        const keepTabId = activeInstance ? activeInstance.id : instances.sort((a,b) => a.index - b.index)[0].id;
        
        instances.forEach(inst => {
          if (inst.id !== keepTabId) {
            const el = track.querySelector(`[data-tab-id="${inst.id}"]`);
            if (el) el.classList.add("purging");
          }
        });
      }
    });
  }


  // --- Resync if tab becomes visible (handles inactive tab staleness) ---
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      safeSendMessage({ type: "GET_TABS" }, (response) => {
        if (response && response.tabs) {
          tabs = response.tabs;
          render();
        }
      });
    }
  });

  // ===== COMMAND INPUT COMPONENT =====
  function createCommandInput() {
    const button = document.createElement("div");
    button.className = "ts-ai-btn";
    button.title = "Ask AI anything (Ctrl+Shift+K)";
    button.tabIndex = 0;
    button.innerHTML = '<span class="ts-ai-btn-icon">🤖</span><span class="ts-ai-btn-label">AI</span>';

    const panel = document.createElement("div");
    panel.className = "ts-ai-popup";
    panel.innerHTML = `
      <div class="ts-ai-popup-header">
        <span class="ts-command-icon">🤖</span>
        <input type="text" class="ts-command-input" placeholder="Ask AI anything..." spellcheck="false" autocomplete="off">
        <span class="ts-ai-popup-close">✕</span>
      </div>
      <div class="ts-ai-popup-body">
        <div class="ts-suggestions-title">💡 Try these commands:</div>
        <div class="ts-ai-suggestions"></div>
      </div>
      <div class="ts-ai-popup-footer">Enter to run · ↑↓ for history · Esc to close</div>
    `;
    trigger.appendChild(panel);

    const anchorPanel = () => {
      panel.style.left = (button.offsetLeft || 0) + 'px';
    };

    const input = panel.querySelector(".ts-command-input");
    const closeBtn = panel.querySelector(".ts-ai-popup-close");
    const suggestionsEl = panel.querySelector(".ts-ai-suggestions");

    COMMAND_EXAMPLES.forEach(example => {
      const item = document.createElement("div");
      item.className = "ts-suggestion-item";
      item.textContent = example;
      item.addEventListener("click", () => {
        input.value = example;
        executeAICommand(example);
      });
      suggestionsEl.appendChild(item);
    });

    function openPanel() {
      anchorPanel();
      aiPanelOpen = true;
      clearTimeout(hideTimeout);
      if (userSettings.displayMode === 'auto_hide' && isCollapsed) {
        expandBar();
      }
      panel.classList.add("open");
      button.classList.add("active");
      input.focus();
    }

    function closePanel() {
      aiPanelOpen = false;
      panel.classList.remove("open");
      button.classList.remove("active");
      input.blur();
      if (userSettings.displayMode === 'auto_hide' && !isSearchActive) {
        startHideTimer();
      }
    }

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.classList.contains("open")) {
        closePanel();
      } else {
        openPanel();
      }
    });
    button.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
      }
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel();
    });

    // Prevent clicks inside the panel from bubbling out of the closed shadow
    // root (events retarget to the host there, which the outside-click
    // handler below would otherwise treat as "outside" and close the panel).
    panel.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    document.addEventListener("click", (e) => {
      if (!panel.classList.contains("open")) return;
      if (panel.contains(e.target) || button.contains(e.target)) return;
      closePanel();
    });

    // Command history
    let commandHistory = [];
    let historyIndex = -1;

    // Load history from storage
    chrome.storage.local.get({ commandHistory: [] }, (items) => {
      commandHistory = items.commandHistory || [];
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const command = input.value.trim();
        if (command) {
          executeAICommand(command);

          // Save to history
          commandHistory.unshift(command);
          if (commandHistory.length > 50) commandHistory.pop();
          chrome.storage.local.set({ commandHistory });
          historyIndex = -1;
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          input.value = commandHistory[historyIndex];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex--;
          input.value = commandHistory[historyIndex];
        } else {
          historyIndex = -1;
          input.value = "";
        }
      } else if (e.key === "Escape") {
        e.stopPropagation();
        closePanel();
      }
    });

    return { container: button, panel, input, openPanel, closePanel };
  }

  // ===== COMMAND EXECUTION =====
  async function executeAICommand(command) {
    if (!commandInputComponents) return;
    const { input } = commandInputComponents;
    
    if (aiCommandInProgressInUI) {
      console.log('[AI UI] Command already in progress, ignoring');
      return;
    }
    
    aiCommandInProgressInUI = true;

    // Show loading state
    input.value = "";
    input.placeholder = "⏳ Processing...";
    input.disabled = true;
    
    try {
      const response = await new Promise((resolve, reject) => {
        safeSendMessage({ 
          type: "AI_COMMAND", 
          command 
        }, (resp) => {
          if (!resp) {
            reject(new Error("No response from background script"));
          } else {
            resolve(resp);
          }
        });
      });
      
      console.log('[AI Command] Response:', response);
      
      if (response.awaitingConfirmation) {
        // Confirmation will be handled by CONFIRM_TOOL_CALL message
        return;
      }
      
      if (response.success) {
        showToast(response.message, "success");
        
        // Show analysis results if present
        if (response.analysis) {
          showAnalysisModal(response.analysis);
        }
      } else {
        showToast(response.message || "Command failed", "error");
      }
    } catch (error) {
      console.error('[AI Command] Error:', error);
      showToast("Error: " + error.message, "error");
    } finally {
      aiCommandInProgressInUI = false;
      input.disabled = false;
      input.placeholder = "Ask AI anything...";
      input.focus();
    }
  }

  // ===== ANALYSIS RESULTS MODAL =====
  function showAnalysisModal(analysis) {
    const modal = document.createElement("div");
    modal.className = "ts-analysis-modal";
    
    const overlay = document.createElement("div");
    overlay.className = "ts-modal-overlay";
    modal.appendChild(overlay);
    
    const content = document.createElement("div");
    content.className = "ts-modal-content ts-modal-analysis";
    
    const title = document.createElement("h3");
    title.textContent = "📊 Tab Analysis";
    content.appendChild(title);
    
    const pre = document.createElement("pre");
    pre.className = "ts-analysis-results";
    pre.textContent = JSON.stringify(analysis, null, 2);
    content.appendChild(pre);
    
    const closeBtn = document.createElement("button");
    closeBtn.className = "ts-btn ts-btn-primary";
    closeBtn.textContent = "Close";
    closeBtn.onclick = () => {
      modal.classList.remove("visible");
      setTimeout(() => modal.remove(), 300);
    };
    content.appendChild(closeBtn);
    
    modal.appendChild(content);
    shadow.appendChild(modal);
    
    requestAnimationFrame(() => {
      modal.classList.add("visible");
    });
    
    overlay.onclick = closeBtn.onclick;
  }

  // ===== COMMAND SUGGESTIONS =====
  const COMMAND_EXAMPLES = [
    "Close all YouTube tabs",
    "Group all GitHub tabs",
    "Bookmark all docs to 'Resources'",
    "Mute all tabs",
    "Pin all Google Docs",
    "Reload all GitHub tabs",
    "Sort tabs by domain",
    "Find duplicate tabs",
    "Show tab summary",
    "Close inactive tabs"
  ];

  // ===== PLAN PREVIEW MODAL =====
  function showPlanPreviewModal(data) {
    const modal = document.createElement("div");
    modal.className = "ts-preview-modal";
    
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      .ts-preview-modal {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        z-index: 10002; opacity: 0; transition: opacity 0.2s ease;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .ts-preview-modal.visible {
        opacity: 1;
        pointer-events: auto;
      }
      .ts-modal-overlay {
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px);
      }
      .ts-preview-content {
        position: relative; background: #1e1e1e; padding: 24px;
        border-radius: 16px; max-width: 500px; width: 90%; max-height: 85vh;
        display: flex; flex-direction: column;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1);
        color: #ffffff;
      }
      .ts-preview-header {
        margin-bottom: 16px;
      }
      .ts-preview-title {
        margin: 0; font-size: 20px; font-weight: 600; color: #ffffff;
        display: flex; align-items: center; gap: 8px;
      }
      .ts-preview-subtitle {
        margin: 4px 0 0 0; font-size: 13px; color: #aaaaaa;
        display: flex; justify-content: space-between;
      }
      .ts-preview-confidence {
        font-weight: 600;
        color: #0078d7;
      }
      .ts-preview-list-header {
        display: flex; align-items: center; padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        font-size: 12px; color: #aaaaaa;
        gap: 8px;
      }
      .ts-preview-list {
        overflow-y: auto; max-height: 40vh; margin-bottom: 20px;
        border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
        background: rgba(0, 0, 0, 0.2);
      }
      .ts-preview-item {
        display: flex; align-items: center; padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        gap: 12px; transition: background 0.15s ease;
      }
      .ts-preview-item:last-child {
        border-bottom: none;
      }
      .ts-preview-item:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      .ts-preview-checkbox {
        cursor: pointer; width: 16px; height: 16px; accent-color: #0078d7;
      }
      .ts-preview-favicon {
        width: 18px; height: 18px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
        background: rgba(255,255,255,0.1); font-size: 10px; font-weight: bold; flex-shrink: 0;
      }
      .ts-preview-item-info {
        flex: 1; min-w: 0; display: flex; flex-direction: column; gap: 2px;
      }
      .ts-preview-item-title {
        font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #eeeeee;
      }
      .ts-preview-item-reason {
        font-size: 11px; color: #888888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ts-preview-buttons {
        display: flex; gap: 12px; justify-content: flex-end; margin-top: auto;
      }
      .ts-preview-btn {
        padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;
      }
      .ts-preview-btn-cancel {
        background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #ffffff;
      }
      .ts-preview-btn-cancel:hover {
        background: rgba(255,255,255,0.05);
      }
      .ts-preview-btn-confirm {
        background: #0078d7; border: none; color: #ffffff;
      }
      .ts-preview-btn-confirm:hover {
        background: #0063b1;
      }
    `;
    modal.appendChild(styleEl);

    const overlay = document.createElement("div");
    overlay.className = "ts-modal-overlay";
    modal.appendChild(overlay);

    const content = document.createElement("div");
    content.className = "ts-preview-content";

    const header = document.createElement("div");
    header.className = "ts-preview-header";

    const titleMap = {
      close_tabs: "Close Tabs",
      group_tabs: "Group Tabs",
      bookmark_tabs: "Bookmark Tabs",
      pin_tabs: "Pin Tabs",
      unpin_tabs: "Unpin Tabs",
      mute_tabs: "Mute Tabs",
      unmute_tabs: "Unmute Tabs",
      reload_tabs: "Reload Tabs"
    };

    const actionTitle = titleMap[data.plan.intent] || "Tab Action Plan";

    const title = document.createElement("h3");
    title.className = "ts-preview-title";
    title.textContent = `🤖 AI Plan: ${actionTitle}`;
    header.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "ts-preview-subtitle";
    
    const confidencePct = Math.round((data.plan.confidence || 0) * 100);
    const pathStr = data.plan.path === 'semantic' ? 'semantic agent' : 'syntactic rules';
    subtitle.innerHTML = `
      <span>Path: <strong>${pathStr}</strong></span>
      <span>Confidence: <strong class="ts-preview-confidence">${confidencePct}%</strong></span>
    `;
    header.appendChild(subtitle);
    content.appendChild(header);

    // List header with Select All
    const listHeader = document.createElement("div");
    listHeader.className = "ts-preview-list-header";

    const selectAllCheckbox = document.createElement("input");
    selectAllCheckbox.type = "checkbox";
    selectAllCheckbox.className = "ts-preview-checkbox";
    selectAllCheckbox.checked = true;
    listHeader.appendChild(selectAllCheckbox);

    const selectAllLabel = document.createElement("span");
    selectAllLabel.textContent = "Select All Target Tabs";
    selectAllLabel.style.cursor = "pointer";
    selectAllLabel.onclick = () => {
      selectAllCheckbox.checked = !selectAllCheckbox.checked;
      selectAllCheckbox.dispatchEvent(new Event("change"));
    };
    listHeader.appendChild(selectAllLabel);
    content.appendChild(listHeader);

    const list = document.createElement("div");
    list.className = "ts-preview-list";

    const itemCheckboxes = [];

    const planTabIds = data.plan.tabIds || [];
    const uncertainTabIds = data.plan.uncertain || [];
    const allTargetIds = [...planTabIds, ...uncertainTabIds];

    allTargetIds.forEach(id => {
      const details = data.tabDetails[id] || { title: "Untitled Tab", favIconUrl: "", reason: "Match" };
      const isUncertain = uncertainTabIds.includes(id);

      const item = document.createElement("div");
      item.className = "ts-preview-item";
      if (isUncertain) {
        item.style.borderLeft = "3px solid #f59e0b"; // Warning accent for low confidence
      }

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "ts-preview-checkbox";
      cb.checked = !isUncertain; // Check high confidence by default, uncheck uncertain
      cb.dataset.tabId = id;
      item.appendChild(cb);
      itemCheckboxes.push(cb);

      // Favicon
      if (details.favIconUrl) {
        const img = document.createElement("img");
        img.className = "ts-preview-favicon";
        img.src = details.favIconUrl;
        img.onerror = () => {
          img.replaceWith(makeFbFallback(details));
        };
        item.appendChild(img);
      } else {
        item.appendChild(makeFbFallback(details));
      }

      // Title & Reason info
      const info = document.createElement("div");
      info.className = "ts-preview-item-info";

      const itemTitle = document.createElement("span");
      itemTitle.className = "ts-preview-item-title";
      itemTitle.textContent = details.title;
      info.appendChild(itemTitle);

      const itemReason = document.createElement("span");
      itemReason.className = "ts-preview-item-reason";
      itemReason.textContent = (isUncertain ? "[Uncertain] " : "") + (details.reason || "Matched");
      info.appendChild(itemReason);

      item.appendChild(info);
      list.appendChild(item);
    });

    content.appendChild(list);

    // Update Confirm Button Label based on checked count
    const updateConfirmLabel = () => {
      const checkedCount = itemCheckboxes.filter(c => c.checked).length;
      confirmBtn.textContent = `Confirm (${checkedCount})`;
      confirmBtn.disabled = checkedCount === 0;
      confirmBtn.style.opacity = checkedCount === 0 ? "0.5" : "1";
    };

    selectAllCheckbox.onchange = () => {
      itemCheckboxes.forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
      });
      updateConfirmLabel();
    };

    itemCheckboxes.forEach(cb => {
      cb.onchange = () => {
        const checkedCount = itemCheckboxes.filter(c => c.checked).length;
        selectAllCheckbox.checked = checkedCount === itemCheckboxes.length;
        selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < itemCheckboxes.length;
        updateConfirmLabel();
      };
    });

    const buttons = document.createElement("div");
    buttons.className = "ts-preview-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ts-preview-btn ts-preview-btn-cancel";
    cancelBtn.textContent = "Cancel";
    buttons.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "ts-preview-btn ts-preview-btn-confirm";
    buttons.appendChild(confirmBtn);

    content.appendChild(buttons);
    modal.appendChild(content);
    shadow.appendChild(modal);

    updateConfirmLabel();

    requestAnimationFrame(() => {
      modal.classList.add("visible");
    });

    function makeFbFallback(details) {
      const fb = document.createElement("div");
      fb.className = "ts-preview-favicon";
      fb.textContent = (details.title || "?")[0].toUpperCase();
      return fb;
    }

    return new Promise((resolve) => {
      const close = (result) => {
        modal.classList.remove("visible");
        setTimeout(() => modal.remove(), 200);
        resolve(result);
      };

      confirmBtn.onclick = () => {
        const checkedIds = itemCheckboxes.filter(c => c.checked).map(c => Number(c.dataset.tabId));
        close(checkedIds);
      };

      cancelBtn.onclick = () => close(null);
      overlay.onclick = () => close(null);
    });
  }

  // ===== INITIALIZATION =====
  let commandInputComponents = null;
  let aiCommandInProgressInUI = false;

  function initializeCommandInterface() {
    commandInputComponents = createCommandInput();
    
    // Insert after the center button, before the search container
    trigger.insertBefore(commandInputComponents.container, searchContainer);

    // Keyboard shortcut for Ctrl+Shift+K
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        commandInputComponents.openPanel();
      }
    }, true);
  }
})();
