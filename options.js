// options.js — Tab Scroller Luxury Editorial Configuration Engine

// --- Save & Sync Settings ---
const saveOptions = () => {
  const settings = {
    autoScroll: document.getElementById('autoScroll')?.checked ?? true,
    theme: document.getElementById('theme')?.value ?? 'system',
    bgMode: document.getElementById('bgMode')?.value ?? 'ivory',
    displayMode: document.getElementById('displayMode')?.value ?? 'always_show',
    collapseDelay: parseInt(document.getElementById('collapseDelay')?.value, 10) || 1500,
    stripColor: document.getElementById('stripColor')?.value ?? '#0c0c0f',
    enableAi: document.getElementById('enableAi')?.checked ?? false,
    enableShield: document.getElementById('enableShield')?.checked ?? false,
    aiModel: document.getElementById('aiModel')?.value ?? 'gemini-3.1-flash-lite',
    aiFreeTierMode: document.getElementById('aiFreeTierMode')?.checked ?? true,
    aiInsightBatchSize: parseInt(document.getElementById('aiInsightBatchSize')?.value, 10) || 20,
    aiMaxCandidates: parseInt(document.getElementById('aiMaxCandidates')?.value, 10) || 60,
    aiMinGapMs: parseInt(document.getElementById('aiMinGapMs')?.value, 10) || 2000,
    enableAutoFallback: document.getElementById('enableAutoFallback')?.checked ?? true,
    fallbackNotifications: document.getElementById('fallbackNotifications')?.checked ?? true,
    fallbackTier: document.getElementById('fallbackTier')?.value ?? 'auto',
    selectionEngine: document.getElementById('selectionEngine')?.value ?? 'nli',
    useOllama: document.getElementById('useOllama')?.checked ?? false,
    ollamaUrl: document.getElementById('ollamaUrl')?.value ?? 'http://localhost:11434',
    ollamaModel: document.getElementById('ollamaModel')?.value ?? 'qwen2.5-coder:3b',
    ollamaTimeout: (parseInt(document.getElementById('ollamaTimeout')?.value, 10) || 60) * 1000,
    fallbackToOllama: document.getElementById('fallbackToOllama')?.checked ?? true,
    useBackend: document.getElementById('useBackend')?.checked ?? false,
    backendUrl: document.getElementById('backendUrl')?.value?.trim() ?? 'http://localhost:8000',
    backendApiKey: document.getElementById('backendApiKey')?.value?.trim() ?? '',
    enableSessionMemory: document.getElementById('enableSessionMemory')?.checked ?? true,
    autoStartSession: document.getElementById('autoStartSession')?.checked ?? true,
    sessionSnippets: document.getElementById('sessionSnippets')?.checked ?? true,
    sessionRetention: parseInt(document.getElementById('sessionRetention')?.value, 10) || 50,
    allowCloudContent: document.getElementById('allowCloudContent')?.checked ?? false,
  };
  
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.set(settings, () => {
      const apiKey = document.getElementById('geminiApiKey')?.value ?? '';
      chrome.storage.local.set({ geminiApiKey: apiKey }, () => {
        showSaveToast();
      });
    });
  } else {
    showSaveToast();
  }

  updateLivePreview();
};

const showSaveToast = () => {
  const status = document.getElementById('status');
  if (status) {
    status.classList.add('visible');
    setTimeout(() => {
      status.classList.remove('visible');
    }, 1200);
  }
};

