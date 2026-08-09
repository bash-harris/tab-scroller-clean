// options.js
const saveOptions = () => {
  const settings = {
    autoScroll: document.getElementById('autoScroll').checked,
    theme: document.getElementById('theme').value,
    displayMode: document.getElementById('displayMode').value,
    collapseDelay: parseInt(document.getElementById('collapseDelay').value, 10) || 1500,
    stripColor: document.getElementById('stripColor').value,
    enableAi: document.getElementById('enableAi').checked,
    enableShield: document.getElementById('enableShield').checked,
    aiModel: document.getElementById('aiModel').value,
    aiFreeTierMode: document.getElementById('aiFreeTierMode').checked,
    aiInsightBatchSize: parseInt(document.getElementById('aiInsightBatchSize').value, 10) || 20,
    aiMaxCandidates: parseInt(document.getElementById('aiMaxCandidates').value, 10) || 60,
    aiMinGapMs: parseInt(document.getElementById('aiMinGapMs').value, 10) || 2000,
    enableAutoFallback: document.getElementById('enableAutoFallback').checked,
    fallbackNotifications: document.getElementById('fallbackNotifications').checked,
    fallbackTier: document.getElementById('fallbackTier').value,
    // ===== NEW: Ollama Settings =====
    useOllama: document.getElementById('useOllama').checked,
    ollamaUrl: document.getElementById('ollamaUrl').value,
    ollamaModel: document.getElementById('ollamaModel').value,
    ollamaTimeout: parseInt(document.getElementById('ollamaTimeout').value, 10) * 1000 || 30000, // Convert to ms
    fallbackToOllama: document.getElementById('fallbackToOllama').checked,
    // ===== AI Backend (Django gateway) Settings =====
    useBackend: document.getElementById('useBackend').checked,
    backendUrl: document.getElementById('backendUrl').value.trim(),
    backendApiKey: document.getElementById('backendApiKey').value.trim(),
    // ===== Session Memory Settings =====
    enableSessionMemory: document.getElementById('enableSessionMemory').checked,
    autoStartSession: document.getElementById('autoStartSession').checked,
    sessionSnippets: document.getElementById('sessionSnippets').checked,
    sessionRetention: parseInt(document.getElementById('sessionRetention').value, 10) || 50,
    allowCloudContent: document.getElementById('allowCloudContent').checked,
  };
  
  chrome.storage.sync.set(settings, () => {
    const apiKey = document.getElementById('geminiApiKey').value;
    chrome.storage.local.set({ geminiApiKey: apiKey }, () => {
      const status = document.getElementById('status');
      status.textContent = 'Options saved.';
      setTimeout(() => { status.textContent = ''; }, 750);
    });
  });
};

