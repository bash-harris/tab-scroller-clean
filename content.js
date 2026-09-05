// content.js
// Injects the tab scroller micro-bar into the page using Shadow DOM.

(function () {
  "use strict";

  // Guard: Check if extension context is still valid for THIS instance.
  if (!chrome.runtime?.id) {
    console.warn('[TabScroller] Extension context invalidated, skipping initialization');
    return;
  }

  // Prevent double injection — but distinguish a LIVE owner from a STALE orphan.
  //
  // When the extension is reloaded, the previous content script's chrome.* bindings
  // die, yet its DOM host (#tab-scroller-host) lingers in the page. Chrome then injects
  // a fresh content script (via injectContentScriptIntoAllTabs), which used to bail here
  // on the mere presence of that host — leaving the dead instance's empty strip on screen
  // with no way to fetch tabs (no error, no tabs, nothing driving indexing). We now treat
  // the host as "owned" only if it carries a recent heartbeat (written every 2s, gated on
  // a live context — see below). A missing/stale heartbeat means the owner is gone, so we
  // evict the orphan and take over.
  {
    const existingHost = document.getElementById("tab-scroller-host");
    if (existingHost) {
      const hb = Number(existingHost.dataset.tsHeartbeat || 0);
      if (hb && (Date.now() - hb) < 6000) {
        // A live instance already owns this frame — stand down.
        return;
      }
      // Stale orphan from a reloaded/invalidated context — clear it and take over.
      // console.log (not warn): this is normal recovery, not a problem.
      console.log('[TabScroller] Replacing stale strip');
      try { existingHost.remove(); } catch (e) {}
      // Drop the leftover page-push <style> too, so we don't stack two copies.
      // (literal kept in sync with STYLE_ID defined below.)
      try { const s = document.getElementById('tab-scroller-page-push'); if (s) s.remove(); } catch (e) {}
    }
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
    // ANIMATE THE PUSH, DO NOT SNAP IT.
    //
    // The padding is applied ~500ms after load, so with no transition the whole
    // page jumped 36px in one frame -- reading as a glitch rather than as a bar
    // appearing. A short ease on padding-top alone makes it a deliberate reveal.
    //
    // Only padding-top is transitioned. A bare `transition: all` on <html> would
    // animate every inherited property change on the page for the rest of the
    // session, which is both a performance problem and a source of bizarre
    // side-effects on SPAs.
    //
    // prefers-reduced-motion is honoured: users who ask for no animation get the
    // instant jump, which is the correct trade for them.
    return `
      html {
        padding-top: ${PUSH_HEIGHT}px !important;
        transition: padding-top 220ms cubic-bezier(0.22, 0.61, 0.36, 1) !important;
      }
      @media (prefers-reduced-motion: reduce) {
        html { transition: none !important; }
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
        // Match the <html> padding transition so headers glide with the page
        // instead of teleporting while the body animates around them. Without
        // this the two move on different schedules, which looks worse than
        // either moving alone.
        const savedTrans = el.style.getPropertyValue('transition');
        if (!savedTrans) {
          el.style.setProperty('transition', 'top 220ms cubic-bezier(0.22, 0.61, 0.36, 1)');
        }
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

  // Heartbeat: mark this host as owned by a LIVE instance. The double-injection guard
  // (top of file) reads this to tell a real owner from a stale orphan left by an extension
  // reload. Gated on chrome.runtime?.id, so a dead context stops refreshing it — the stamp
  // goes stale within ~6s and the next injected instance evicts this host and takes over.
  host.dataset.tsHeartbeat = String(Date.now());
  setInterval(() => {
    if (!chrome.runtime?.id) return;
    host.dataset.tsHeartbeat = String(Date.now());
  }, 2000);

  // --- Inject CSS ---
  // Critical CSS, applied SYNCHRONOUSLY. content.css is fetched async below, so
  // without this the host spends a frame as a default-flow <div> and its shadow
  // children render *in the page* before snapping to the strip (the "elements
  // leak onto the page on refresh" bug). Mirroring the :host positioning here —
  // plus visibility:hidden — means the overlay is fixed-positioned and unpainted
  // until the full sheet (which has no visibility rule) replaces this text.
  const CRITICAL_CSS =
    ":host{all:initial;display:block;position:fixed;top:0;left:0;right:0;" +
    "width:100%;z-index:2147483647;pointer-events:none;visibility:hidden}";
  const style = document.createElement("style");
  style.textContent = CRITICAL_CSS;
  const cssPromise = fetch(chrome.runtime.getURL("content.css"))
    .then((r) => r.text())
    .then((css) => {
      // Rewrite the __TS_EXT__ placeholder in @font-face url()s to the extension
      // origin. The shadow root has no <base>, so relative urls would resolve
      // against the host page and 404. getURL("") ends in "/", so the CSS keeps
      // the "fonts/..." path directly after the token.
      style.textContent = css.replace(/__TS_EXT__/g, chrome.runtime.getURL(""));
    })
    .catch(() => {
      // A local extension resource fetch should never fail; if it somehow does,
      // reveal a correctly-positioned (if unstyled) strip rather than leave the
      // whole overlay invisible forever.
      style.textContent = CRITICAL_CSS.replace(";visibility:hidden", "");
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

  // --- Live Indexing Progress Bar (Overlays / Sits in the Tab Strip) ---
  const indexingBar = document.createElement("div");
  indexingBar.className = "ts-indexing-bar";
  indexingBar.innerHTML = `
    <div class="ts-indexing-inner">
      <div class="ts-indexing-icon">⚡</div>
      <div class="ts-indexing-info">
        <span class="ts-indexing-label">Indexing tabs...</span>
        <span class="ts-indexing-counter">0 / 0</span>
      </div>
      <div class="ts-indexing-track">
        <div class="ts-indexing-fill"></div>
      </div>
      <div class="ts-indexing-pct">0%</div>
    </div>
  `;
  trigger.appendChild(indexingBar);

  let indexingHideTimeout = null;
  let _isIndexingActive = false;

  function updateIndexingUI(data) {
    if (!data) return;
    const { isIndexing, done, total, pct, currentTitle } = data;
    
    if (isIndexing && total > 0) {
      _isIndexingActive = true;
      if (typeof expandBar === 'function') expandBar();
      clearTimeout(indexingHideTimeout);
      indexingBar.classList.add("visible");
      
      const fill = indexingBar.querySelector(".ts-indexing-fill");
      const label = indexingBar.querySelector(".ts-indexing-label");
      const counter = indexingBar.querySelector(".ts-indexing-counter");
      const pctEl = indexingBar.querySelector(".ts-indexing-pct");

      const percentage = Math.min(100, Math.max(0, pct || Math.round((done / total) * 100)));
      if (fill) fill.style.width = `${percentage}%`;
      if (pctEl) pctEl.textContent = `${percentage}%`;
      if (counter) counter.textContent = `${done} / ${total}`;

      if (label) {
        if (currentTitle) {
          label.textContent = `Indexing: ${currentTitle.slice(0, 28)}${currentTitle.length > 28 ? '...' : ''}`;
        } else {
          label.textContent = "Indexing tabs for search...";
        }
      }
    } else if (pct === 100 || !isIndexing) {
      _isIndexingActive = false;
      if (indexingBar.classList.contains("visible")) {
        const fill = indexingBar.querySelector(".ts-indexing-fill");
        const label = indexingBar.querySelector(".ts-indexing-label");
        const pctEl = indexingBar.querySelector(".ts-indexing-pct");
        
        if (fill) fill.style.width = "100%";
        if (pctEl) pctEl.textContent = "100%";
        if (label) label.textContent = `✨ All ${total || 'tabs'} indexed`;

        clearTimeout(indexingHideTimeout);
        indexingHideTimeout = setTimeout(() => {
          indexingBar.classList.remove("visible");
          if (userSettings && userSettings.displayMode === 'auto_hide' && typeof startHideTimer === 'function') {
            startHideTimer();
          }
        }, 1600);
      }
    }
  }

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

  // --- Invisible Hover Trigger Zone at viewport top ---
  const hoverZone = document.createElement("div");
  hoverZone.className = "ts-hover-zone";
  shadow.appendChild(hoverZone);

  shadow.appendChild(trigger);
  
  // Attach Shadow DOM host to page document immediately so tab strip is always mounted
  try {
    if (document.documentElement) {
      document.documentElement.appendChild(host);
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        document.documentElement.appendChild(host);
      });
    }
  } catch (e) {}
  
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
  let userSettings = { autoScroll: true, theme: 'system', bgMode: 'ivory', displayMode: 'always_show', collapseDelay: 1500, dockPosition: 'bottom' };
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
    // Never hide while searching, AI popup open, or while actively indexing tabs
    if (userSettings.displayMode !== 'auto_hide' || isCollapsed || isSearchActive || aiPanelOpen || _isIndexingActive) return;
    hideTimeout = setTimeout(() => {
      collapseBar();
    }, 300); // fast retract: 300ms after mouse leaves (was 1500ms)
  }

  function expandBar() {
    clearTimeout(hideTimeout);
    if (isCollapsed) {
      isCollapsed = false;
      trigger.classList.remove("collapsed");
      if (pageReady) {
        applyFullPush();
      }
    }
  }

  function collapseBar() {
    // Never collapse if always_show, actively indexing tabs, searching, or panel is open
    if (userSettings.displayMode === 'always_show') return;
    if (_isIndexingActive) return;
    if (aiPanelOpen || isSearchActive || (typeof searchHasFocus !== 'undefined' && searchHasFocus)) return;
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

  // Hover zone at the top of the viewport brings bar into view
  hoverZone.addEventListener("mouseenter", () => {
    expandBar();
  });

  // Show bar on mouse approach near top of page (within 14px)
  document.addEventListener("mousemove", (e) => {
    if (userSettings.displayMode !== 'auto_hide') return;
    if (e.clientY <= 14) {
      expandBar();
    }
  });

  // Mouse over bar keeps it open
  trigger.addEventListener("mouseenter", () => {
    clearTimeout(hideTimeout);
    expandBar();
  });

  trigger.addEventListener("mouseleave", () => {
    if (userSettings.displayMode === 'auto_hide' && !isSearchActive && !aiPanelOpen && !_isIndexingActive) {
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

  // Close search when clicking outside extension
  document.addEventListener("click", (e) => {
    if (!isSearchActive) return;
    if (e.target === host || (host.contains && host.contains(e.target))) return;
    stopSearch();
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
    // Strip search is open → contain every keystroke inside the shadow so the
    // page beneath doesn't act on keys the user is typing into the search box.
    e.stopPropagation();
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
    // ── Keyboard scoping contract ──────────────────────────────────────────
    //  CLOSED (no command UI visible): intercept NOTHING except the opener.
    //         Enter, Delete, typing and the page's own shortcuts all pass
    //         straight through — the extension is invisible to the keyboard.
    //  OPEN   (strip search or AI popup visible): the extension owns the
    //         keyboard. The focused <input>'s own listener stopPropagation()s
    //         so the page beneath never sees the keystroke.
    const uiOpen = aiPanelOpen || isSearchActive;

    if (!uiOpen) {
      // The ONLY key consumed while closed is the opener (Ctrl/Cmd+K → strip
      // search). Ctrl+Shift+K is the AI-popup opener, handled separately, so
      // exclude Shift here to avoid firing both.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        startSearch();
      }
      return;
    }

    // The dedicated AI popup manages its own <input> (Enter / history / Esc);
    // don't touch its keys here — its listener handles and contains them.
    if (aiPanelOpen) return;

    // ── Strip search is open ───────────────────────────────────────────────
    if (e.key === "Escape") {
      stopSearch();
      return;
    }

    // AI commands must be checked BEFORE the filteredTabs guard — when user
    // types "> query", no tabs match ">" and we'd otherwise return early.
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
            // Retrieval results get a real, scrollable, clickable window rather
            // than a one-line toast that truncates the match list.
            if (response.kind === "recall_list" && Array.isArray(response.results) && response.results.length) {
              showResultsPanel(response);
            } else if (typeof showToast !== "undefined") {
              showToast(response.message, "success");
            }
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

    // Let ordinary typing reach the search box; keep only the navigation keys
    // (Enter / Delete / Backspace) for list control below.
    const navigating = ["Enter", "Delete", "Backspace"].includes(e.key);
    if (!navigating) return;

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
    const host = tab.url ? tab.url.replace(/^https?:\/\//, "").split("/")[0] : "";
    const timeAgo = tab.lastAccessed ? (() => {
      const d = Date.now() - tab.lastAccessed;
      if (d < 60000) return "just now";
      if (d < 3600000) return Math.round(d / 60000) + "m ago";
      if (d < 86400000) return Math.round(d / 3600000) + "h ago";
      return Math.round(d / 86400000) + "d ago";
    })() : "";

    hoverCard.innerHTML = `
      <div class="bg-surface-container-lowest border border-surface-variant rounded-xl p-3 flex flex-col gap-3 relative transition-all duration-200 shadow-[0_4px_12px_rgba(0,0,0,0.02)] min-w-[280px]">

        <div class="flex items-center gap-3 w-full group">
          <div class="w-8 h-8 rounded-md bg-white shadow-sm flex items-center justify-center flex-shrink-0 border border-surface-variant ts-hc-icon-container">
             <span class="ts-fallback text-on-surface font-bold">${(tab.title || "?")[0].toUpperCase()}</span>
          </div>
          <div class="flex-1 min-w-0">
             <h3 class="font-h2 text-body-md text-on-surface truncate">${tab.title || "Untitled"}</h3>
             <div class="flex items-center gap-1.5 text-body-sm text-outline truncate">
               <span>${host}</span>
               ${timeAgo ? `<span style="opacity:.5">·</span><span style="opacity:.6;font-size:11px">${timeAgo}</span>` : ""}
             </div>
          </div>
          <button class="w-6 h-6 rounded-full hover:bg-surface-variant text-outline hover:text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 bg-surface-container-low shadow-sm ts-close-hover" data-tab-id="${tab.id}">
             <span class="text-[16px] font-bold">&times;</span>
          </button>
        </div>

        ${tab.groupTitle ? `
        <div class="flex gap-1">
           <span class="bg-primary/10 text-primary font-label-caps text-[10px] px-2 py-0.5 rounded-full">${tab.groupTitle}</span>
        </div>` : ""}

        ${tab.url && tab.url.length > 0 ? `
        <div class="text-[11px] text-outline/70 truncate px-0.5" style="opacity:.55;font-family:'IBM Plex Mono',monospace;">
          ${tab.url.length > 80 ? tab.url.slice(0, 80) + "…" : tab.url}
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

  function applyBackground(bgMode) {
    host.classList.remove("ts-bg-ivory", "ts-bg-black");
    if (bgMode === "black") {
      host.classList.add("ts-bg-black");
    } else {
      host.classList.add("ts-bg-ivory");
    }
  }

  // --- Settings Sync ---
  function updateSettings(changes) {
    if (changes.theme) {
      userSettings.theme = changes.theme.newValue;
      applyTheme(userSettings.theme);
    }
    if (changes.bgMode) {
      userSettings.bgMode = changes.bgMode.newValue;
      applyBackground(userSettings.bgMode);
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
    if (color && color !== '#0c0c0f' && color !== '') {
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
    // Errors never ride the bottom strip anymore — they get the persistent
    // ivory dialog (no auto-dismiss, user must Cancel / press Esc).
    if (type === 'error') {
      showErrorDialog(message);
      return null;
    }

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
      // NOTE: 'error' intentionally absent — errors are routed to the
      // persistent ivory dialog above and never reach the bottom strip.
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

  // ===== PERSISTENT IVORY ERROR DIALOG =====
  // Centered ivory modal (UIDialogs.buildErrorDialog) that stays until the
  // user clicks Cancel or presses Esc — no auto-dismiss timer. Only one is
  // ever on screen: a new error replaces the previous dialog's content.
  function showErrorDialog(message) {
    const existing = shadow.querySelector(".ts-error-dialog");
    if (existing) existing.remove();
    const modal = UIDialogs.buildErrorDialog(String(message == null ? "" : message));
    modal.style.opacity = "0";
    shadow.appendChild(modal);
    requestAnimationFrame(() => { modal.style.opacity = "1"; });
    return modal;
  }

  // ===== OPEN-TABS PICKER (background matched N tabs for an open command) =====
  // background.js answers ambiguous open commands with OPEN_TABS_PICKER +
  // the live matches; show every option so the user can pick the right tab.
  function showOpenTabsPicker(options) {
    const existing = shadow.querySelector(".ts-picker-modal");
    if (existing) existing.remove();
    const list = Array.isArray(options) ? options : [];
    if (list.length === 0) {
      showToast("No matching tabs found.", "info");
      return null;
    }
    const modal = UIDialogs.buildPickerModal(list, {
      onPick: (tabId) => {
        safeSendMessage({ type: "FOCUS_PICKED_TAB", tabId });
      },
      onCancel: () => {}
    });
    modal.style.opacity = "0";
    shadow.appendChild(modal);
    requestAnimationFrame(() => { modal.style.opacity = "1"; });
    return modal;
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

    (data.options || []).forEach((option, optionIndex) => {
      const btn = document.createElement("button");
      // V2 interpretation loop: options carry a concrete reading, an action
      // summary and the pool match count; legacy callers send label only.
      const isV2 = !!data.clarifyId;
      btn.textContent = isV2
        ? `${option.label}${option.matchCount != null ? ` — ${option.matchCount} tab(s)` : ""}`
        : option.label;
      btn.style.cssText = `
        padding: 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;
        font-size: 14px; text-align: left; transition: background 0.15s ease;
      `;
      if (isV2 && option.summary) {
        const sub = document.createElement("div");
        sub.textContent = option.summary.replace(/_/g, " ");
        sub.style.cssText = "font-size: 11px; opacity: 0.6; margin-top: 2px;";
        btn.appendChild(sub);
      }
      btn.addEventListener("mouseenter", () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
      btn.addEventListener("mouseleave", () => { btn.style.background = 'rgba(255,255,255,0.05)'; });
      btn.addEventListener("click", () => close(option, optionIndex));
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
    cancelBtn.addEventListener("click", () => close(null, -1));
    content.appendChild(cancelBtn);

    modal.appendChild(content);
    shadow.appendChild(modal);

    requestAnimationFrame(() => {
      modal.style.opacity = "1";
      modal.style.pointerEvents = "auto";
    });

    function close(selectedOption, optionIndex) {
      modal.style.opacity = "0";
      modal.style.pointerEvents = "none";
      setTimeout(() => modal.remove(), 200);

      if (data.clarifyId) {
        // Interpretation loop round-trip: the orchestrator executes the chosen
        // option's plan through the normal preview/undo path. Cancel (-1)
        // aborts; either answer consumes the pending clarification.
        safeSendMessage({
          type: "CLARIFY_CHOSEN",
          clarifyId: data.clarifyId,
          optionIndex: selectedOption ? optionIndex : -1,
          command: data.command
        }, (response) => {
          if (response && response.success) {
            if (typeof showToast !== "undefined") showToast(response.message || "Done", "success");
          } else if (!selectedOption || response) {
            if (typeof showToast !== "undefined") showToast(response?.message || (selectedOption ? "Error" : "Cancelled"), selectedOption ? "error" : "info");
          }
        });
        return;
      }

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
      // The AI popup is a child of `trigger`, so wheeling over it used to bubble
      // here and scroll the tab strip instead of the popup's own content. If the
      // wheel is over the popup, leave it alone and let the popup scroll natively.
      if (e.target && e.target.closest && e.target.closest('.ts-ai-popup')) return;
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
  //
  // MV3 service worker cold-start: Chrome may not have finished loading the
  // service worker (878KB transformers.min.js + 14 other scripts) by the time
  // the content script fires GET_TABS. When that happens the message silently
  // fails and the callback is never invoked, so tabsPromise hangs forever and
  // the bar never renders.  Fix: retry with exponential backoff.
  const tabsPromise = new Promise((resolve) => {
    const MAX_RETRIES = 8;     // ~25s total worst case (300+600+1200+2400+4800+4800+4800+4800)
    const BASE_DELAY = 300;    // ms
    let attempt = 0;

    function tryGetTabs() {
      attempt++;
      try {
        if (!chrome.runtime?.id) {
          // Extension context gone — resolve with empty tabs so bar at least renders
          resolve();
          return;
        }
        chrome.runtime.sendMessage({ type: "GET_TABS" }, (response) => {
          if (chrome.runtime.lastError) {
            // Service worker not ready yet — retry
            if (attempt < MAX_RETRIES) {
              const delay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1), 4800);
              console.log(`[TabScroller] GET_TABS retry ${attempt}/${MAX_RETRIES} in ${delay}ms (${chrome.runtime.lastError.message})`);
              setTimeout(tryGetTabs, delay);
            } else {
              console.warn('[TabScroller] GET_TABS failed after max retries, rendering empty bar');
              resolve();
            }
            return;
          }
          if (response && response.tabs) {
            tabs = response.tabs;
          }
          resolve();
        });
      } catch (e) {
        // Extension invalidated mid-flight
        if (attempt < MAX_RETRIES) {
          setTimeout(tryGetTabs, Math.min(BASE_DELAY * Math.pow(2, attempt - 1), 4800));
        } else {
          resolve();
        }
      }
    }
    tryGetTabs();
  });

  const settingsPromise = new Promise((resolve) => {
    safeStorageGet({ autoScroll: true, theme: 'system', bgMode: 'ivory', displayMode: 'always_show', collapseDelay: 1500, enableShield: false, dockPosition: 'bottom', stripColor: '' }, (items) => {
      userSettings = items;
      applyTheme(userSettings.theme);
      applyBackground(userSettings.bgMode || 'ivory');
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
    if (!host.parentNode && document.documentElement) {
      document.documentElement.appendChild(host);
    }
    render();
    
    // Initialize AI Command interface
    initializeCommandInterface();
    
    // Apply correct bar collapse and body push states immediately
    if (userSettings.displayMode === 'always_show' || _isIndexingActive) {
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

    // Query initial tab indexing status from service worker
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({ type: "GET_INDEX_STATUS" }, (status) => {
          if (chrome.runtime.lastError) return;
          if (status && status.isIndexing) {
            updateIndexingUI(status);
          }
        });
      }
    } catch (e) {}
  });

  // --- Listen for live updates ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Handle case where extension context is invalidated
    if (!chrome.runtime?.id) {
      return false;
    }
    
    try {
      if (msg.type === 'AI_PROGRESS') {
        updateAiProgress(msg);
      } else if (msg.type === 'FALLBACK_NOTIFICATION') {
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
    } else if (msg.type === "INDEX_PROGRESS" || msg.type === "INDEX_COMPLETE") {
      updateIndexingUI(msg);
    } else if (msg.type === "UNDO_AVAILABLE") {
      undoBtn.style.display = "";
      undoBtn.title = `Undo: ${msg.action} (${msg.count} tabs)`;
      showToast(msg.message, "success", 5000);
      // Auto-hide undo button after 15 seconds
      clearTimeout(undoAutoHideTimer);
      undoAutoHideTimer = setTimeout(() => { undoBtn.style.display = "none"; }, 15000);
    } else if (msg.type === "CLARIFICATION_NEEDED") {
      showClarificationModal(msg);
    } else if (msg.type === "CLARIFY_NEEDED") {
      // Interpretation-level clarification (V2-3): concrete readings with
      // match counts; the pick returns via CLARIFY_CHOSEN.
      showClarificationModal(msg);
    } else if (msg.type === "OPEN_TABS_PICKER") {
      // background matched several tabs for an open command — surface every
      // option and let the user choose; the pick is sent back as FOCUS_PICKED_TAB.
      showOpenTabsPicker(msg.options);
    } else if (msg.type === "PREVIEW_PLAN") {
      (async () => {
        if (msg.plan && msg.plan.intent === 'group_multi') {
          const result = await showMultiGroupPreviewModal(msg);
          if (result && result.buckets && result.buckets.length > 0) {
            safeSendMessage({
              type: "EXECUTE_PLAN",
              planId: msg.planId,
              buckets: result.buckets
            }, (response) => {
              if (response && response.success) {
                if (typeof showToast !== 'undefined') showToast(response.message, "success");
              } else {
                if (typeof showToast !== 'undefined') showToast(response?.message || "Error applying groups", "error");
              }
            });
          } else {
            if (typeof showToast !== 'undefined') showToast("Multi-group cancelled", "info");
          }
          return;
        }

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
      <div class="ts-ai-progress" role="status" aria-live="polite">
        <div class="ts-ai-progress-row">
          <span class="ts-ai-progress-label">Working…</span>
          <span class="ts-ai-progress-pct"></span>
        </div>
        <div class="ts-ai-progress-track"><div class="ts-ai-progress-fill"></div></div>
      </div>
      <div class="ts-ai-popup-body">
        <div class="ts-suggestions-title">Try these commands</div>
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
    const progressLabel = panel.querySelector(".ts-ai-progress-label");
    const progressPct = panel.querySelector(".ts-ai-progress-pct");
    const progressFill = panel.querySelector(".ts-ai-progress-fill");

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

    const mgLauncher = document.createElement("div");
    mgLauncher.className = "ts-multigroup-launcher";
    const mgBtn = document.createElement("button");
    mgBtn.className = "ts-multigroup-btn";
    mgBtn.type = "button";
    mgBtn.innerHTML = '✨ Organize into my groups…';
    mgBtn.addEventListener("click", () => {
      closePanel();
      showMultiGroupSetupModal();
    });
    mgLauncher.appendChild(mgBtn);
    suggestionsEl.parentNode.appendChild(mgLauncher);

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
      if (e.target === host || (host.contains && host.contains(e.target))) return;
      closePanel();
    });

    // Command history
    let commandHistory = [];
    let historyIndex = -1;

    // Load history from storage. Guarded: if the extension context has been
    // invalidated (e.g. the unpacked extension was reloaded while this page
    // stayed open), chrome.storage is undefined and an unguarded call here throws
    // an uncaught TypeError that aborts the rest of createCommandInput -- which
    // takes the tab strip down with it. safeChromeCall no-ops on a dead context.
    safeChromeCall(() => {
      chrome.storage.local.get({ commandHistory: [] }, (items) => {
        if (chrome.runtime.lastError) return;
        commandHistory = items.commandHistory || [];
      });
    });

    input.addEventListener("keydown", (e) => {
      // Panel is open → the extension owns the keyboard. Contain every keystroke
      // inside the shadow so the page's own shortcuts don't fire while typing a
      // command. (Capture-phase handleKeyDown already bailed on aiPanelOpen.)
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const command = input.value.trim();
        if (command) {
          executeAICommand(command);

          // Save to history
          commandHistory.unshift(command);
          if (commandHistory.length > 50) commandHistory.pop();
          safeChromeCall(() => chrome.storage.local.set({ commandHistory }));
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

    return { container: button, panel, input, openPanel, closePanel, progressLabel, progressPct, progressFill };
  }

  // ===== COMMAND EXECUTION =====
  // Smoothly animates the fill toward a target so distinct progress messages
  // read as one continuous motion rather than discrete jumps.
  let progressRAF = null;
  let progressShown = 0;   // width currently painted (0-100)
  let progressTarget = 0;  // width we're easing toward (0-100)

  function paintProgress() {
    progressRAF = null;
    if (!commandInputComponents) return;
    const { progressFill } = commandInputComponents;
    if (!progressFill) return;
    const diff = progressTarget - progressShown;
    if (Math.abs(diff) < 0.5) {
      progressShown = progressTarget;
    } else {
      progressShown += diff * 0.25; // ease toward target
      progressRAF = requestAnimationFrame(paintProgress);
    }
    progressFill.style.width = progressShown.toFixed(1) + "%";
  }

  function setProgressTarget(pct) {
    progressTarget = Math.max(progressShown, Math.min(100, pct)); // never regress
    if (progressRAF == null) progressRAF = requestAnimationFrame(paintProgress);
  }

  function beginAiProgress() {
    if (!commandInputComponents) return;
    const { panel, progressLabel, progressPct, progressFill } = commandInputComponents;
    progressShown = 0;
    progressTarget = 0;
    if (progressRAF != null) { cancelAnimationFrame(progressRAF); progressRAF = null; }
    if (progressFill) progressFill.style.width = "0%";
    if (progressLabel) progressLabel.textContent = "Reading your command…";
    if (progressPct) progressPct.textContent = "";
    if (panel) panel.classList.add("processing");
    setProgressTarget(4);
  }

  function updateAiProgress(msg) {
    if (!commandInputComponents) return;
    if (!aiCommandInProgressInUI) return; // ignore stray late messages
    const { panel, progressLabel, progressPct } = commandInputComponents;
    if (panel && !panel.classList.contains("processing")) panel.classList.add("processing");
    if (progressLabel && msg.detail) progressLabel.textContent = msg.detail;
    if (typeof msg.pct === "number") {
      setProgressTarget(msg.pct);
      if (progressPct) progressPct.textContent = Math.round(msg.pct) + "%";
    }
  }

  function endAiProgress(ok) {
    if (!commandInputComponents) return;
    const { panel, progressLabel, progressPct } = commandInputComponents;
    // Snap to 100 so the bar visibly completes, then fade the region out.
    setProgressTarget(100);
    if (progressPct) progressPct.textContent = "100%";
    if (progressLabel) progressLabel.textContent = ok ? "Done" : "Stopped";
    setTimeout(() => {
      if (panel) panel.classList.remove("processing");
    }, 420);
  }

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
    input.placeholder = "Working…";
    input.disabled = true;
    beginAiProgress();

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
        endAiProgress(true);
        return;
      }

      if (response.success) {
        endAiProgress(true);
        // Retrieval ("find/open") results get a real, scrollable, selectable
        // window instead of a one-line toast that truncated the match list.
        if (response.kind === "recall_list" && Array.isArray(response.results) && response.results.length) {
          showResultsPanel(response);
        } else {
          showToast(response.message, "success");
        }

        // Show analysis results if present
        if (response.analysis) {
          showAnalysisModal(response.analysis);
        }
      } else {
        endAiProgress(false);
        showToast(response.message || "Command failed", "error");
      }
    } catch (error) {
      console.error('[AI Command] Error:', error);
      endAiProgress(false);
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

  // ===== RETRIEVAL RESULTS WINDOW =====
  // A proper, scrollable, selectable window for "find/open" results — replaces
  // the single-line green toast that truncated the match list. Backed by the
  // structured { kind:'recall_list', results:[{title,url,domain,similarity}] }
  // payload from handleRecallTabs. Selected rows open via OPEN_RECALL_URLS.
  let resultsPanelEl = null;
  function showResultsPanel(data) {
    const rows = Array.isArray(data.results) ? data.results : [];
    if (!rows.length) {
      if (typeof showToast !== "undefined") showToast(data.message || "No matching tabs.", "info");
      return;
    }

    // Only one results window at a time.
    if (resultsPanelEl) { resultsPanelEl.remove(); resultsPanelEl = null; }

    const modal = document.createElement("div");
    modal.className = "ts-analysis-modal ts-results-modal"; // reuse modal fade/scale

    const overlay = document.createElement("div");
    overlay.className = "ts-modal-overlay";
    modal.appendChild(overlay);

    const content = document.createElement("div");
    content.className = "ts-modal-content ts-results-content";
    content.tabIndex = -1; // focusable so Esc/Enter land here, not the popup behind

    const title = document.createElement("h3");
    const q = (data.query || "").trim();
    title.textContent = q
      ? `\u{1F50E} ${data.count || rows.length} tabs for “${q}”`
      : `\u{1F50E} Found ${data.count || rows.length} tabs`;
    content.appendChild(title);

    if (data.narrowed) {
      const note = document.createElement("div");
      note.className = "ts-results-note";
      note.textContent = `Showing the top ${rows.length}. Add a time range or more specific words to narrow further.`;
      content.appendChild(note);
    }

    const list = document.createElement("div");
    list.className = "ts-results-list";

    rows.forEach((r) => {
      const row = document.createElement("label"); // label → clicking row toggles cb
      row.className = "ts-results-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "ts-results-cb";
      cb.checked = true;
      cb.dataset.url = r.url || "";
      row.appendChild(cb);

      const main = document.createElement("div");
      main.className = "ts-results-main";
      const t = document.createElement("div");
      t.className = "ts-results-title";
      t.textContent = r.title || r.domain || r.url || "(untitled)"; // textContent: no injection
      const d = document.createElement("div");
      d.className = "ts-results-domain";
      d.textContent = r.domain || "";
      main.appendChild(t);
      main.appendChild(d);
      row.appendChild(main);

      const score = document.createElement("div");
      score.className = "ts-results-score";
      score.textContent = Math.round((r.similarity || 0) * 100) + "%";
      row.appendChild(score);

      list.appendChild(row);
    });
    content.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "ts-results-footer";

    const hint = document.createElement("div");
    hint.className = "ts-results-hint";
    hint.textContent = "Tick tabs to open · Enter opens · Esc closes";
    footer.appendChild(hint);

    const btns = document.createElement("div");
    btns.className = "ts-results-btns";

    const closeBtn = document.createElement("button");
    closeBtn.className = "ts-btn";
    closeBtn.textContent = "Close";

    const openBtn = document.createElement("button");
    openBtn.className = "ts-btn ts-btn-primary";
    openBtn.textContent = "Open selected";

    btns.appendChild(closeBtn);
    btns.appendChild(openBtn);
    footer.appendChild(btns);
    content.appendChild(footer);

    modal.appendChild(content);
    shadow.appendChild(modal);
    resultsPanelEl = modal;

    const close = () => {
      modal.classList.remove("visible");
      setTimeout(() => { modal.remove(); if (resultsPanelEl === modal) resultsPanelEl = null; }, 250);
      // Hand focus back to the command box if the popup is still open.
      if (aiPanelOpen && commandInputComponents && commandInputComponents.input) {
        commandInputComponents.input.focus();
      }
    };

    const openSelected = () => {
      const urls = Array.from(list.querySelectorAll(".ts-results-cb"))
        .filter((cb) => cb.checked)
        .map((cb) => cb.dataset.url)
        .filter(Boolean);
      if (!urls.length) {
        if (typeof showToast !== "undefined") showToast("No tabs selected.", "warning");
        return;
      }
      safeSendMessage({ type: "OPEN_RECALL_URLS", urls }, (resp) => {
        if (typeof showToast !== "undefined") {
          showToast(`Opened ${resp && typeof resp.opened === "number" ? resp.opened : urls.length} tab(s).`, "success");
        }
      });
      close();
    };

    overlay.onclick = close;
    closeBtn.onclick = close;
    openBtn.onclick = openSelected;

    // Enter opens the ticked tabs, Esc closes. stopPropagation so these don't
    // also reach (and close) the AI popup sitting behind this window.
    content.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter") { e.preventDefault(); openSelected(); }
    });

    requestAnimationFrame(() => {
      modal.classList.add("visible");
      content.focus();
    });
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
      reload_tabs: "Reload Tabs",
      group_multi: "Organize into Groups"
    };

    const actionTitle = data.plan.chained
      ? "Chained Plan"
      : (titleMap[data.plan.intent] || "Tab Action Plan");

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

    // Chained (multi-step) plans: the combined per-step preview lines from
    // the background ("1. Bookmark 2 tab(s)", "2. Close 2 tab(s)") render
    // above the tab list so the user confirms BOTH steps in one modal.
    if (data.plan.chained && data.plan.reason) {
      const stepsBox = document.createElement("div");
      stepsBox.className = "ts-preview-steps";
      stepsBox.style.cssText = "margin:8px 0 4px;padding:6px 10px;border:1px solid rgba(148,163,184,0.35);border-radius:8px;white-space:pre-line;font-size:12px;";
      stepsBox.textContent = data.plan.reason;
      content.appendChild(stepsBox);
    }

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
      item.className = "ts-preview-item" + (isUncertain ? " uncertain" : "");

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
      if (isUncertain) {
        const badge = document.createElement("span");
        badge.className = "ts-preview-badge-uncertain";
        badge.textContent = "Uncertain";
        itemReason.appendChild(badge);
        itemReason.appendChild(document.createTextNode(details.reason || "Matched with lower confidence"));
      } else {
        itemReason.textContent = details.reason || "Matched";
      }
      info.appendChild(itemReason);

      item.appendChild(info);
      list.appendChild(item);
    });

    content.appendChild(list);

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

  // ===== MULTI-GROUP SETUP MODAL =====
  function showMultiGroupSetupModal() {
    const modal = document.createElement("div");
    modal.className = "ts-preview-modal";

    const overlay = document.createElement("div");
    overlay.className = "ts-modal-overlay";
    modal.appendChild(overlay);

    const content = document.createElement("div");
    content.className = "ts-preview-content";
    content.style.maxWidth = "560px";

    const title = document.createElement("h3");
    title.className = "ts-preview-title";
    title.textContent = "Organize Tabs into Custom Groups";
    content.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "ts-preview-subtitle";
    subtitle.textContent = "Define group names and characteristics. AI will sort open tabs into your groups.";
    content.appendChild(subtitle);

    const list = document.createElement("div");
    list.className = "ts-mg-setup-list";

    function createRow(name = "", char = "") {
      const row = document.createElement("div");
      row.className = "ts-mg-setup-row";

      const nameInput = document.createElement("input");
      nameInput.className = "ts-mg-input-name";
      nameInput.placeholder = "Group Name (e.g. Coding)";
      nameInput.value = name;

      const charInput = document.createElement("input");
      charInput.className = "ts-mg-input-char";
      charInput.placeholder = "Characteristics (e.g. programming, dev tools)";
      charInput.value = char;

      const delBtn = document.createElement("button");
      delBtn.className = "ts-mg-row-del";
      delBtn.innerHTML = "✕";
      delBtn.title = "Remove group";
      delBtn.onclick = () => {
        if (list.children.length > 1) row.remove();
      };

      row.appendChild(nameInput);
      row.appendChild(charInput);
      row.appendChild(delBtn);
      return row;
    }

    // Default initial 2 rows
    list.appendChild(createRow("Coding", "programming, software development, repos"));
    list.appendChild(createRow("Research", "articles, documentation, reading"));
    content.appendChild(list);

    const addBtn = document.createElement("button");
    addBtn.className = "ts-mg-add-btn";
    addBtn.textContent = "+ Add Group";
    addBtn.onclick = () => {
      if (list.children.length < 8) {
        list.appendChild(createRow());
      }
    };
    content.appendChild(addBtn);

    const restrictDiv = document.createElement("div");
    restrictDiv.className = "ts-mg-restrict-container";
    const restrictLabel = document.createElement("label");
    restrictLabel.className = "ts-mg-restrict-label";
    restrictLabel.textContent = "Restrict to (optional domain or search term):";
    const restrictInput = document.createElement("input");
    restrictInput.className = "ts-mg-restrict-input";
    restrictInput.placeholder = "e.g. youtube.com or github.com (leaves empty for all open tabs)";
    restrictDiv.appendChild(restrictLabel);
    restrictDiv.appendChild(restrictInput);
    content.appendChild(restrictDiv);

    const buttons = document.createElement("div");
    buttons.className = "ts-preview-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ts-preview-btn ts-preview-btn-cancel";
    cancelBtn.textContent = "Cancel";
    buttons.appendChild(cancelBtn);

    const assignBtn = document.createElement("button");
    assignBtn.className = "ts-preview-btn ts-preview-btn-confirm";
    assignBtn.textContent = "Assign with AI ✨";
    buttons.appendChild(assignBtn);

    content.appendChild(buttons);
    modal.appendChild(content);
    shadow.appendChild(modal);

    requestAnimationFrame(() => modal.classList.add("visible"));

    const close = () => {
      modal.classList.remove("visible");
      setTimeout(() => modal.remove(), 200);
    };

    cancelBtn.onclick = close;
    overlay.onclick = close;

    assignBtn.onclick = () => {
      const rows = Array.from(list.querySelectorAll(".ts-mg-setup-row"));
      const buckets = [];
      for (const r of rows) {
        const name = r.querySelector(".ts-mg-input-name").value.trim();
        const characteristic = r.querySelector(".ts-mg-input-char").value.trim();
        if (name) buckets.push({ name, characteristic });
      }

      if (buckets.length === 0) {
        showToast("Please provide at least one group name.", "error");
        return;
      }

      const restrict = restrictInput.value.trim();
      assignBtn.disabled = true;
      assignBtn.textContent = "Categorizing…";

      safeSendMessage({
        type: "AI_MULTIGROUP_ASSIGN",
        buckets,
        restrict: restrict || null
      }, (resp) => {
        close();
        if (!resp || !resp.success) {
          showToast(resp?.message || "Multi-group assignment failed.", "error");
        } else {
          showToast("AI categorized your tabs. Review preview below.", "info");
        }
      });
    };
  }

  // ===== MULTI-GROUP PREVIEW MODAL =====
  function showMultiGroupPreviewModal(data) {
    const modal = document.createElement("div");
    modal.className = "ts-preview-modal";

    const overlay = document.createElement("div");
    overlay.className = "ts-modal-overlay";
    modal.appendChild(overlay);

    const content = document.createElement("div");
    content.className = "ts-preview-content";
    content.style.maxWidth = "760px";
    content.style.width = "92vw";

    const title = document.createElement("h3");
    title.className = "ts-preview-title";
    title.textContent = "Preview Custom Groups";
    content.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "ts-preview-subtitle";
    subtitle.textContent = "Review and edit group names, colors, or uncheck tabs before applying.";
    content.appendChild(subtitle);

    const container = document.createElement("div");
    container.className = "ts-mg-preview-container";

    const buckets = data.plan.buckets || [];
    const tabDetails = data.tabDetails || {};
    const unassignedIds = data.plan.unassigned || [];

    const bucketRows = [];

    const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    // The real hue of each Chrome group color (mirrors the border-color in the
    // .ts-group-<color> rules), used to tint the swatch dots.
    const MG_SWATCH_HEX = {
      grey: '#5f6368', blue: '#8ab4f8', red: '#f28b82', yellow: '#fdd663',
      green: '#81c995', pink: '#ff8bcb', purple: '#d7aefb', cyan: '#78d9ec', orange: '#ffad70'
    };

    buckets.forEach((b, bIdx) => {
      const card = document.createElement("div");
      card.className = "ts-mg-bucket-card";

      const header = document.createElement("div");
      header.className = "ts-mg-bucket-header";

      const nameInput = document.createElement("input");
      nameInput.className = "ts-mg-bucket-title-input";
      nameInput.value = b.name;

      // Color picker as swatches (replaces the old <select>): a row of the nine
      // Chrome tab-group colors, each a clickable dot tinted with that group's
      // real hue. The selected dot carries a ring; getColor returns its name.
      // The value is always one of CHROME_COLORS, so the applied color is
      // whitelisted by construction.
      let selectedColor = CHROME_COLORS.includes(b.color) ? b.color : CHROME_COLORS[0];
      const swatchRow = document.createElement("div");
      swatchRow.className = "ts-mg-bucket-swatches";
      swatchRow.setAttribute("role", "radiogroup");
      swatchRow.setAttribute("aria-label", "Group color");
      const swatchEls = [];
      CHROME_COLORS.forEach(c => {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = "ts-mg-swatch" + (c === selectedColor ? " ts-mg-swatch-selected" : "");
        sw.dataset.color = c;
        sw.style.background = MG_SWATCH_HEX[c] || "#888";
        sw.title = c[0].toUpperCase() + c.slice(1);
        sw.setAttribute("role", "radio");
        sw.setAttribute("aria-label", sw.title);
        sw.setAttribute("aria-checked", c === selectedColor ? "true" : "false");
        sw.addEventListener("click", () => {
          selectedColor = c;
          swatchEls.forEach(e => {
            const on = e.dataset.color === c;
            e.classList.toggle("ts-mg-swatch-selected", on);
            e.setAttribute("aria-checked", on ? "true" : "false");
          });
        });
        swatchEls.push(sw);
        swatchRow.appendChild(sw);
      });

      const countSpan = document.createElement("span");
      countSpan.className = "ts-mg-bucket-count";

      header.appendChild(nameInput);
      header.appendChild(swatchRow);
      header.appendChild(countSpan);
      card.appendChild(header);

      const tabList = document.createElement("div");
      tabList.className = "ts-preview-list";

      const itemCheckboxes = [];

      b.tabIds.forEach(id => {
        const details = tabDetails[id] || { title: "Untitled Tab", favIconUrl: "" };
        const item = document.createElement("div");
        item.className = "ts-preview-item checked-item";
        item.title = details.title || "";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "ts-preview-checkbox";
        cb.checked = true;
        cb.dataset.tabId = id;
        item.appendChild(cb);
        itemCheckboxes.push(cb);

        if (details.favIconUrl) {
          const img = document.createElement("img");
          img.className = "ts-preview-favicon";
          img.src = details.favIconUrl;
          img.onerror = () => { img.replaceWith(makeFb(details)); };
          item.appendChild(img);
        } else {
          item.appendChild(makeFb(details));
        }

        const info = document.createElement("div");
        info.className = "ts-preview-item-info";
        const it = document.createElement("span");
        it.className = "ts-preview-item-title";
        it.textContent = details.title;
        info.appendChild(it);
        item.appendChild(info);

        cb.addEventListener("change", () => {
          if (cb.checked) {
            item.classList.add("checked-item");
          } else {
            item.classList.remove("checked-item");
          }
        });

        tabList.appendChild(item);
      });

      card.appendChild(tabList);
      container.appendChild(card);

      const updateCount = () => {
        const checked = itemCheckboxes.filter(c => c.checked).length;
        countSpan.textContent = `${checked} / ${itemCheckboxes.length} tab${itemCheckboxes.length === 1 ? '' : 's'}`;
      };

      itemCheckboxes.forEach(cb => cb.addEventListener("change", () => {
        updateCount();
        updateConfirmButton();
      }));
      updateCount();

      bucketRows.push({
        getName: () => nameInput.value.trim() || b.name,
        getColor: () => selectedColor,
        getCheckedIds: () => itemCheckboxes.filter(c => c.checked).map(c => Number(c.dataset.tabId))
      });
    });

    // Unassigned section
    if (unassignedIds.length > 0) {
      const unassignedDiv = document.createElement("div");
      const unHeader = document.createElement("div");
      unHeader.className = "ts-mg-unassigned-header";
      unHeader.textContent = `Unassigned Tabs (${unassignedIds.length}) — won't be grouped ▾`;

      const unList = document.createElement("div");
      unList.className = "ts-mg-unassigned-list ts-preview-list";
      unList.style.display = "none";

      unassignedIds.forEach(id => {
        const details = tabDetails[id] || { title: "Untitled Tab", favIconUrl: "" };
        const item = document.createElement("div");
        item.className = "ts-preview-item";

        if (details.favIconUrl) {
          const img = document.createElement("img");
          img.className = "ts-preview-favicon";
          img.src = details.favIconUrl;
          img.onerror = () => { img.replaceWith(makeFb(details)); };
          item.appendChild(img);
        } else {
          item.appendChild(makeFb(details));
        }

        const info = document.createElement("div");
        info.className = "ts-preview-item-info";
        const it = document.createElement("span");
        it.className = "ts-preview-item-title";
        it.textContent = details.title;
        info.appendChild(it);
        item.appendChild(info);
        unList.appendChild(item);
      });

      unHeader.onclick = () => {
        unList.style.display = unList.style.display === "none" ? "block" : "none";
      };

      unassignedDiv.appendChild(unHeader);
      unassignedDiv.appendChild(unList);
      container.appendChild(unassignedDiv);
    }

    content.appendChild(container);

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

    function updateConfirmButton() {
      const validBuckets = bucketRows.filter(r => r.getCheckedIds().length >= 2).length;
      confirmBtn.textContent = `Apply (${validBuckets} group${validBuckets === 1 ? '' : 's'})`;
      confirmBtn.disabled = validBuckets === 0;
      confirmBtn.style.opacity = validBuckets === 0 ? "0.5" : "1";
    }

    updateConfirmButton();

    requestAnimationFrame(() => modal.classList.add("visible"));

    function makeFb(details) {
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
        const finalBuckets = bucketRows.map(r => ({
          name: r.getName(),
          color: r.getColor(),
          tabIds: r.getCheckedIds()
        })).filter(b => b.tabIds.length >= 2);
        close({ buckets: finalBuckets });
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

// ===== UI DIALOG BUILDERS — BEGIN UIDIALOGS =====
// Pure DOM builders for the open-tabs picker and the persistent ivory error
// dialog. No chrome.* access and no closure state: everything is built from a
// document (ambient, or hooks.document for tests), styled inline with Tab
// Scroller's ivory theme tokens (--ts-bg-solid #fcf8f0 panel, --ts-accent
// #9c7817 antique gold, --ts-hairline borders, warm near-black --ts-text),
// and RETURNED to the caller to append. Function declarations hoist to script
// scope, so the IIFE above can call these from its message/toast handlers.
function tsUiDoc(hooks) {
  return (hooks && hooks.document) || (typeof document !== "undefined" ? document : null);
}

function tsUiShell(doc, rootClass) {
  const modal = doc.createElement("div");
  modal.className = rootClass;
  modal.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;display:flex;" +
    "align-items:center;justify-content:center;z-index:2147483647;" +
    "transition:opacity .2s ease;pointer-events:auto;" +
    "font-family:'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,sans-serif;";
  const overlay = doc.createElement("div");
  overlay.className = "ts-modal-overlay";
  overlay.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;" +
    "background:rgba(30,24,12,.42);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);";
  const panel = doc.createElement("div");
  panel.style.cssText =
    "position:relative;display:flex;flex-direction:column;" +
    "background:var(--ts-bg-solid,#fcf8f0);color:var(--ts-text,#1b160e);" +
    "border-radius:16px;padding:20px 22px;" +
    "border:1px solid var(--ts-border,rgba(156,120,23,.22));" +
    "box-shadow:0 16px 44px rgba(58,44,12,.18);";
  modal.appendChild(overlay);
  modal.appendChild(panel);
  return { modal, overlay, panel };
}

function tsUiGoldRule(doc) {
  const rule = doc.createElement("div");
  rule.style.cssText =
    "height:2px;border-radius:2px;margin:8px 0 12px;flex:none;" +
    "background:linear-gradient(90deg,var(--ts-accent,#9c7817)," +
    "var(--ts-accent-glow,rgba(156,120,23,.3)));";
  return rule;
}

function tsUiButton(doc, variant) {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.textContent = "Cancel";
  if (variant === "solid") {
    btn.style.cssText =
      "padding:8px 20px;border:none;border-radius:10px;cursor:pointer;" +
      "font-size:13px;font-weight:600;letter-spacing:.2px;" +
      "background:var(--ts-accent,#9c7817);color:#fcf8f0;";
    btn.addEventListener("mouseenter", () => { btn.style.background = "var(--ts-accent-dim,#7d5f10)"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "var(--ts-accent,#9c7817)"; });
  } else {
    btn.style.cssText =
      "padding:8px 18px;border-radius:10px;cursor:pointer;font-size:13px;" +
      "border:1px solid var(--ts-hairline,rgba(33,28,20,.09));" +
      "background:var(--ts-bg-solid,#fcf8f0);color:var(--ts-text-muted,#6b6150);";
    btn.addEventListener("mouseenter", () => {
      btn.style.borderColor = "var(--ts-accent-dim,#7d5f10)";
      btn.style.color = "var(--ts-accent-dim,#7d5f10)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.borderColor = "var(--ts-hairline,rgba(33,28,20,.09))";
      btn.style.color = "var(--ts-text-muted,#6b6150)";
    });
  }
  return btn;
}

function tsUiFaviconFallback(doc) {
  const fb = doc.createElement("div");
  fb.textContent = "\u2750"; // generic tab glyph — shown when no favicon loads
  fb.style.cssText =
    "width:20px;height:20px;flex:none;display:flex;align-items:center;" +
    "justify-content:center;font-size:11px;line-height:1;" +
    "color:var(--ts-accent,#9c7817);border-radius:4px;" +
    "border:1px solid var(--ts-hairline,rgba(33,28,20,.09));" +
    "background:var(--ts-fill,rgba(33,28,20,.04));";
  return fb;
}

// Open-tabs picker: lists EVERY matching tab (favicon, title, host).
// hooks: { onPick(tabId, option), onCancel(), document }. Returns modal root.
function tsBuildPickerModal(options, hooks) {
  const opts = Array.isArray(options) ? options : [];
  const doc = tsUiDoc(hooks);
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("tsBuildPickerModal requires a document");
  }

  const { modal, overlay, panel } = tsUiShell(doc, "ts-picker-modal");
  panel.style.width = "min(560px,92vw)";
  panel.style.maxHeight = "80vh";

  let closed = false;
  let onKey = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (onKey) doc.removeEventListener("keydown", onKey);
    modal.remove();
  };
  const cancel = () => {
    if (!closed && hooks && typeof hooks.onCancel === "function") hooks.onCancel();
    close();
  };

  const header = doc.createElement("h3");
  header.className = "ts-picker-title";
  header.textContent =
    `${opts.length} matching tab${opts.length === 1 ? "" : "s"} — pick one to open`;
  header.style.cssText =
    "margin:0;flex:none;font-family:'TS Playfair','Playfair Display',Georgia," +
    "'Times New Roman',serif;font-size:17px;font-weight:600;letter-spacing:.3px;" +
    "color:var(--ts-text,#1b160e);";
  panel.appendChild(header);
  panel.appendChild(tsUiGoldRule(doc));

  const list = doc.createElement("div");
  list.className = "ts-picker-list";
  list.style.cssText =
    "overflow-y:auto;max-height:60vh;margin-bottom:14px;border-radius:10px;" +
    "border:1px solid var(--ts-hairline,rgba(33,28,20,.09));" +
    "background:var(--ts-bg-raise,#fdfaf2);";

  opts.forEach((option, index) => {
    const row = doc.createElement("div");
    row.className = "ts-picker-row";
    row.setAttribute("role", "button");
    row.dataset.tabId = option && option.id != null ? String(option.id) : "";
    row.style.cssText =
      "display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;" +
      "transition:background .15s ease;color:var(--ts-text,#1b160e);" +
      (index < opts.length - 1
        ? "border-bottom:1px solid var(--ts-hairline,rgba(33,28,20,.09));"
        : "");
    row.addEventListener("mouseenter", () => { row.style.background = "var(--ts-fill,rgba(33,28,20,.04))"; });
    row.addEventListener("mouseleave", () => { row.style.background = ""; });

    const favUrl = option && option.favIconUrl;
    if (favUrl) {
      const img = doc.createElement("img");
      img.className = "ts-picker-favicon";
      img.alt = "";
      img.src = favUrl;
      img.style.cssText = "width:20px;height:20px;flex:none;border-radius:4px;object-fit:cover;";
      img.onerror = () => { img.replaceWith(tsUiFaviconFallback(doc)); };
      row.appendChild(img);
    } else {
      row.appendChild(tsUiFaviconFallback(doc));
    }

    const col = doc.createElement("div");
    col.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;";
    const titleEl = doc.createElement("span");
    titleEl.className = "ts-picker-row-title";
    titleEl.textContent = (option && option.title) || "Untitled tab";
    titleEl.style.cssText =
      "font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    col.appendChild(titleEl);
    const hostEl = doc.createElement("span");
    hostEl.className = "ts-picker-row-host";
    hostEl.textContent = tsExtractHost(option && option.url) ||
      ((option && option.url) ? String(option.url).slice(0, 60) : "");
    hostEl.style.cssText =
      "font-size:11px;color:var(--ts-text-muted,#6b6150);" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    col.appendChild(hostEl);
    row.appendChild(col);

    row.addEventListener("click", () => {
      try {
        if (typeof hooks.onPick === "function") hooks.onPick(option.id, option);
      } finally {
        close();
      }
    });
    list.appendChild(row);
  });

  panel.appendChild(list);

  const footer = doc.createElement("div");
  footer.style.cssText = "display:flex;justify-content:flex-end;flex:none;";
  const cancelBtn = tsUiButton(doc, "ghost");
  cancelBtn.addEventListener("click", cancel);
  footer.appendChild(cancelBtn);
  panel.appendChild(footer);

  overlay.addEventListener("click", cancel);
  onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  doc.addEventListener("keydown", onKey);

  return modal;
}

// Persistent ivory error dialog: gold accent, "Something went wrong" header,
// message body, one Cancel button. NO auto-dismiss timer anywhere.
// hooks: { onCancel(), document }. Returns modal root.
function tsBuildErrorDialog(message, hooks) {
  const doc = tsUiDoc(hooks);
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("tsBuildErrorDialog requires a document");
  }

  const { modal, panel } = tsUiShell(doc, "ts-error-dialog");
  panel.style.width = "min(420px,92vw)";

  const icon = doc.createElement("div");
  icon.textContent = "!";
  icon.style.cssText =
    "width:34px;height:34px;flex:none;display:flex;align-items:center;" +
    "justify-content:center;margin-bottom:10px;border-radius:50%;" +
    "font-size:18px;font-weight:700;" +
    "border:1.5px solid var(--ts-accent,#9c7817);color:var(--ts-accent,#9c7817);";
  panel.appendChild(icon);

  const title = doc.createElement("h3");
  title.className = "ts-error-dialog-title";
  title.textContent = "Something went wrong";
  title.style.cssText =
    "margin:0;flex:none;font-family:'TS Playfair','Playfair Display',Georgia," +
    "'Times New Roman',serif;font-size:18px;font-weight:600;letter-spacing:.3px;" +
    "color:var(--ts-text,#1b160e);";
  panel.appendChild(title);
  panel.appendChild(tsUiGoldRule(doc));

  const body = doc.createElement("p");
  body.className = "ts-error-dialog-message";
  body.textContent = message == null ? "" : String(message);
  body.style.cssText =
    "margin:0 0 16px;font-size:13px;line-height:1.55;white-space:pre-wrap;" +
    "word-break:break-word;color:var(--ts-text,#1b160e);";
  panel.appendChild(body);

  const footer = doc.createElement("div");
  footer.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex:none;";

  // "Copy Details" button — lets the user report the error with diagnostics
  const copyBtn = tsUiButton(doc, "ghost");
  copyBtn.textContent = "Copy Details";
  copyBtn.style.fontSize = "12px";
  copyBtn.addEventListener("click", () => {
    const diag = JSON.stringify({
      error: message, url: location.href, ts: new Date().toISOString(),
      userAgent: navigator.userAgent.slice(0, 120)
    }, null, 1);
    try { navigator.clipboard.writeText(diag); copyBtn.textContent = "Copied!"; } catch(e) { copyBtn.textContent = "Copy failed"; }
    setTimeout(() => { copyBtn.textContent = "Copy Details"; }, 2500);
  });
  footer.appendChild(copyBtn);

  const cancelBtn = tsUiButton(doc, "solid");
  footer.appendChild(cancelBtn);
  panel.appendChild(footer);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (onKey) doc.removeEventListener("keydown", onKey);
    modal.remove();
  };
  const cancel = () => {
    if (!closed && hooks && typeof hooks.onCancel === "function") hooks.onCancel();
    close();
  };
  cancelBtn.addEventListener("click", cancel);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  doc.addEventListener("keydown", onKey);

  return modal;
}

function tsExtractHost(url) {
  try {
    return new URL(url).hostname || "";
  } catch (e) {
    return "";
  }
}

// var (not const): Chrome re-injects content scripts on extension reload and
// navigation. A top-level `const` throws "already been declared" on the second
// injection; `var` silently re-declares. Object.freeze still makes the
// resulting object immutable.
var UIDialogs = (function() {
  "use strict";
  return Object.freeze({
    buildPickerModal: tsBuildPickerModal,
    buildErrorDialog: tsBuildErrorDialog,
  });
})();

// Node-side export so the dialog builders can be tested without Chrome APIs
// (same pattern as command-agent.js).
if (typeof module !== "undefined" && module.exports) {
  module.exports = UIDialogs;
}
// ===== UI DIALOG BUILDERS — END UIDIALOGS =====