const updateLivePreview = () => {
  const theme = document.getElementById('theme')?.value || 'system';
  const bgMode = document.getElementById('bgMode')?.value || 'ivory';
  const preview = document.getElementById('liveBarPreview');

  // Apply theme to document
  if (theme === 'light' || bgMode === 'ivory') {
    document.documentElement.setAttribute('data-theme', 'ivory');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  // Update preview bar style
  if (preview) {
    if (bgMode === 'ivory') {
      preview.style.background = '#faf4e6';
      preview.style.borderColor = 'rgba(156, 120, 23, 0.4)';
    } else if (bgMode === 'charcoal') {
      preview.style.background = '#1a1918';
      preview.style.borderColor = 'rgba(212, 175, 55, 0.3)';
    } else {
      preview.style.background = '#0c0c0e';
      preview.style.borderColor = 'rgba(212, 175, 55, 0.2)';
    }
  }
};

const restoreOptions = () => {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return;

  chrome.storage.sync.get({
    autoScroll: true,
    theme: 'system',
    bgMode: 'ivory',
    displayMode: 'always_show',
    collapseDelay: 1500,
    stripColor: '#0c0c0f',
    enableAi: false,
    enableShield: false,
    aiModel: 'gemini-3.1-flash-lite',
    aiFreeTierMode: true,
    aiInsightBatchSize: 20,
    aiMaxCandidates: 60,
    aiMinGapMs: 2000,
    enableAutoFallback: true,
    fallbackNotifications: true,
    fallbackTier: 'auto',
    selectionEngine: 'nli',
    useOllama: false,
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5-coder:3b',
    ollamaTimeout: 60000,
    fallbackToOllama: true,
    allowCloudContent: false,
    useBackend: false,
    backendUrl: 'http://localhost:8000',
    backendApiKey: '',
    enableSessionMemory: true,
    autoStartSession: true,
    sessionSnippets: true,
    sessionRetention: 50,
  }, (items) => {
    const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    const setValue = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    setChecked('autoScroll', items.autoScroll);
    setValue('theme', items.theme);
    setValue('bgMode', items.bgMode || 'ivory');
    setValue('displayMode', items.displayMode);
    setValue('collapseDelay', items.collapseDelay);
    setValue('stripColor', items.stripColor || '#0c0c0f');
    setChecked('enableAi', items.enableAi);
    setChecked('enableShield', items.enableShield);
    setValue('aiModel', items.aiModel);
    setChecked('aiFreeTierMode', items.aiFreeTierMode);
    setValue('aiInsightBatchSize', items.aiInsightBatchSize);
    setValue('aiMaxCandidates', items.aiMaxCandidates);
    setValue('aiMinGapMs', items.aiMinGapMs);
    setChecked('enableAutoFallback', items.enableAutoFallback);
    setChecked('fallbackNotifications', items.fallbackNotifications);
    setValue('fallbackTier', items.fallbackTier);
    setValue('selectionEngine', items.selectionEngine || 'nli');
    setChecked('useOllama', items.useOllama || false);
    setValue('ollamaUrl', items.ollamaUrl || 'http://localhost:11434');
    setValue('ollamaModel', items.ollamaModel || 'qwen2.5-coder:3b');
    setValue('ollamaTimeout', Math.round((items.ollamaTimeout || 60000) / 1000));
    setChecked('fallbackToOllama', items.fallbackToOllama !== false);
    setChecked('allowCloudContent', items.allowCloudContent || false);
    setChecked('useBackend', items.useBackend || false);
    setValue('backendUrl', items.backendUrl || 'http://localhost:8000');
    setValue('backendApiKey', items.backendApiKey || '');
    setChecked('enableSessionMemory', items.enableSessionMemory !== false);
    setChecked('autoStartSession', items.autoStartSession !== false);
    setChecked('sessionSnippets', items.sessionSnippets !== false);
    setValue('sessionRetention', items.sessionRetention || 50);

    chrome.storage.local.get({ geminiApiKey: '' }, (localItems) => {
      setValue('geminiApiKey', localItems.geminiApiKey || '');
    });

    updateLivePreview();
    toggleUsageDashboard(items.enableAi);
    if (items.enableAi) refreshUsageDashboard();
  });
};

// --- Category Navigation ---
function initNavigation() {
  const navButtons = document.querySelectorAll('.nav-item[data-target]');
  const sections = document.querySelectorAll('.category-section');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      navButtons.forEach(b => b.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      const targetSection = document.getElementById(targetId);
      if (targetSection) {
        targetSection.classList.add('active');
      }
    });
  });
}

// --- Usage Dashboard ---
function toggleUsageDashboard(show) {
  const el = document.getElementById('usageDashboard');
  if (el) el.style.display = show ? 'flex' : 'none';
}

function refreshUsageDashboard() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  chrome.runtime.sendMessage({ type: 'GET_AI_USAGE' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const { stats, lastCallAt } = response;
    const currentModel = document.getElementById('aiModel')?.value;
    const lastCallEl = document.getElementById('usageLastCall');
    const container = document.getElementById('usageModels');

    if (lastCallEl) {
      if (lastCallAt) {
        const ago = Math.round((Date.now() - lastCallAt) / 1000);
        lastCallEl.textContent = ago < 60 ? `Last API call: ${ago}s ago` : `Last API call: ${Math.round(ago / 60)}m ago`;
      } else {
        lastCallEl.textContent = 'No API calls recorded this session';
      }
    }

    if (container && stats) {
      container.innerHTML = '';
      for (const [model, data] of Object.entries(stats)) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-raise); padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; font-size: 12px;';
        card.innerHTML = `<strong>${model}</strong>: ${data.callsToday || 0} calls today (${data.callsThisMinute || 0} RPM)`;
        container.appendChild(card);
      }
    }
  });
}