const restoreOptions = () => {
  chrome.storage.sync.get({
    autoScroll: true,
    theme: 'system',
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
    // ===== NEW: Ollama Defaults =====
    useOllama: false,
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5-coder:3b',
    ollamaTimeout: 60000,
    fallbackToOllama: true,
    allowCloudContent: false,
    // ===== AI Backend Defaults =====
    useBackend: false,
    backendUrl: 'http://localhost:8000',
    backendApiKey: '',
    // ===== Session Memory Defaults =====
    enableSessionMemory: true,
    autoStartSession: true,
    sessionSnippets: true,
    sessionRetention: 50,
  }, (items) => {
    document.getElementById('autoScroll').checked = items.autoScroll;
    document.getElementById('theme').value = items.theme;
    document.getElementById('displayMode').value = items.displayMode;
    document.getElementById('collapseDelay').value = items.collapseDelay;
    document.getElementById('stripColor').value = items.stripColor || '#0c0c0f';
    document.getElementById('enableAi').checked = items.enableAi;
    document.getElementById('enableShield').checked = items.enableShield;
    document.getElementById('aiModel').value = items.aiModel;
    document.getElementById('aiFreeTierMode').checked = items.aiFreeTierMode;
    document.getElementById('aiInsightBatchSize').value = items.aiInsightBatchSize;
    document.getElementById('aiMaxCandidates').value = items.aiMaxCandidates;
    document.getElementById('aiMinGapMs').value = items.aiMinGapMs;
    document.getElementById('enableAutoFallback').checked = items.enableAutoFallback;
    document.getElementById('fallbackNotifications').checked = items.fallbackNotifications;
    document.getElementById('fallbackTier').value = items.fallbackTier;
    
    // ===== NEW: Restore Ollama Settings =====
    document.getElementById('useOllama').checked = items.useOllama || false;
    document.getElementById('ollamaUrl').value = items.ollamaUrl || 'http://localhost:11434';
    document.getElementById('ollamaModel').value = items.ollamaModel || 'qwen2.5-coder:3b';
    document.getElementById('ollamaTimeout').value = Math.round((items.ollamaTimeout || 60000) / 1000); // Convert back to seconds
    document.getElementById('fallbackToOllama').checked = items.fallbackToOllama !== false;
    document.getElementById('allowCloudContent').checked = items.allowCloudContent || false;

    // ===== Restore AI Backend Settings =====
    document.getElementById('useBackend').checked = items.useBackend || false;
    document.getElementById('backendUrl').value = items.backendUrl || 'http://localhost:8000';
    document.getElementById('backendApiKey').value = items.backendApiKey || '';

    if (items.useOllama) {
      document.getElementById('ollamaStatus').style.display = 'block';
      document.getElementById('testOllamaBtn')?.click();
    }

    // ===== Restore Session Memory Settings =====
    document.getElementById('enableSessionMemory').checked = items.enableSessionMemory !== false;
    document.getElementById('autoStartSession').checked = items.autoStartSession !== false;
    document.getElementById('sessionSnippets').checked = items.sessionSnippets !== false;
    document.getElementById('sessionRetention').value = items.sessionRetention || 50;
    
    loadFallbackStats();
    
    chrome.storage.local.get({ geminiApiKey: '' }, (localItems) => {
      document.getElementById('geminiApiKey').value = localItems.geminiApiKey || '';
    });

    toggleUsageDashboard(items.enableAi);
    if (items.enableAi) refreshUsageDashboard();
  });
};

// --- Usage Dashboard ---
function toggleUsageDashboard(show) {
  document.getElementById('usageDashboard').style.display = show ? 'block' : 'none';
}

function refreshUsageDashboard() {
  chrome.runtime.sendMessage({ type: 'GET_AI_USAGE' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      document.getElementById('usageModels').innerHTML = '<div class="usage-no-data">Unable to fetch usage data. Ensure the extension is loaded.</div>';
      return;
    }

    const { stats, lastCallAt } = response;
    const currentModel = document.getElementById('aiModel').value;

    // Last call timestamp
    const lastCallEl = document.getElementById('usageLastCall');
    if (lastCallAt) {
      const ago = Math.round((Date.now() - lastCallAt) / 1000);
      if (ago < 60) {
        lastCallEl.textContent = `Last API call: ${ago}s ago`;
      } else if (ago < 3600) {
        lastCallEl.textContent = `Last API call: ${Math.round(ago / 60)}m ago`;
      } else {
        lastCallEl.textContent = `Last API call: ${Math.round(ago / 3600)}h ago`;
      }
    } else {
      lastCallEl.textContent = 'No API calls recorded this session';
    }

    // Render model cards
    const container = document.getElementById('usageModels');
    container.innerHTML = '';

    for (const [model, data] of Object.entries(stats)) {
      const card = document.createElement('div');
      card.className = 'usage-model';

      const isActive = model === currentModel;
      const hasUsage = data.callsToday > 0 || data.callsThisMinute > 0;
      
      // Skip models with no usage and not active — keep dashboard clean
      if (!isActive && !hasUsage) continue;

      // Model name row
      const nameRow = document.createElement('div');
      nameRow.className = 'usage-model-name';
      nameRow.innerHTML = `<span>${model}</span>${isActive ? '<span class="active-badge">ACTIVE</span>' : ''}`;
      card.appendChild(nameRow);

      // Bars container
      const bars = document.createElement('div');
      bars.className = 'usage-bars';

      // RPM bar
      bars.appendChild(makeUsageBar(
        'RPM',
        data.callsThisMinute,
        data.limitRpm
      ));

      // RPD bar
      bars.appendChild(makeUsageBar(
        'RPD',
        data.callsToday,
        data.limitRpd
      ));

      card.appendChild(bars);
      container.appendChild(card);
    }

    if (container.children.length === 0) {
      container.innerHTML = '<div class="usage-no-data">No API usage yet. Make an AI call to see stats here.</div>';
    }
  });
}

