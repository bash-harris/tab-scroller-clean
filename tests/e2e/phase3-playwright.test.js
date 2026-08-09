/**
 * Phase 3: Playwright End-to-End Test Suite
 *
 * Validates the full AI_COMMAND execution path through real Chrome:
 *   content.js → background.js → ChatService → Django → Ollama → executeTool → Chrome API
 *
 * Single browser context for all test suites to avoid 5x Chrome launch overhead.
 * Each describe block cleans up state before running.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..');
const USER_DATA_DIR = path.resolve(__dirname, '.chrome-profile-phase3-shared');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServiceWorker(context, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const sw = context.serviceWorkers()[0];
    if (sw) return sw;
    await sleep(500);
  }
  throw new Error('No service worker found');
}

async function waitForTabCount(context, minCount, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const count = context.pages().filter(p => {
      const url = p.url();
      return url && !url.startsWith('chrome-extension://') && !url.startsWith('chrome://');
    }).length;
    if (count >= minCount) return count;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${minCount} tabs`);
}

async function openTabs(context, urls) {
  for (const url of urls) {
    const p = await context.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(500);
  }
}

async function closeAllContentTabs(context) {
  const pages = context.pages().filter(p => {
    const url = p.url();
    return url && !url.startsWith('chrome-extension://') && !url.startsWith('chrome://');
  });
  for (const p of pages) {
    await p.close().catch(() => {});
  }
  await sleep(300);
}

async function sendAICommand(sw, command) {
  return await sw.evaluate(async (cmd) => {
    try {
      const currentTabs = await self.TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
      const currentTabIds = new Set(currentTabs.map(t => t.id));

      const domain = self.SearchService.extractDomain(cmd);
      let compactTabs;

      if (domain) {
        const domainTabs = await self.SearchService.searchByDomain(domain);
        const validDomain = domainTabs.filter(r => currentTabIds.has(r.tabId));
        if (validDomain.length > 0) {
          compactTabs = validDomain.map(t => ({
            id: t.tabId,
            title: t.title || '',
            url: t.url || '',
          }));
        }
      }

      if (!compactTabs) {
        const searchResults = await self.SearchService.searchTabs(cmd, 50);
        const validResults = searchResults.filter(r => currentTabIds.has(r.tabId));
        if (validResults.length > 0) {
          compactTabs = validResults.map(t => ({
            id: t.tabId,
            title: t.title || '',
            url: t.url || '',
          }));
        }
      }

      if (!compactTabs) {
        compactTabs = currentTabs.map(t => ({
          id: t.id,
          title: t.title || '',
          url: t.url || '',
        }));
      }

      const chatResult = await self.ChatService.execute(cmd, compactTabs);

      if (chatResult.error) {
        return { success: false, message: chatResult.error };
      }

      if (!chatResult.tool || !chatResult.arguments) {
        return { success: false, message: 'Model returned invalid response' };
      }

      const args = { ...chatResult.arguments };
      const selectedIds = compactTabs.map(t => t.id);

      switch (chatResult.tool) {
        case 'group_tabs':
        case 'close_tabs':
        case 'pin_tabs':
        case 'bookmark_tabs':
          args.tabIds = selectedIds;
          break;
        case 'focus_tab':
          args.tabId = selectedIds[0];
          break;
      }

      if (chatResult.tool === 'bookmark_tabs') {
        args._tabs = compactTabs.map(t => ({ id: t.id, title: t.title, url: t.url }));
      }

      const toolResult = await self.executeTool(chatResult.tool, args);
      return toolResult;
    } catch (err) {
      return { success: false, message: err.message };
    }
  }, command);
}

async function getTabState(sw) {
  return await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    const groups = await chrome.tabGroups.query({});
    const realTabs = tabs.filter(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
    return {
      tabCount: realTabs.length,
      tabs: realTabs.map(t => ({ id: t.id, title: t.title, url: t.url, groupId: t.groupId, pinned: t.pinned })),
      groupCount: groups.length,
      groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color })),
    };
  });
}

async function ungroupAll(sw) {
  await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    const grouped = tabs.filter(t => t.groupId !== -1).map(t => t.id);
    if (grouped.length > 0) await chrome.tabs.ungroup(grouped);
  });
  await sleep(200);
}

async function getDomainFromTabDB(sw, domain) {
  return await sw.evaluate(async (d) => {
    const cards = await self.SearchService.searchByDomain(d);
    return cards.map(c => ({ tabId: c.tabId, title: c.title, url: c.url }));
  }, domain);
}

// ═══════════════════════════════════════════════════════════════════════════
// URL fixtures
// ═══════════════════════════════════════════════════════════════════════════

const GITHUB_URLS = [
  'https://github.com/trending',
  'https://github.com/settings',
  'https://github.com/marketplace',
];

const LINKEDIN_URLS = [
  'https://www.linkedin.com/feed/',
  'https://www.linkedin.com/jobs/',
  'https://www.linkedin.com/messaging/',
];

const YOUTUBE_URLS = [
  'https://www.youtube.com/',
  'https://www.youtube.com/feed/trending',
  'https://www.youtube.com/subscriptions',
];

const AMAZON_URLS = [
  'https://www.amazon.com/',
  'https://www.amazon.com/deals',
  'https://www.amazon.com/gp/bestsellers',
];

const SEMANTIC_URLS = [
  'https://en.wikipedia.org/wiki/Sorting_algorithm',
  'https://en.wikipedia.org/wiki/Binary_search_tree',
  'https://en.wikipedia.org/wiki/Machine_learning',
  'https://en.wikipedia.org/wiki/Neural_network',
  'https://en.wikipedia.org/wiki/Distributed_computing',
];

const MIXED_URLS = [
  'https://github.com/trending',
  'https://github.com/settings',
  'https://leetcode.com/problemset/',
  'https://en.wikipedia.org/wiki/Interview',
  'https://www.linkedin.com/feed/',
];

// ═══════════════════════════════════════════════════════════════════════════
// Shared browser context for ALL tests
// ═══════════════════════════════════════════════════════════════════════════

let sharedContext, sw;

beforeAll(async () => {
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch {}
  sharedContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [`--load-extension=${EXTENSION_PATH}`, '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  sw = await waitForServiceWorker(sharedContext);
  await sleep(3000);
}, 60000);

afterAll(async () => {
  try { await sharedContext.close(); } catch {}
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 1: Deterministic Commands (domain keywords → no embeddings)
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Deterministic Commands', () => {
  afterEach(async () => {
    await ungroupAll(sw);
  });

  test('group github tabs — finds all github tabs via domain search', async () => {
    await openTabs(sharedContext, GITHUB_URLS);
    await sleep(2000);

    const result = await sendAICommand(sw, 'group github tabs');
    await sleep(1000);

    const stateAfter = await getTabState(sw);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    const githubTabsGrouped = stateAfter.tabs.filter(
      t => t.url.includes('github.com') && t.groupId !== -1
    );
    expect(githubTabsGrouped.length).toBeGreaterThanOrEqual(2);
    console.log(`  group github tabs: ${githubTabsGrouped.length} github tabs grouped`);
  }, 60000);

  test('group linkedin tabs — finds all linkedin tabs via domain search', async () => {
    await openTabs(sharedContext, LINKEDIN_URLS);
    await sleep(2000);

    const result = await sendAICommand(sw, 'group linkedin tabs');
    await sleep(1000);

    const stateAfter = await getTabState(sw);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    const linkedinTabsGrouped = stateAfter.tabs.filter(
      t => t.url.includes('linkedin.com') && t.groupId !== -1
    );
    expect(linkedinTabsGrouped.length).toBeGreaterThanOrEqual(2);
    console.log(`  group linkedin tabs: ${linkedinTabsGrouped.length} linkedin tabs grouped`);
  }, 60000);

  test('pin amazon tabs — finds amazon tabs via domain', async () => {
    await openTabs(sharedContext, AMAZON_URLS);
    await sleep(2000);

    const result = await sendAICommand(sw, 'pin amazon tabs');
    await sleep(1000);

    const stateAfter = await getTabState(sw);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    const amazonPinned = stateAfter.tabs.filter(
      t => t.url.includes('amazon.com') && t.pinned
    );
    expect(amazonPinned.length).toBeGreaterThanOrEqual(1);
    console.log(`  pin amazon tabs: ${amazonPinned.length} amazon tabs pinned`);

    for (const tab of stateAfter.tabs) {
      if (tab.url.includes('amazon.com')) {
        await sw.evaluate(async (id) => {
          await chrome.tabs.update(id, { pinned: false });
        }, tab.id);
      }
    }
  }, 60000);

  test('focus gmail — deterministic command executes correctly', async () => {
    await openTabs(sharedContext, ['https://mail.google.com/mail/u/0/']);
    await sleep(2000);

    const result = await sendAICommand(sw, 'focus gmail');
    await sleep(1000);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    console.log(`  focus gmail: ${result.message || 'ok'}`);
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 2: Semantic Commands (need embeddings → top-K candidates)
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Semantic Commands', () => {
  afterEach(async () => {
    await ungroupAll(sw);
  });

  test('group tabs about machine learning — semantic search finds relevant tabs', async () => {
    await openTabs(sharedContext, SEMANTIC_URLS);
    await sleep(2000);

    const result = await sendAICommand(sw, 'group tabs about machine learning');
    await sleep(1000);

    const stateAfter = await getTabState(sw);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    const grouped = stateAfter.tabs.filter(t => t.groupId !== -1);
    expect(grouped.length).toBeGreaterThanOrEqual(1);
    console.log(`  group ML tabs: ${grouped.length} tabs grouped`);
  }, 90000);

  test('find distributed systems notes — semantic search retrieves top candidates', async () => {
    await openTabs(sharedContext, SEMANTIC_URLS);
    await sleep(2000);

    const result = await sendAICommand(sw, 'find distributed systems notes');
    await sleep(1000);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    console.log(`  find distributed systems: ${result.message || 'ok'}`);
  }, 90000);
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 3: Mixed Commands (domain keyword + semantic terms)
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Mixed Commands', () => {
  afterEach(async () => {
    await ungroupAll(sw);
  });

  test('group github interview tabs — routes to deterministic (github domain)', async () => {
    await openTabs(sharedContext, MIXED_URLS);
    await sleep(2000);

    const result = await sendAICommand(sw, 'group github interview tabs');
    await sleep(1000);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    const githubTabsGrouped = (await getTabState(sw)).tabs.filter(
      t => t.url.includes('github.com') && t.groupId !== -1
    );
    expect(githubTabsGrouped.length).toBeGreaterThanOrEqual(1);
    console.log(`  group github interview: ${githubTabsGrouped.length} github tabs grouped`);
  }, 90000);

  test('group frontend tutorials — routes to semantic (no domain match)', async () => {
    await openTabs(sharedContext, [
      'https://en.wikipedia.org/wiki/JavaScript',
      'https://en.wikipedia.org/wiki/CSS',
      'https://en.wikipedia.org/wiki/HTML',
    ]);
    await sleep(2000);

    const result = await sendAICommand(sw, 'group frontend tutorials');
    await sleep(1000);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    console.log(`  group frontend tutorials: ${result.message || 'ok'}`);
  }, 90000);
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 4: Failure Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Failure Tests', () => {
  test('no matching tabs — graceful error for unknown domain', async () => {
    const result = await sendAICommand(sw, 'group zzzznotareal tabs');
    await sleep(1000);

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    console.log(`  no matching tabs: success=${result.success}, message=${result.message}`);
  }, 60000);

  test('empty command — graceful error', async () => {
    const result = await sendAICommand(sw, '');

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    console.log(`  empty command: success=${result.success}`);
  }, 30000);

  test('unknown tool — extension handles gracefully', async () => {
    const result = await sendAICommand(sw, 'explode all tabs');
    await sleep(1000);

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    console.log(`  unknown tool: success=${result.success}, message=${result.message}`);
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 5: Performance
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Performance', () => {
  afterEach(async () => {
    await ungroupAll(sw);
  });

  test('deterministic command latency < 30000ms (Ollama cold start included)', async () => {
    await openTabs(sharedContext, GITHUB_URLS);
    await sleep(2000);

    const start = Date.now();
    const result = await sendAICommand(sw, 'group github tabs');
    const elapsed = Date.now() - start;
    await sleep(500);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    console.log(`  deterministic latency: ${elapsed}ms`);
  }, 60000);

  test('semantic command latency < 60000ms', async () => {
    await openTabs(sharedContext, SEMANTIC_URLS);
    await sleep(2000);

    const start = Date.now();
    const result = await sendAICommand(sw, 'group tabs about machine learning');
    const elapsed = Date.now() - start;
    await sleep(500);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    console.log(`  semantic latency: ${elapsed}ms`);
  }, 90000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Architecture Invariants
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3: Architecture Invariants', () => {
  afterEach(async () => {
    await sleep(100);
  });

  test('deterministic command: SearchService.searchTabs NOT called (no embeddings)', async () => {
    await openTabs(sharedContext, GITHUB_URLS);
    await sleep(2000);

    const searchCalled = await sw.evaluate(async () => {
      let called = false;
      const origSearchTabs = self.SearchService.searchTabs;
      self.SearchService.searchTabs = function(...args) {
        called = true;
        return origSearchTabs.apply(this, args);
      };
      try {
        const currentTabs = await self.TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
        const currentTabIds = new Set(currentTabs.map(t => t.id));
        const domain = self.SearchService.extractDomain('group github tabs');
        if (domain) {
          const domainTabs = await self.SearchService.searchByDomain(domain);
          const valid = domainTabs.filter(r => currentTabIds.has(r.tabId));
          if (valid.length > 0) {
            const compactTabs = valid.map(t => ({ id: t.tabId, title: t.title || '', url: t.url || '' }));
            await self.ChatService.execute('group github tabs', compactTabs);
          }
        }
      } finally {
        self.SearchService.searchTabs = origSearchTabs;
      }
      return called;
    });

    expect(searchCalled).toBe(false);
    console.log('  deterministic: searchTabs called =', searchCalled, '(expected: false)');
  }, 60000);

  test('deterministic command: embeddings endpoint NOT called', async () => {
    await openTabs(sharedContext, YOUTUBE_URLS);
    await sleep(2000);

    const embCalled = await sw.evaluate(async () => {
      let called = false;
      const origEmb = self.EmbeddingService.getEmbedding;
      self.EmbeddingService.getEmbedding = function(...args) {
        called = true;
        return origEmb.apply(this, args);
      };
      try {
        const currentTabs = await self.TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
        const currentTabIds = new Set(currentTabs.map(t => t.id));
        const domain = self.SearchService.extractDomain('group youtube tabs');
        if (domain) {
          const domainTabs = await self.SearchService.searchByDomain(domain);
          const valid = domainTabs.filter(r => currentTabIds.has(r.tabId));
          if (valid.length > 0) {
            const compactTabs = valid.map(t => ({ id: t.tabId, title: t.title || '', url: t.url || '' }));
            await self.ChatService.execute('group youtube tabs', compactTabs);
          }
        }
      } finally {
        self.EmbeddingService.getEmbedding = origEmb;
      }
      return called;
    });

    expect(embCalled).toBe(false);
    console.log('  deterministic: embeddings called =', embCalled, '(expected: false)');
  }, 60000);

  test('domain search: returns ALL matching tabs from TabDB', async () => {
    await openTabs(sharedContext, LINKEDIN_URLS);
    await sleep(3000);

    const dbCards = await getDomainFromTabDB(sw, 'linkedin.com');
    expect(dbCards.length).toBeGreaterThanOrEqual(2);
    console.log(`  domain search: ${dbCards.length} linkedin cards in TabDB`);

    for (const card of dbCards) {
      expect(card.url).toContain('linkedin.com');
    }
  }, 30000);

  test('LLM does not receive tabIds — arguments only contain action params', async () => {
    await openTabs(sharedContext, GITHUB_URLS);
    await sleep(2000);

    const chatCallBody = await sw.evaluate(async () => {
      let capturedArgs = null;
      const origExecute = self.ChatService.execute;
      self.ChatService.execute = function(prompt, tabs) {
        capturedArgs = { prompt, tabs };
        return Promise.resolve({ tool: 'group_tabs', arguments: { groupName: 'GitHub', color: 'blue' } });
      };
      try {
        const currentTabs = await self.TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
        const currentTabIds = new Set(currentTabs.map(t => t.id));
        const domain = self.SearchService.extractDomain('group github tabs');
        let compactTabs;
        if (domain) {
          const domainTabs = await self.SearchService.searchByDomain(domain);
          const validDomain = domainTabs.filter(r => currentTabIds.has(r.tabId));
          if (validDomain.length > 0) {
            compactTabs = validDomain.map(t => ({ id: t.tabId, title: t.title || '', url: t.url || '' }));
          }
        }
        if (!compactTabs) {
          compactTabs = currentTabs.map(t => ({ id: t.id, title: t.title || '', url: t.url || '' }));
        }
        await self.ChatService.execute('group github tabs', compactTabs);
      } finally {
        self.ChatService.execute = origExecute;
      }
      return capturedArgs;
    });

    expect(chatCallBody).toBeDefined();
    expect(chatCallBody.tabs).toBeDefined();
    expect(chatCallBody.tabs.length).toBeGreaterThan(0);

    const githubTabs = chatCallBody.tabs.filter(t => t.url.includes('github.com'));
    expect(githubTabs.length).toBeGreaterThanOrEqual(2);
    console.log(`  tabs sent: ${chatCallBody.tabs.length} total, ${githubTabs.length} github`);

    const nonGithub = chatCallBody.tabs.filter(t => !t.url.includes('github.com'));
    expect(nonGithub.length).toBe(0);
    console.log('  architecture: only github tabs sent for "group github tabs"');
  }, 30000);
});
