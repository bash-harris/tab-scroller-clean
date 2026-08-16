// session-memory.js
// =====================================================
// SESSION MEMORY ENGINE
// Persistent browsing session tracking & recall
// =====================================================

const SessionMemoryEngine = (() => {
  // --- Constants ---
  const MAX_SESSIONS = 50;
  const MAX_ACTIONS_PER_SESSION = 500;
  const MAX_SNIPPET_LENGTH = 300;
  const STORAGE_KEY_ACTIVE = 'session_active';
  const STORAGE_KEY_INDEX = 'session_index';
  const SESSION_PREFIX = 'session_';

  // --- In-memory state ---
  let activeSession = null;
  let sessionEnabled = true;

  // --- Utility ---
  function generateSessionId() {
    return 'ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  }

  function now() {
    return Date.now();
  }

  // --- Storage Helpers ---
  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) {
          resolve(typeof keys === 'object' && keys !== null ? { ...keys } : {});
          return;
        }
        chrome.storage.local.get(keys, (items) => {
          if (chrome.runtime.lastError || !items) {
            resolve(typeof keys === 'object' && keys !== null ? { ...keys } : {});
          } else {
            resolve(items);
          }
        });
      } catch (e) {
        resolve(typeof keys === 'object' && keys !== null ? { ...keys } : {});
      }
    });
  }

  function storageSet(data) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) {
          resolve();
          return;
        }
        chrome.storage.local.set(data, () => {
          const _ = chrome.runtime.lastError;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) {
          resolve();
          return;
        }
        chrome.storage.local.remove(keys, () => {
          const _ = chrome.runtime.lastError;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // --- Index Management ---
  async function getSessionIndex() {
    const items = await storageGet({ [STORAGE_KEY_INDEX]: [] });
    return items[STORAGE_KEY_INDEX] || [];
  }

  async function saveSessionIndex(index) {
    await storageSet({ [STORAGE_KEY_INDEX]: index });
  }

  async function addToIndex(session) {
    const index = await getSessionIndex();
    index.unshift({
      id: session.id,
      name: session.name,
      topic: session.topic,
      createdAt: session.createdAt,
      closedAt: session.closedAt,
      tabCount: session.tabCount || session.tabs.length,
      stats: session.stats
    });
    // Enforce retention limit
    while (index.length > MAX_SESSIONS) {
      const removed = index.pop();
      await storageRemove([SESSION_PREFIX + removed.id]);
    }
    await saveSessionIndex(index);
  }

  async function updateIndexEntry(id, updates) {
    const index = await getSessionIndex();
    const entry = index.find(e => e.id === id);
    if (entry) {
      Object.assign(entry, updates);
      await saveSessionIndex(index);
    }
  }

  async function removeFromIndex(id) {
    let index = await getSessionIndex();
    index = index.filter(e => e.id !== id);
    await saveSessionIndex(index);
    await storageRemove([SESSION_PREFIX + id]);
  }

  // --- Session Lifecycle ---

  async function startSession(name, topic) {
    // End any existing active session first
    if (activeSession) {
      await endSession();
    }

    const sessionName = name || `Session ${new Date().toLocaleString()}`;
    const sessionTopic = topic || '';

    activeSession = {
      id: generateSessionId(),
      name: sessionName,
      topic: sessionTopic,
      createdAt: now(),
      closedAt: null,
      tabs: [],
      actions: [],
      summary: null,
      tabCount: 0,
      stats: {
        tabsOpened: 0,
        tabsClosed: 0,
        tabsSnoozed: 0,
        aiCommandsRun: 0,
        duration: 0
      }
    };

    // Snapshot current open tabs
    try {
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://')) {
          activeSession.tabs.push({
            tabId: tab.id,
            url: tab.url,
            title: tab.title || '',
            host: safeHostForSession(tab.url),
            snippet: '',
            openedAt: activeSession.createdAt,
            closedAt: null,
            actions: ['snapshot'],
            important: false
          });
        }
      }
      activeSession.tabCount = activeSession.tabs.length;
      activeSession.stats.tabsOpened = activeSession.tabs.length;
    } catch (e) {
      console.warn('[SessionMemory] Failed to snapshot tabs:', e.message);
    }

    await persistActiveSession();
    console.log(`[SessionMemory] Started session: "${sessionName}" (${activeSession.id}) with ${activeSession.tabCount} tabs`);
    return { id: activeSession.id, name: sessionName };
  }

  async function endSession() {
    if (!activeSession) return null;

    activeSession.closedAt = now();
    activeSession.stats.duration = activeSession.closedAt - activeSession.createdAt;
    activeSession.tabCount = activeSession.tabs.length;

    // Mark any still-open tabs as closed at session end
    for (const tab of activeSession.tabs) {
      if (!tab.closedAt) {
        tab.closedAt = activeSession.closedAt;
      }
    }

    // Prune action log if too large
    if (activeSession.actions.length > MAX_ACTIONS_PER_SESSION) {
      activeSession.actions = activeSession.actions.slice(-MAX_ACTIONS_PER_SESSION);
    }

    // Archive to individual storage key
    await storageSet({ [SESSION_PREFIX + activeSession.id]: activeSession });

    // Add to index
    await addToIndex(activeSession);

    // Clear active session
    const endedSession = activeSession;
    activeSession = null;
    await storageRemove([STORAGE_KEY_ACTIVE]);

    console.log(`[SessionMemory] Ended session: "${endedSession.name}" — ${endedSession.tabs.length} tabs, ${endedSession.actions.length} actions`);
    return endedSession;
  }

  async function renameSession(id, name, topic) {
    // If renaming the active session
    if (activeSession && activeSession.id === id) {
      if (name) activeSession.name = name;
      if (topic !== undefined) activeSession.topic = topic;
      await persistActiveSession();
      return true;
    }

    // Rename archived session
    const items = await storageGet({ [SESSION_PREFIX + id]: null });
    const session = items[SESSION_PREFIX + id];
    if (!session) return false;

    if (name) session.name = name;
    if (topic !== undefined) session.topic = topic;
    await storageSet({ [SESSION_PREFIX + id]: session });
    await updateIndexEntry(id, { name: session.name, topic: session.topic });
    return true;
  }

  async function deleteSession(id) {
    if (activeSession && activeSession.id === id) {
      activeSession = null;
      await storageRemove([STORAGE_KEY_ACTIVE]);
    }
    await removeFromIndex(id);
    return true;
  }

  // --- Tab Event Recording ---

  async function recordTabEvent(type, tabData) {
    if (!activeSession || !sessionEnabled) return;

    const event = {
      type,
      tabId: tabData.tabId || tabData.id,
      url: tabData.url || '',
      title: tabData.title || '',
      ts: now()
    };

    // Add extra fields for specific event types
    if (type === 'tab_snoozed' && tabData.wakeTime) {
      event.wakeTime = tabData.wakeTime;
    }
    if (type === 'ai_command' && tabData.command) {
      event.command = tabData.command;
    }

    activeSession.actions.push(event);

    // Update stats
    switch (type) {
      case 'tab_opened':
        activeSession.stats.tabsOpened++;
        // Add tab to session tab list
        if (tabData.url && !tabData.url.startsWith('chrome://') && !tabData.url.startsWith('chrome-extension://')) {
          const existingTab = activeSession.tabs.find(t => t.tabId === event.tabId);
          if (!existingTab) {
            activeSession.tabs.push({
              tabId: event.tabId,
              url: tabData.url,
              title: tabData.title || '',
              host: safeHostForSession(tabData.url),
              snippet: '',
              openedAt: event.ts,
              closedAt: null,
              actions: ['opened'],
              important: false
            });
            activeSession.tabCount = activeSession.tabs.length;
          }
        }
        break;

      case 'tab_closed':
        activeSession.stats.tabsClosed++;
        // Mark tab as closed
        const closedTab = activeSession.tabs.find(t => t.tabId === event.tabId);
        if (closedTab && !closedTab.closedAt) {
          closedTab.closedAt = event.ts;
          closedTab.actions.push('closed');
        }
        break;

      case 'tab_navigated':
        // Update tab URL/title if navigated
        const navTab = activeSession.tabs.find(t => t.tabId === event.tabId);
        if (navTab) {
          navTab.url = tabData.url || navTab.url;
          navTab.title = tabData.title || navTab.title;
          navTab.host = safeHostForSession(navTab.url);
          navTab.actions.push('navigated');
        }
        break;

      case 'tab_snoozed':
        activeSession.stats.tabsSnoozed++;
        const snoozedTab = activeSession.tabs.find(t => t.tabId === event.tabId);
        if (snoozedTab) {
          snoozedTab.actions.push('snoozed');
        }
        break;

      case 'ai_command':
        activeSession.stats.aiCommandsRun++;
        break;
    }

    // Prune if too many actions
    if (activeSession.actions.length > MAX_ACTIONS_PER_SESSION) {
      activeSession.actions = activeSession.actions.slice(-MAX_ACTIONS_PER_SESSION);
    }

    // Debounced persist (every 10 events or important events)
    if (activeSession.actions.length % 10 === 0 || type === 'tab_snoozed' || type === 'ai_command') {
      await persistActiveSession();
    }
  }

  async function updateTabSnippet(tabId, snippet) {
    if (!activeSession) return;
    const tab = activeSession.tabs.find(t => t.tabId === tabId);
    if (tab && !tab.snippet) {
      tab.snippet = (snippet || '').substring(0, MAX_SNIPPET_LENGTH);
    }
  }

  async function markTabImportant(sessionId, tabId) {
    if (activeSession && activeSession.id === sessionId) {
      const tab = activeSession.tabs.find(t => t.tabId === tabId);
      if (tab) {
        tab.important = !tab.important;
        await persistActiveSession();
        return tab.important;
      }
    }

    // Check archived sessions
    const items = await storageGet({ [SESSION_PREFIX + sessionId]: null });
    const session = items[SESSION_PREFIX + sessionId];
    if (session) {
      const tab = session.tabs.find(t => t.tabId === tabId);
      if (tab) {
        tab.important = !tab.important;
        await storageSet({ [SESSION_PREFIX + sessionId]: session });
        return tab.important;
      }
    }
    return null;
  }

  // --- Session Retrieval ---

  function getActiveSession() {
    return activeSession;
  }

  async function getSession(id) {
    if (activeSession && activeSession.id === id) {
      return activeSession;
    }
    const items = await storageGet({ [SESSION_PREFIX + id]: null });
    return items[SESSION_PREFIX + id] || null;
  }

  // --- Session Restore ---

  async function restoreSession(id) {
    const session = await getSession(id);
    if (!session) return { success: false, message: 'Session not found' };

    const urlsToOpen = session.tabs
      .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
      .map(t => t.url);

    if (urlsToOpen.length === 0) {
      return { success: false, message: 'No restorable tabs in this session' };
    }

    let opened = 0;
    const newTabIds = [];
    for (const url of urlsToOpen) {
      try {
        const newTab = await chrome.tabs.create({ url, active: false });
        if (newTab?.id) {
          newTabIds.push(newTab.id);
          opened++;
        }
      } catch (e) {
        console.warn(`[SessionMemory] Failed to restore tab: ${url}`, e.message);
      }
    }

    // Group restored tabs
    if (newTabIds.length >= 2) {
      try {
        const groupId = await chrome.tabs.group({ tabIds: newTabIds });
        await chrome.tabGroups.update(groupId, {
          title: `📋 ${session.name}`,
          color: 'cyan'
        });
      } catch (e) {
        console.warn('[SessionMemory] Failed to group restored tabs:', e.message);
      }
    }

    return {
      success: true,
      message: `✅ Restored ${opened}/${urlsToOpen.length} tabs from "${session.name}"`,
      count: opened
    };
  }

  // --- Search ---

  async function searchSessions(query) {
    if (!query || !query.trim()) return [];

    const queryLower = query.toLowerCase().trim();
    const queryWords = queryLower.split(/\s+/);
    const index = await getSessionIndex();
    const results = [];

    for (const entry of index) {
      let score = 0;

      // Search name
      const nameLower = (entry.name || '').toLowerCase();
      if (nameLower.includes(queryLower)) score += 50;
      queryWords.forEach(w => { if (nameLower.includes(w)) score += 10; });

      // Search topic
      const topicLower = (entry.topic || '').toLowerCase();
      if (topicLower.includes(queryLower)) score += 40;
      queryWords.forEach(w => { if (topicLower.includes(w)) score += 8; });

      // Deep search: load full session and search tabs
      if (score === 0) {
        const session = await getSession(entry.id);
        if (session) {
          for (const tab of session.tabs) {
            const titleLower = (tab.title || '').toLowerCase();
            const urlLower = (tab.url || '').toLowerCase();
            const snippetLower = (tab.snippet || '').toLowerCase();

            if (titleLower.includes(queryLower)) { score += 20; break; }
            if (urlLower.includes(queryLower)) { score += 15; break; }
            if (snippetLower.includes(queryLower)) { score += 25; break; }

            for (const w of queryWords) {
              if (titleLower.includes(w)) score += 5;
              if (snippetLower.includes(w)) score += 5;
            }
            if (score > 0) break;
          }
        }
      }

      if (score > 0) {
        results.push({ ...entry, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 20);
  }

  // --- AI Summary ---

  async function generateSessionSummary(id) {
    const session = await getSession(id);
    if (!session) return null;

    // Build a concise prompt from session data
    const tabSummaries = session.tabs
      .slice(0, 30)
      .map(t => `${t.title} (${t.host})`)
      .join('\n');

    const actionSummary = `${session.stats.tabsOpened} tabs opened, ${session.stats.tabsClosed} closed, ${session.stats.tabsSnoozed} snoozed, ${session.stats.aiCommandsRun} AI commands`;

    const durationMin = Math.round((session.stats.duration || 0) / 60000);

    const prompt = `Browsing session "${session.name}" (${durationMin} minutes, ${session.tabCount} tabs):
${actionSummary}

Tabs visited:
${tabSummaries}

Write a 2-3 sentence summary of what this browsing session was about. Be specific about the topics and tasks.`;

    try {
      const response = await callGeminiWithFallback({
        prompt,
        systemInstruction: 'Summarize this browsing session concisely. Focus on the main topics and tasks.',
        responseMimeType: 'text/plain',
        temperature: 0.3,
        maxOutputTokens: 256,
      });

      const summary = response?.text || null;

      if (summary) {
        // Save summary back to session
        if (activeSession && activeSession.id === id) {
          activeSession.summary = summary;
          await persistActiveSession();
        } else {
          session.summary = summary;
          await storageSet({ [SESSION_PREFIX + id]: session });
        }
      }

      return summary;
    } catch (e) {
      console.error('[SessionMemory] Summary generation failed:', e.message);
      return null;
    }
  }

  // --- Persistence ---

  async function persistActiveSession() {
    if (!activeSession) return;
    activeSession.stats.duration = now() - activeSession.createdAt;
    activeSession.tabCount = activeSession.tabs.length;
    await storageSet({ [STORAGE_KEY_ACTIVE]: activeSession });
  }

  // --- Initialization ---

  async function initialize() {
    // Check settings
    const settings = await storageGet({
      enableSessionMemory: true,
      autoStartSession: true
    });
    sessionEnabled = settings.enableSessionMemory !== false;

    if (!sessionEnabled) {
      console.log('[SessionMemory] Disabled by settings');
      return;
    }

    // Try to restore active session from storage
    const items = await storageGet({ [STORAGE_KEY_ACTIVE]: null });
    if (items[STORAGE_KEY_ACTIVE]) {
      activeSession = items[STORAGE_KEY_ACTIVE];
      console.log(`[SessionMemory] Restored active session: "${activeSession.name}" (${activeSession.tabs.length} tabs, ${activeSession.actions.length} actions)`);
    } else if (settings.autoStartSession !== false) {
      // Auto-start a new session
      await startSession();
    }
  }

  function setEnabled(enabled) {
    sessionEnabled = enabled;
  }

  function isEnabled() {
    return sessionEnabled;
  }

  // --- Helper (safe host extraction without relying on background.js's safeHost) ---
  function safeHostForSession(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }

  // Auto-persist every 60 seconds
  setInterval(() => {
    if (activeSession && sessionEnabled) {
      persistActiveSession();
    }
  }, 60 * 1000);

  // --- Public API ---
  return {
    initialize,
    startSession,
    endSession,
    renameSession,
    deleteSession,
    getActiveSession,
    getSessionIndex,
    getSession,
    recordTabEvent,
    updateTabSnippet,
    markTabImportant,
    restoreSession,
    searchSessions,
    generateSessionSummary,
    persistActiveSession,
    setEnabled,
    isEnabled
  };
})();