// --- Test Connections ---
function initConnectionTests() {
  // Test Ollama
  document.getElementById('testOllamaBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('ollamaStatus');
    const testBtn = document.getElementById('testOllamaBtn');
    const url = document.getElementById('ollamaUrl')?.value || 'http://localhost:11434';
    
    if (statusEl) {
      statusEl.textContent = '⏳ Testing connection...';
      statusEl.style.color = 'var(--accent)';
    }
    if (testBtn) testBtn.disabled = true;

    try {
      const resp = await fetch(`${url}/api/tags`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const count = data.models?.length || 0;
      if (statusEl) {
        statusEl.textContent = `✅ Connected! Found ${count} model(s).`;
        statusEl.style.color = '#34a853';
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `❌ Failed: ${err.message} (Is Ollama running?)`;
        statusEl.style.color = '#ea4335';
      }
    } finally {
      if (testBtn) testBtn.disabled = false;
    }
  });

  // Test Backend Gateway
  document.getElementById('testBackendBtn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('backendStatus');
    const testBtn = document.getElementById('testBackendBtn');
    const url = document.getElementById('backendUrl')?.value || 'http://localhost:8000';
    const key = document.getElementById('backendApiKey')?.value || '';

    if (statusEl) {
      statusEl.textContent = '⏳ Testing gateway...';
      statusEl.style.color = 'var(--accent)';
    }
    if (testBtn) testBtn.disabled = true;

    try {
      const headers = key ? { 'Authorization': `Bearer ${key}` } : {};
      const resp = await fetch(`${url}/api/health`, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (statusEl) {
        statusEl.textContent = '✅ Gateway reachable and verified!';
        statusEl.style.color = '#34a853';
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `❌ Unreachable: ${err.message}`;
        statusEl.style.color = '#ea4335';
      }
    } finally {
      if (testBtn) testBtn.disabled = false;
    }
  });
}

// =====================================================
// DATA PORTABILITY (BACKUP & RESTORE) ENGINE
// =====================================================

function simplifyBookmarkNode(node) {
  if (node.url) return { title: node.title, url: node.url };
  const simplified = { title: node.title, children: [] };
  if (node.children) {
    node.children.forEach(child => {
      simplified.children.push(simplifyBookmarkNode(child));
    });
  }
  return simplified;
}

async function getBookmarksBackup() {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree(tree => {
      const root = tree[0];
      const simplifiedRoot = [];
      if (root && root.children) {
        root.children.forEach(node => simplifiedRoot.push(simplifyBookmarkNode(node)));
      }
      resolve(simplifiedRoot);
    });
  });
}

async function getTabsBackup() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groups = await chrome.tabGroups.query({});
  const groupMap = new Map(groups.map(g => [g.id, g]));

  return tabs
    .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
    .map(t => {
      const tabData = {
        title: t.title || '',
        url: t.url,
        pinned: t.pinned || false
      };
      if (t.groupId !== -1 && groupMap.has(t.groupId)) {
        const g = groupMap.get(t.groupId);
        tabData.group = {
          title: g.title || '',
          color: g.color || 'grey',
          collapsed: g.collapsed || false
        };
      }
      return tabData;
    });
}

async function getSettingsBackup() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (syncItems) => {
      chrome.storage.local.get({ geminiApiKey: '' }, (localItems) => {
        resolve({ sync: syncItems, local: localItems });
      });
    });
  });
}

async function getSessionMemoryBackup() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ session_index: [] }, async (items) => {
      const index = items.session_index || [];
      const sessions = {};
      for (const entry of index) {
        const sesKey = 'session_' + entry.id;
        const sesData = await new Promise(res => chrome.storage.local.get({ [sesKey]: null }, r => res(r[sesKey])));
        if (sesData) sessions[sesKey] = sesData;
      }
      resolve({ index, sessions });
    });
  });
}