function makeUsageBar(label, used, limit) {
  const group = document.createElement('div');
  group.className = 'usage-bar-group';

  const labelRow = document.createElement('div');
  labelRow.className = 'usage-bar-label';
  
  const limitText = limit === null ? '∞' : limit.toLocaleString();
  labelRow.innerHTML = `<span>${label}</span><span>${used.toLocaleString()} / ${limitText}</span>`;
  group.appendChild(labelRow);

  const track = document.createElement('div');
  track.className = 'usage-bar-track';
  
  const fill = document.createElement('div');
  fill.className = 'usage-bar-fill';
  
  let pct = 0;
  if (limit === null) {
    // Unlimited — show tiny bar if any usage, otherwise empty
    pct = used > 0 ? Math.min(10, used) : 0;
  } else if (limit > 0) {
    pct = Math.min(100, (used / limit) * 100);
  }
  
  fill.style.width = `${pct}%`;
  
  if (pct >= 80) fill.classList.add('red');
  else if (pct >= 50) fill.classList.add('yellow');
  else fill.classList.add('green');
  
  track.appendChild(fill);
  group.appendChild(track);
  return group;
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('autoScroll').addEventListener('change', saveOptions);
document.getElementById('theme').addEventListener('change', saveOptions);
document.getElementById('displayMode').addEventListener('change', saveOptions);
document.getElementById('collapseDelay').addEventListener('change', saveOptions);
document.getElementById('enableAi').addEventListener('change', () => {
  saveOptions();
  const enabled = document.getElementById('enableAi').checked;
  toggleUsageDashboard(enabled);
  if (enabled) refreshUsageDashboard();
});
document.getElementById('geminiApiKey').addEventListener('change', saveOptions);
document.getElementById('enableShield').addEventListener('change', saveOptions);
document.getElementById('aiModel').addEventListener('change', () => {
  saveOptions();
  refreshUsageDashboard();
});
document.getElementById('aiFreeTierMode').addEventListener('change', saveOptions);
document.getElementById('aiInsightBatchSize').addEventListener('change', saveOptions);
document.getElementById('aiMaxCandidates').addEventListener('change', saveOptions);
document.getElementById('aiMinGapMs').addEventListener('change', saveOptions);
document.getElementById('usageRefreshBtn').addEventListener('click', refreshUsageDashboard);

document.getElementById('enableAutoFallback').addEventListener('change', saveOptions);
document.getElementById('fallbackNotifications').addEventListener('change', saveOptions);
document.getElementById('fallbackTier').addEventListener('change', saveOptions);

const refreshFallbackBtn = document.getElementById('refreshFallbackStats');
if (refreshFallbackBtn) {
  refreshFallbackBtn.addEventListener('click', () => {
    refreshFallbackBtn.textContent = '⏳ Refreshing...';
    loadFallbackStats();
    setTimeout(() => { refreshFallbackBtn.textContent = '🔄 Refresh Status'; }, 1000);
  });
}
setInterval(loadFallbackStats, 30000);

function addModelTooltips() {
  const modelSelect = document.getElementById('aiModel');
  if (!modelSelect) return;
  modelSelect.addEventListener('change', (e) => {
    const selected = e.target.value;
    const modelInfo = {
      'gemini-3.1-flash-lite': '15 RPM, 500 RPD - Best balance of speed and quota',
      'gemini-2.5-pro': 'Unlimited RPM/RPD - Slowest but most capable',
      'gemma-3-27b': '30 RPM, 14.4K RPD - Highest daily quota',
      'gemini-2.5-flash': '5 RPM, 20 RPD - Fast but low quota'
    };
    const info = modelInfo[selected];
    if (info) console.log(`Model info: ${info}`);
  });
}
document.addEventListener('DOMContentLoaded', addModelTooltips);

function loadFallbackStats() {
  chrome.runtime.sendMessage({ type: 'GET_FALLBACK_STATS' }, (response) => {
    if (!response) return;
    const { stats, currentModel, cooldowns } = response;
    const activeModelDisplay = document.getElementById('activeModelDisplay');
    if (activeModelDisplay) activeModelDisplay.textContent = currentModel || document.getElementById('aiModel').value || 'Not yet used';
    const fallbackCountDisplay = document.getElementById('fallbackCountDisplay');
    if (fallbackCountDisplay) fallbackCountDisplay.textContent = stats?.today || 0;
    const cooldownList = document.getElementById('cooldownList');
    if (cooldownList && cooldowns && cooldowns.length > 0) {
      const now = Date.now();
      const activeCooldowns = cooldowns.filter(([_, time]) => time > now);
      if (activeCooldowns.length > 0) {
        const cooldownHTML = activeCooldowns.map(([model, time]) => {
          const minutesLeft = Math.ceil((time - now) / 60000);
          return `<div style="padding:4px 0;">⏱️ ${model}: ${minutesLeft} min cooldown</div>`;
        }).join('');
        cooldownList.innerHTML = `<div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.1);"><div style="font-weight:600; margin-bottom:4px;">Active Cooldowns:</div>${cooldownHTML}</div>`;
      } else {
        cooldownList.innerHTML = '';
      }
    }
  });
}

// ===== NEW: Ollama Event Listeners =====
document.getElementById('useOllama')?.addEventListener('change', saveOptions);
document.getElementById('ollamaUrl')?.addEventListener('change', saveOptions);
document.getElementById('ollamaModel')?.addEventListener('change', saveOptions);
document.getElementById('ollamaTimeout')?.addEventListener('change', saveOptions);
document.getElementById('fallbackToOllama')?.addEventListener('change', saveOptions);
document.getElementById('allowCloudContent')?.addEventListener('change', saveOptions);

// ===== Session Memory Event Listeners =====
document.getElementById('enableSessionMemory')?.addEventListener('change', saveOptions);
document.getElementById('autoStartSession')?.addEventListener('change', saveOptions);
document.getElementById('sessionSnippets')?.addEventListener('change', saveOptions);
document.getElementById('sessionRetention')?.addEventListener('change', saveOptions);
document.getElementById('openSessionManager')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('session-manager.html') });
});

