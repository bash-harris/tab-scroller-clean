// session-manager.js
// Session Manager Panel — renders session list, detail views, and controls
(function() {
  'use strict';

  // --- DOM Refs ---
  const $ = (sel) => document.querySelector(sel);
  const activeBanner = $('#activeBanner');
  const noActiveBanner = $('#noActiveBanner');
  const activeSessionName = $('#activeSessionName');
  const activeTabCount = $('#activeTabCount');
  const activeDuration = $('#activeDuration');
  const activeActions = $('#activeActions');
  const sessionList = $('#sessionList');
  const sessionCount = $('#sessionCount');
  const emptyState = $('#emptyState');
  const searchInput = $('#sessionSearch');
  const toast = $('#toast');

  // Detail Modal
  const detailModal = $('#detailModal');
  const modalTitle = $('#modalTitle');
  const modalMeta = $('#modalMeta');
  const modalSummary = $('#modalSummary');
  const modalSummaryText = $('#modalSummaryText');
  const modalTabList = $('#modalTabList');
  const modalTimeline = $('#modalTimeline');

  // Rename Modal
  const renameModal = $('#renameModal');
  const renameName = $('#renameName');
  const renameTopic = $('#renameTopic');
  const renameSessionId = $('#renameSessionId');

  let currentDetailSessionId = null;

  // --- Helpers ---
  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, message: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return '0m';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h ${remainMins}m`;
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  function faviconUrl(url) {
    try {
      const host = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?sz=16&domain=${host}`;
    } catch {
      return '';
    }
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // --- Render Active Session ---
  async function renderActiveSession() {
    const resp = await sendMsg({ type: 'SESSION_GET_ACTIVE' });
    const session = resp?.session;

    if (session) {
      activeBanner.style.display = 'flex';
      noActiveBanner.style.display = 'none';
      activeSessionName.textContent = session.name || 'Unnamed Session';
      activeTabCount.textContent = `${session.tabCount || session.tabs?.length || 0} tabs`;
      activeDuration.textContent = formatDuration(Date.now() - session.createdAt);
      activeActions.textContent = `${session.actions?.length || 0} actions`;
    } else {
      activeBanner.style.display = 'none';
      noActiveBanner.style.display = 'flex';
    }
  }

  // --- Render Session List ---
  async function renderSessionList(query) {
    let sessions;

    if (query && query.trim()) {
      const resp = await sendMsg({ type: 'SESSION_SEARCH', query });
      sessions = resp?.results || [];
    } else {
      const resp = await sendMsg({ type: 'SESSION_GET_INDEX' });
      sessions = resp?.index || [];
    }

    sessionList.innerHTML = '';

    if (sessions.length === 0) {
      emptyState.style.display = 'block';
      sessionCount.textContent = '0 sessions';
      return;
    }

    emptyState.style.display = 'none';
    sessionCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

    for (const s of sessions) {
      const card = document.createElement('div');
      card.className = 'sm-card';
      card.dataset.sessionId = s.id;

      const durationMs = s.closedAt ? (s.closedAt - s.createdAt) : (s.stats?.duration || 0);

      card.innerHTML = `
        <div class="sm-card-left">
          <div class="sm-card-name">${escHtml(s.name)}</div>
          ${s.topic ? `<div class="sm-card-topic">${escHtml(s.topic)}</div>` : ''}
          <div class="sm-card-meta">
            <span>${formatDate(s.createdAt)}</span>
            <span class="sm-meta-sep">•</span>
            <span>${formatDuration(durationMs)}</span>
          </div>
        </div>
        <div class="sm-card-right">
          <div class="sm-card-stat">
            <span class="sm-card-stat-value">${s.tabCount || 0}</span>
            <span class="sm-card-stat-label">Tabs</span>
          </div>
          <div class="sm-card-actions">
            <button class="sm-card-action restore" title="Restore tabs" data-id="${s.id}">🔄</button>
            <button class="sm-card-action rename" title="Rename" data-id="${s.id}">✏️</button>
            <button class="sm-card-action delete" title="Delete" data-id="${s.id}">🗑</button>
          </div>
        </div>
      `;

      // Click card to open detail
      card.addEventListener('click', (e) => {
        if (e.target.closest('.sm-card-action')) return;
        openDetailModal(s.id);
      });

      sessionList.appendChild(card);
    }

    // Delegate card action clicks
    sessionList.querySelectorAll('.sm-card-action.restore').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const resp = await sendMsg({ type: 'SESSION_RESTORE', id });
        showToast(resp?.message || 'Restored');
      });
    });

    sessionList.querySelectorAll('.sm-card-action.rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRenameModal(btn.dataset.id);
      });
    });

    sessionList.querySelectorAll('.sm-card-action.delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this session? This cannot be undone.')) return;
        await sendMsg({ type: 'SESSION_DELETE', id: btn.dataset.id });
        showToast('Session deleted');
        renderSessionList();
      });
    });
  }

  // --- Detail Modal ---
  async function openDetailModal(id) {
    currentDetailSessionId = id;
    const resp = await sendMsg({ type: 'SESSION_GET', id });
    const session = resp?.session;
    if (!session) {
      showToast('Session not found');
      return;
    }

    modalTitle.textContent = session.name || 'Unnamed Session';
    const durationMs = session.closedAt ? (session.closedAt - session.createdAt) : (session.stats?.duration || 0);

    modalMeta.innerHTML = `
      <div>${formatDate(session.createdAt)} ${formatTime(session.createdAt)} — ${session.closedAt ? formatTime(session.closedAt) : 'Ongoing'}</div>
      <div>${session.tabCount || session.tabs?.length || 0} tabs • ${formatDuration(durationMs)} • ${session.stats?.aiCommandsRun || 0} AI commands</div>
      ${session.topic ? `<div style="margin-top:4px;">Topic: <strong style="color:#8ab4f8;">${escHtml(session.topic)}</strong></div>` : ''}
    `;

    // Summary
    if (session.summary) {
      modalSummary.style.display = 'block';
      modalSummaryText.textContent = session.summary;
    } else {
      modalSummary.style.display = 'none';
    }

    // Tabs
    modalTabList.innerHTML = '';
    const tabs = session.tabs || [];
    for (const tab of tabs.slice(0, 50)) {
      const item = document.createElement('div');
      item.className = `sm-tab-item${tab.important ? ' important' : ''}`;

      const favicon = tab.url ? faviconUrl(tab.url) : '';
      item.innerHTML = `
        ${favicon ? `<img class="sm-tab-favicon" src="${favicon}" alt="">` : '<span class="sm-tab-favicon">📄</span>'}
        <div class="sm-tab-info">
          <div class="sm-tab-title">${escHtml(tab.title || tab.url || 'Untitled')}</div>
          <div class="sm-tab-url">${escHtml(tab.host || tab.url || '')}</div>
          ${tab.snippet ? `<div class="sm-tab-snippet">${escHtml(tab.snippet)}</div>` : ''}
        </div>
      `;
      modalTabList.appendChild(item);
    }

    if (tabs.length > 50) {
      const more = document.createElement('div');
      more.style.cssText = 'padding:8px;text-align:center;color:#6b6f73;font-size:12px;';
      more.textContent = `+ ${tabs.length - 50} more tabs`;
      modalTabList.appendChild(more);
    }

    // Timeline
    modalTimeline.innerHTML = '';
    const actions = session.actions || [];
    const timelineSlice = actions.slice(-80).reverse();
    for (const action of timelineSlice) {
      const item = document.createElement('div');
      item.className = 'sm-timeline-item';

      const typeLabels = {
        tab_opened: '🟢 Tab opened',
        tab_closed: '🔴 Tab closed',
        tab_navigated: '🔵 Navigated',
        tab_snoozed: '😴 Tab snoozed',
        ai_command: '🤖 AI command',
        snapshot: '📸 Snapshot'
      };

      const label = typeLabels[action.type] || action.type;
      const detail = action.title || action.url || action.command || '';

      item.innerHTML = `
        <span class="time">${formatTime(action.ts)}</span>
        <span class="event-type">${label}</span>
        ${detail ? ` — ${escHtml(detail).substring(0, 60)}` : ''}
      `;
      modalTimeline.appendChild(item);
    }

    detailModal.style.display = 'flex';
  }

  function closeDetailModal() {
    detailModal.style.display = 'none';
    currentDetailSessionId = null;
  }

  // --- Rename Modal ---
  async function openRenameModal(id, isActive) {
    renameSessionId.value = id || '';

    if (isActive) {
      const resp = await sendMsg({ type: 'SESSION_GET_ACTIVE' });
      if (resp?.session) {
        renameName.value = resp.session.name || '';
        renameTopic.value = resp.session.topic || '';
        renameSessionId.value = resp.session.id;
      }
    } else if (id) {
      const resp = await sendMsg({ type: 'SESSION_GET', id });
      if (resp?.session) {
        renameName.value = resp.session.name || '';
        renameTopic.value = resp.session.topic || '';
      }
    }

    renameModal.style.display = 'flex';
    renameName.focus();
  }

  function closeRenameModal() {
    renameModal.style.display = 'none';
    renameName.value = '';
    renameTopic.value = '';
    renameSessionId.value = '';
  }

  async function saveRename() {
    const id = renameSessionId.value;
    if (!id) return;

    const name = renameName.value.trim();
    const topic = renameTopic.value.trim();

    if (!name) {
      showToast('Please enter a session name');
      return;
    }

    await sendMsg({ type: 'SESSION_RENAME', id, name, topic });
    closeRenameModal();
    showToast('Session renamed');
    renderActiveSession();
    renderSessionList();
  }

  // --- Event Listeners ---

  // Start Session
  $('#startSessionBtn').addEventListener('click', async () => {
    // Open rename modal for naming the new session
    const resp = await sendMsg({ type: 'SESSION_START' });
    if (resp?.success) {
      showToast('Session started');
      renderActiveSession();
    }
  });

  // End Session
  $('#endSessionBtn').addEventListener('click', async () => {
    if (!confirm('End the current session?')) return;
    const resp = await sendMsg({ type: 'SESSION_END' });
    if (resp?.success) {
      showToast('Session ended and saved');
      renderActiveSession();
      renderSessionList();
    }
  });

  // Rename Active Session
  $('#renameActiveBtn').addEventListener('click', () => {
    openRenameModal(null, true);
  });

  // Search
  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      renderSessionList(searchInput.value);
    }, 300);
  });

  // Detail Modal controls
  $('#modalClose').addEventListener('click', closeDetailModal);
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeDetailModal();
  });

  $('#modalRestore').addEventListener('click', async () => {
    if (!currentDetailSessionId) return;
    const resp = await sendMsg({ type: 'SESSION_RESTORE', id: currentDetailSessionId });
    showToast(resp?.message || 'Restored');
  });

  $('#modalSummarize').addEventListener('click', async () => {
    if (!currentDetailSessionId) return;
    const btn = $('#modalSummarize');
    btn.textContent = '⏳ Generating...';
    btn.disabled = true;

    const resp = await sendMsg({ type: 'SESSION_GENERATE_SUMMARY', id: currentDetailSessionId });

    if (resp?.summary) {
      modalSummary.style.display = 'block';
      modalSummaryText.textContent = resp.summary;
      showToast('Summary generated');
    } else {
      showToast('Failed to generate summary');
    }

    btn.textContent = '🤖 Generate AI Summary';
    btn.disabled = false;
  });

  // Rename Modal controls
  $('#renameClose').addEventListener('click', closeRenameModal);
  $('#renameCancelBtn').addEventListener('click', closeRenameModal);
  $('#renameSaveBtn').addEventListener('click', saveRename);
  renameModal.addEventListener('click', (e) => {
    if (e.target === renameModal) closeRenameModal();
  });

  // Enter key in rename form
  renameName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRename();
  });
  renameTopic.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRename();
  });

  // Keyboard: Escape closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (renameModal.style.display !== 'none') closeRenameModal();
      else if (detailModal.style.display !== 'none') closeDetailModal();
    }
  });

  // --- Init ---
  renderActiveSession();
  renderSessionList();

  // Refresh active session display every 30 seconds
  setInterval(renderActiveSession, 30000);
})();