async function runExport() {
  const exportBtn = document.getElementById('exportPortabilityBtn');
  const importStatus = document.getElementById('importStatus');
  if (!exportBtn) return;

  exportBtn.disabled = true;
  exportBtn.textContent = '⏳ Preparing Backup...';
  
  try {
    const backup = {
      metadata: {
        version: '1.0.0',
        exportedAt: Date.now()
      }
    };

    const doTabs = document.getElementById('portabilityTabs')?.checked;
    const doBookmarks = document.getElementById('portabilityBookmarks')?.checked;
    const doSettings = document.getElementById('portabilitySettings')?.checked;
    const doSessions = document.getElementById('portabilitySessions')?.checked;

    if (doTabs) backup.tabs = await getTabsBackup();
    if (doBookmarks) backup.bookmarks = await getBookmarksBackup();
    if (doSettings) backup.settings = await getSettingsBackup();
    if (doSessions) backup.sessionMemory = await getSessionMemoryBackup();

    const jsonStr = JSON.stringify(backup, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `tab-scroller-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    if (importStatus) {
      importStatus.style.color = '#34a853';
      importStatus.textContent = '✅ Backup created successfully!';
    }
  } catch (e) {
    if (importStatus) {
      importStatus.style.color = '#ea4335';
      importStatus.textContent = `❌ Export failed: ${e.message}`;
    }
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = '📤 Create & Download Backup File (.json)';
  }
}

async function importSettings(settings) {
  if (!settings) return;
  if (settings.sync) await new Promise(resolve => chrome.storage.sync.set(settings.sync, resolve));
  if (settings.local?.geminiApiKey) {
    await new Promise(resolve => chrome.storage.local.set({ geminiApiKey: settings.local.geminiApiKey }, resolve));
  }
  restoreOptions();
}

async function createBookmarkRecursive(parentId, node) {
  if (node.url) {
    await new Promise(resolve => chrome.bookmarks.create({ parentId, title: node.title, url: node.url }, resolve));
    return;
  }
  const folder = await new Promise(resolve => chrome.bookmarks.create({ parentId, title: node.title }, resolve));
  if (folder?.id && node.children) {
    for (const child of node.children) {
      await createBookmarkRecursive(folder.id, child);
    }
  }
}

async function importBookmarks(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) return;
  return new Promise((resolve) => {
    chrome.bookmarks.getTree(async (tree) => {
      const root = tree[0];
      let parentFolderId = '2';
      if (root?.children && root.children.length > 1) {
        parentFolderId = root.children[1].id || '2';
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      const folderName = `Imported Bookmarks — ${dateStr}`;
      const mainFolder = await new Promise(res => chrome.bookmarks.create({ parentId: parentFolderId, title: folderName }, res));
      if (mainFolder?.id) {
        for (const item of bookmarks) {
          await createBookmarkRecursive(mainFolder.id, item);
        }
      }
      resolve();
    });
  });
}

async function importSessionMemory(sm) {
  if (!sm?.index) return;
  const existingItems = await new Promise(res => chrome.storage.local.get({ session_index: [] }, res));
  const wipeKeys = (existingItems.session_index || []).map(e => 'session_' + e.id);
  wipeKeys.push('session_index', 'session_active');
  await new Promise(resolve => chrome.storage.local.remove(wipeKeys, resolve));
  await new Promise(resolve => chrome.storage.local.set({ session_index: sm.index }, resolve));
  if (sm.sessions) await new Promise(resolve => chrome.storage.local.set(sm.sessions, resolve));
}

// Memory-safe hibernated tab restore
async function importTabs(tabs) {
  if (!tabs || tabs.length === 0) return;

  const importStatus = document.getElementById('importStatus');
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 250;

  const firstUrl = tabs[0].url;
  const newWindow = await new Promise(resolve =>
    chrome.windows.create({ url: firstUrl, focused: true }, resolve)
  );

  if (!newWindow?.tabs || newWindow.tabs.length === 0) return;
  const firstTabId = newWindow.tabs[0].id;

  const tabsToGroup = {};
  const groupMeta = {};

  if (tabs[0].group) {
    const title = tabs[0].group.title;
    tabsToGroup[title] = [firstTabId];
    groupMeta[title] = tabs[0].group;
  }

  const pendingDiscardTabs = new Set();
  function onTabUpdated(tabId, changeInfo, tab) {
    if (pendingDiscardTabs.has(tabId)) {
      const url = tab.url || changeInfo.url;
      if (url && !url.startsWith('about:') && url !== 'chrome://newtab/') {
        pendingDiscardTabs.delete(tabId);
        chrome.tabs.discard(tabId).catch(() => {});
      }
    }
  }

  chrome.tabs.onUpdated.addListener(onTabUpdated);

  try {
    for (let i = 1; i < tabs.length; i += BATCH_SIZE) {
      const batch = tabs.slice(i, i + BATCH_SIZE);

      if (importStatus) {
        const pct = Math.round((i / tabs.length) * 100);
        importStatus.textContent = `⏳ Hibernating & restoring: ${i} / ${tabs.length} (${pct}%)...`;
      }

      const createdBatch = await Promise.all(
        batch.map(async (t) => {
          try {
            const openedTab = await new Promise(resolve =>
              chrome.tabs.create(
                { windowId: newWindow.id, url: t.url, pinned: t.pinned || false, active: false },
                resolve
              )
            );

            if (openedTab?.id && !t.pinned) {
              if (openedTab.url && !openedTab.url.startsWith('about:')) {
                chrome.tabs.discard(openedTab.id).catch(() => {});
              } else {
                pendingDiscardTabs.add(openedTab.id);
              }
            }
            return { tab: openedTab, data: t };
          } catch (err) {
            return null;
          }
        })
      );

      for (const item of createdBatch) {
        if (item?.tab?.id && item.data.group) {
          const title = item.data.group.title;
          if (!tabsToGroup[title]) {
            tabsToGroup[title] = [];
            groupMeta[title] = item.data.group;
          }
          tabsToGroup[title].push(item.tab.id);
        }
      }

      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }

    if (pendingDiscardTabs.size > 0) {
      await new Promise(r => setTimeout(r, 500));
      for (const tabId of pendingDiscardTabs) {
        chrome.tabs.get(tabId, (tab) => {
          if (!chrome.runtime.lastError && tab?.url && !tab.url.startsWith('about:')) {
            chrome.tabs.discard(tab.id).catch(() => {});
          }
        });
      }
      pendingDiscardTabs.clear();
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
  }

  if (importStatus) importStatus.textContent = '⏳ Organizing tab groups...';
  for (const [title, tabIds] of Object.entries(tabsToGroup)) {
    if (tabIds.length > 0) {
      try {
        const groupId = await chrome.tabs.group({ tabIds });
        const meta = groupMeta[title];
        await chrome.tabGroups.update(groupId, {
          title: title,
          color: meta.color || 'grey'
        });
        if (meta.collapsed) {
          await chrome.tabGroups.update(groupId, { collapsed: true });
        }
      } catch (err) {}
    }
  }
}

async function runImport(backup) {
  const importStatus = document.getElementById('importStatus');
  try {
    let importedCount = 0;
    if (backup.settings) { await importSettings(backup.settings); importedCount++; }
    if (backup.bookmarks) { await importBookmarks(backup.bookmarks); importedCount++; }
    if (backup.sessionMemory) { await importSessionMemory(backup.sessionMemory); importedCount++; }
    if (backup.tabs) { await importTabs(backup.tabs); importedCount++; }
    if (importStatus) {
      importStatus.style.color = '#34a853';
      importStatus.textContent = `✅ Successfully restored ${importedCount} categories of data!`;
    }
  } catch (e) {
    if (importStatus) {
      importStatus.style.color = '#ea4335';
      importStatus.textContent = `❌ Import error: ${e.message}`;
    }
  }
}

function handleFileImport(file) {
  const importStatus = document.getElementById('importStatus');
  if (importStatus) {
    importStatus.style.color = 'var(--accent)';
    importStatus.textContent = '⏳ Reading file...';
  }
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.metadata?.version) throw new Error('Invalid file format: metadata missing.');
      if (importStatus) importStatus.textContent = '⏳ Importing data...';
      await runImport(backup);
    } catch (err) {
      if (importStatus) {
        importStatus.style.color = '#ea4335';
        importStatus.textContent = `❌ Import failed: ${err.message}`;
      }
    }
  };
  reader.onerror = () => {
    if (importStatus) {
      importStatus.style.color = '#ea4335';
      importStatus.textContent = '❌ Failed to read backup file.';
    }
  };
  reader.readAsText(file);
}

function initPortability() {
  const exportBtn = document.getElementById('exportPortabilityBtn');
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  if (exportBtn) exportBtn.addEventListener('click', runExport);
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--accent)';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = 'var(--border)';
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--border)';
      const file = e.dataTransfer.files[0];
      if (file) handleFileImport(file);
    });
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileImport(file);
    });
  }
}

// --- Wire Up All Change Listeners for Auto-Save ---
function initAutoSave() {
  const inputs = document.querySelectorAll('input, select');
  inputs.forEach(input => {
    if (input.id && input.id !== 'fileInput') {
      input.addEventListener('change', saveOptions);
      if (input.type === 'text' || input.type === 'password' || input.type === 'number') {
        input.addEventListener('input', () => {
          clearTimeout(input._saveTimer);
          input._saveTimer = setTimeout(saveOptions, 400);
        });
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initConnectionTests();
  initPortability();
  initAutoSave();
  restoreOptions();
});