// Add to options.js - Ollama connection test
document.getElementById('testOllamaBtn')?.addEventListener('click', async () => {
  const statusDiv = document.getElementById('ollamaStatus');
  const statusIcon = document.getElementById('ollamaStatusIcon');
  const statusText = document.getElementById('ollamaStatusText');
  const statusDetail = document.getElementById('ollamaStatusDetail');
  const testBtn = document.getElementById('testOllamaBtn');
  
  statusDiv.style.display = 'block';
  statusIcon.textContent = '🔄';
  statusText.textContent = 'Testing connection...';
  statusText.classList.add('pulsing');
  statusDetail.textContent = '';
  testBtn.disabled = true;
  
  const url = document.getElementById('ollamaUrl').value || 'http://localhost:11434';
  
  try {
    const response = await fetch(`${url}/api/tags`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const models = data.models || [];
    
    statusText.classList.remove('pulsing');
    statusIcon.textContent = '✅';
    statusText.textContent = 'Connected!';
    statusDetail.textContent = `Found ${models.length} model(s): ${models.map(m => m.name).join(', ') || 'none'}`;
    statusDetail.style.color = '#8ab4f8';
    
    if (models.length === 0) {
      statusDetail.textContent += ' ⚠️ No models installed. Run: ollama pull qwen2.5-coder:3b';
      statusDetail.style.color = '#fbbc04';
    }
  } catch (error) {
    statusText.classList.remove('pulsing');
    statusIcon.textContent = '❌';
    statusText.textContent = 'Connection failed';
    statusDetail.textContent = `Error: ${error.message}. Make sure Ollama is running (ollama serve)`;
    statusDetail.style.color = '#ea4335';
  } finally {
    testBtn.disabled = false;
  }
});

// Auto-test when "Use Ollama" is checked
document.getElementById('useOllama')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    document.getElementById('ollamaStatus').style.display = 'block';
    document.getElementById('testOllamaBtn')?.click();
  }
});

// =====================================================
// DATA PORTABILITY (BACKUP & RESTORE) ENGINE
// =====================================================

// --- Export Helper: Simplified Bookmarks ---
function simplifyBookmarkNode(node) {
  if (node.url) {
    return { title: node.title, url: node.url };
  }
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
        root.children.forEach(node => {
          simplifiedRoot.push(simplifyBookmarkNode(node));
        });
      }
      resolve(simplifiedRoot);
    });
  });
}

// --- Export Helper: Open Tabs & Groups ---
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

// --- Export Helper: Extension Settings ---
async function getSettingsBackup() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (syncItems) => {
      chrome.storage.local.get({ geminiApiKey: '' }, (localItems) => {
        resolve({
          sync: syncItems,
          local: localItems
        });
      });
    });
  });
}

// --- Export Helper: Session Memory ---
async function getSessionMemoryBackup() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ session_index: [] }, async (items) => {
      const index = items.session_index || [];
      const sessions = {};
      for (const entry of index) {
        const sesKey = 'session_' + entry.id;
        const sesData = await new Promise(res => chrome.storage.local.get({ [sesKey]: null }, r => res(r[sesKey])));
        if (sesData) {
          sessions[sesKey] = sesData;
        }
      }
      resolve({ index, sessions });
    });
  });
}

// --- Export Main Runner ---
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

    const doTabs = document.getElementById('portabilityTabs').checked;
    const doBookmarks = document.getElementById('portabilityBookmarks').checked;
    const doSettings = document.getElementById('portabilitySettings').checked;
    const doSessions = document.getElementById('portabilitySessions').checked;

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
      importStatus.style.color = '#34c759';
      importStatus.textContent = '✅ Backup created successfully!';
    }
  } catch (e) {
    if (importStatus) {
      importStatus.style.color = '#ea4335';
      importStatus.textContent = `❌ Export failed: ${e.message}`;
    }
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = '📤 Create Backup File (.json)';
  }
}

// --- Import Helper: Restore Settings ---
async function importSettings(settings) {
  if (!settings) return;
  
  if (settings.sync) {
    await new Promise(resolve => chrome.storage.sync.set(settings.sync, resolve));
  }
  if (settings.local && settings.local.geminiApiKey) {
    await new Promise(resolve => chrome.storage.local.set({ geminiApiKey: settings.local.geminiApiKey }, resolve));
  }
  
  // Soft reload options page visually without hard refresh
  if (typeof restoreOptions === 'function') {
    restoreOptions();
  }
}

// --- Import Helper: Restore Bookmarks ---
async function createBookmarkRecursive(parentId, node) {
  if (node.url) {
    await new Promise(resolve => chrome.bookmarks.create({ parentId, title: node.title, url: node.url }, resolve));
    return;
  }
  
  const folder = await new Promise(resolve => chrome.bookmarks.create({ parentId, title: node.title }, resolve));
  if (folder && folder.id && node.children) {
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
      let parentFolderId = '2'; // default Other Bookmarks ID
      if (root && root.children && root.children.length > 1) {
        parentFolderId = root.children[1].id || '2';
      }
      
      const dateStr = new Date().toISOString().slice(0, 10);
      const folderName = `Imported Bookmarks — ${dateStr}`;
      const mainFolder = await new Promise(res => chrome.bookmarks.create({ parentId: parentFolderId, title: folderName }, res));
      
      if (mainFolder && mainFolder.id) {
        for (const item of bookmarks) {
          await createBookmarkRecursive(mainFolder.id, item);
        }
      }
      resolve();
    });
  });
}

// --- Import Helper: Restore Sessions ---
async function importSessionMemory(sm) {
  if (!sm || !sm.index) return;
  
  // Wipe existing session logs and index
  const existingItems = await new Promise(res => chrome.storage.local.get({ session_index: [] }, res));
  const wipeKeys = (existingItems.session_index || []).map(e => 'session_' + e.id);
  wipeKeys.push('session_index');
  wipeKeys.push('session_active');
  await new Promise(resolve => chrome.storage.local.remove(wipeKeys, resolve));
  
  // Overwrite with imported history
  await new Promise(resolve => chrome.storage.local.set({ session_index: sm.index }, resolve));
  
  if (sm.sessions) {
    await new Promise(resolve => chrome.storage.local.set(sm.sessions, resolve));
  }
}

// --- Import Helper: Restore Tabs & Groups ---
async function importTabs(tabs) {
  if (!tabs || tabs.length === 0) return;
  
  const firstUrl = tabs[0].url;
  const newWindow = await new Promise(resolve => chrome.windows.create({ url: firstUrl, focused: true }, resolve));
  
  if (!newWindow || !newWindow.tabs || newWindow.tabs.length === 0) return;
  const firstTabId = newWindow.tabs[0].id;
  
  const tabsToGroup = {}; // groupTitle -> [tabIds]
  const groupMeta = {};  // groupTitle -> { color, collapsed }
  
  for (let i = 1; i < tabs.length; i++) {
    const t = tabs[i];
    const openedTab = await new Promise(resolve => chrome.tabs.create({ windowId: newWindow.id, url: t.url, pinned: t.pinned, active: false }, resolve));
    if (openedTab && openedTab.id && t.group) {
      const title = t.group.title;
      if (!tabsToGroup[title]) {
        tabsToGroup[title] = [];
        groupMeta[title] = t.group;
      }
      tabsToGroup[title].push(openedTab.id);
    }
  }
  
  if (tabs[0].group) {
    const title = tabs[0].group.title;
    if (!tabsToGroup[title]) {
      tabsToGroup[title] = [];
      groupMeta[title] = tabs[0].group;
    }
    tabsToGroup[title].push(firstTabId);
  }
  
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
      } catch (err) {
        console.warn(`[Portability] Failed grouping: ${title}`, err.message);
      }
    }
  }
}

// --- Import Main Runner ---
async function runImport(backup) {
  const importStatus = document.getElementById('importStatus');
  try {
    let importedCount = 0;
    
    if (backup.settings) {
      await importSettings(backup.settings);
      importedCount++;
    }
    if (backup.bookmarks) {
      await importBookmarks(backup.bookmarks);
      importedCount++;
    }
    if (backup.sessionMemory) {
      await importSessionMemory(backup.sessionMemory);
      importedCount++;
    }
    if (backup.tabs) {
      await importTabs(backup.tabs);
      importedCount++;
    }
    
    if (importStatus) {
      importStatus.style.color = '#34c759';
      importStatus.textContent = `✅ Successfully restored ${importedCount} categories of data!`;
    }
  } catch (e) {
    if (importStatus) {
      importStatus.style.color = '#ea4335';
      importStatus.textContent = `❌ Import error: ${e.message}`;
    }
  }
}

// --- File Import Trigger Parser ---
function handleFileImport(file) {
  const importStatus = document.getElementById('importStatus');
  if (importStatus) {
    importStatus.style.color = '#8ab4f8';
    importStatus.textContent = '⏳ Reading file...';
  }
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.metadata || !backup.metadata.version) {
        throw new Error('Invalid file format: metadata missing.');
      }
      
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

// --- Wire Up Portability Listeners ---
function initPortability() {
  const exportBtn = document.getElementById('exportPortabilityBtn');
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  if (exportBtn) exportBtn.addEventListener('click', runExport);
  
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '#8ab4f8';
      dropZone.style.backgroundColor = 'rgba(138,180,248,0.05)';
    });
    
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = 'rgba(138,180,248,0.3)';
      dropZone.style.backgroundColor = 'transparent';
    });
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'rgba(138,180,248,0.3)';
      dropZone.style.backgroundColor = 'transparent';
      const file = e.dataTransfer.files[0];
      if (file) handleFileImport(file);
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileImport(file);
    });
  }
}

document.addEventListener('DOMContentLoaded', initPortability);
// If options are already loaded
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  initPortability();
}
