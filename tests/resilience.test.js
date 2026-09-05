// R5 resilience test (deterministic, offline, no chrome):
// loads background.js with a full chrome mock (same harness as chain-e2e) and
// drives the five confirmed MV3 service-worker resilience defects:
//   1. pending plan persistence: write-through to chrome.storage.session,
//      Map cleared (simulated SW death) -> lazy hydrate -> EXECUTE succeeds
//   2. URL-hash revalidation: a tab whose URL changed since the preview is
//      held back and reported; the rest still execute
//   3. undo history orphan: empty in-memory _history + seeded
//      chrome.storage.local 'transactionHistory' -> hydrate -> undo works
//   4. double-confirm trap: EXECUTE_PLAN must pass confirmation:false so a
//      >=3-tab close actually removes tabs (no 'Undo available' lie)
//   5. sender decoupling: chrome-extension:// origin without sender.tab
//      resolves a window; a page-origin sender without a tab is rejected
//
//   node tests/resilience.test.js
global.self = global;

const asserts = [];
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <' + JSON.stringify(extra) + '>' : '')); }
  asserts.push({ label, cond });
}

// ---- chrome mock ----
const listeners = { onMessage: [], onInstalled: [] };
let nextTabId = 1;
const tabsStore = new Map(); // id -> tab object
function mkTab({ title, url, id }) {
  const tab = {
    id: id || nextTabId++, title, url, windowId: 1, active: false, pinned: false,
    index: nextTabId, lastAccessed: Date.now() - 60000,
  };
  tabsStore.set(tab.id, tab);
  return tab;
}

const removeCalls = []; // every chrome.tabs.remove argument list
let createdBookmarks = [];

const sessionStore = {}; // chrome.storage.session backing (survives "SW restart")
const localStore = {};   // chrome.storage.local backing

global.chrome = {
  runtime: {
    id: 'test-ext-id',
    onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
    onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
    onStartup: { addListener: () => {} },
    getURL: (p) => 'chrome-extension://test/' + p,
    sendMessage: async () => {},
  },
  tabs: {
    query: async (q) => [...tabsStore.values()].filter(t => (q.windowId != null ? t.windowId === q.windowId : true)),
    get: async (id) => tabsStore.get(id) || (() => { throw new Error('no tab ' + id); })(),
    create: async ({ url, active }) => mkTab({ title: url, url, id: nextTabId++ }),
    remove: async (ids) => {
      removeCalls.push([].concat(ids));
      for (const id of [].concat(ids)) tabsStore.delete(id);
    },
    group: async ({ tabIds }) => 777,
    update: async (id, props) => { const t = tabsStore.get(id); if (t) Object.assign(t, props); return t; },
    move: async () => {},
    reload: async () => {},
    onCreated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onActivated: { addListener: () => {} },
    onMoved: { addListener: () => {} },
    onAttached: { addListener: () => {} },
    onDetached: { addListener: () => {} },
    sendMessage: async () => {},
  },
  tabGroups: {
    update: async () => {},
    onCreated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    onMoved: { addListener: () => {} },
  },
  windows: {
    WINDOW_ID_CURRENT: -1,
    onFocusChanged: { addListener: () => {} },
    get: async () => ({ id: 1 }),
    getLastFocused: async () => ({ id: 1 }),
  },
  bookmarks: {
    getTree: async () => [{ id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [] }] }],
    create: async ({ parentId, title, url }) => {
      const b = { id: 'b' + nextTabId++, parentId, title, url, children: [] };
      createdBookmarks.push(b);
      return b;
    },
    remove: async (id) => { createdBookmarks = createdBookmarks.filter(b => b.id !== id); },
    removeTree: async (id) => { createdBookmarks = createdBookmarks.filter(b => b.id !== id && b.parentId !== id); },
  },
  storage: {
    local: {
      get: (keys, cb) => {
        const req = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        const out = {};
        for (const k of req) out[k] = (k in localStore) ? localStore[k] : (keys && typeof keys === 'object' && !Array.isArray(keys) ? keys[k] : undefined);
        if (typeof cb === 'function') { cb(out); return; }
        return Promise.resolve(out);
      },
      set: (obj, cb) => { Object.assign(localStore, obj); if (typeof cb === 'function') cb(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) delete localStore[k]; if (typeof cb === 'function') cb(); return Promise.resolve(); },
    },
    sync: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})) },
    // MV3 session storage — the whole point of the R5 fix
    session: {
      get: async (keys) => {
        const out = {};
        for (const k of [].concat(keys)) if (k in sessionStore) out[k] = sessionStore[k];
        return out;
      },
      set: async (obj) => { Object.assign(sessionStore, obj); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete sessionStore[k]; },
    },
  },
  commands: undefined,
  offscreen: undefined,
};
global.importScripts = () => {};
global.fetch = async () => { throw new Error('no network in test'); };
global.self.SessionMemoryEngine = {
  initialize: async () => {},
  getTabTiming: () => ({ openedAt: null }),
  isEnabled: () => false,
  recordTabEvent: async () => {},
};

// ---- load background.js (the real thing) ----
require('C:/Users/bkh/Desktop/tab-scroller-clean/background.js');
// Production loads these via importScripts; require them so self.toolForIntent
// (command-agent) and self.sha256/self.normalizeUrl (tab-cards, the SAME hash
// pair used for card identity) exist like they do inside the real worker.
global.self.CommandAgent = require('C:/Users/bkh/Desktop/tab-scroller-clean/command-agent.js');
global.self.LlmQuery = require('C:/Users/bkh/Desktop/tab-scroller-clean/llm-query.js');
require('C:/Users/bkh/Desktop/tab-scroller-clean/tab-cards.js');
ok('self.sha256 available (card-identity hash pair)', typeof self.sha256 === 'function' && typeof self.normalizeUrl === 'function');
ok('self.toolForIntent available (command-agent)', typeof self.toolForIntent === 'function');

const handler = listeners.onMessage[listeners.onMessage.length - 1];

function send(type, msg, sender) {
  return new Promise((resolve) => {
    let settled = false;
    const r = handler({ type, ...msg }, sender, (resp) => { settled = true; resolve(resp); });
    // async handlers return true; give them time
    setTimeout(() => { if (!settled) resolve(undefined); }, 500);
    return r;
  });
}

function deliver(plan, senderTabId = 999) {
  return new Promise((resolve) => {
    self.deliverCommandPlan(plan, {
      command: plan.command || 'test command',
      windowId: 1,
      senderTabId,
      sendResponse: resolve,
    });
  });
}

(async () => {
  // ============ T1: plan persist -> restart -> hydrate -> EXECUTE ============
  console.log('\nT1  pending-plan persistence across a simulated SW restart');
  {
    const a = mkTab({ title: 'alpha docs', url: 'https://docs.example/a' });
    const b = mkTab({ title: 'beta mail', url: 'https://mail.example/b' });
    const c = mkTab({ title: 'gamma news', url: 'https://news.example/c' });

    const plan = {
      intent: 'close_tabs', tabIds: [a.id, b.id, c.id], uncertain: [],
      confidence: 0.4, destructive: true, path: 'semantic',
      action_params: {}, perTabReasons: {},
    };
    const resp = await deliver(plan);
    ok('preview: awaitingConfirmation', resp && resp.awaitingConfirmation === true, resp);

    const planId = [...self.pendingPlans.keys()].find(k => !String(k).startsWith('mg_'));
    ok('pending plan stored in Map', !!planId, [...self.pendingPlans.keys()]);
    const row = sessionStore['plan_' + planId];
    ok('plan written through to chrome.storage.session (plan_<id>)', !!(row && row.createdAt && row.intent === 'close_tabs'), sessionStore);

    // Simulated service-worker death: in-memory Maps are gone.
    self.pendingPlans.clear();
    ok('Maps empty after simulated restart', self.pendingPlans.size === 0);

    const resp2 = await send('EXECUTE_PLAN', { planId, checkedTabIds: [a.id, b.id, c.id] },
      { id: 'test-ext-id', tab: { id: 999, windowId: 1 } });
    ok('EXECUTE succeeds after hydration', resp2 && resp2.success === true, resp2);
    ok('all 3 tabs closed', !tabsStore.has(a.id) && !tabsStore.has(b.id) && !tabsStore.has(c.id), [...tabsStore.keys()]);
    ok('consumed plan row deleted from storage', sessionStore['plan_' + planId] === undefined,
      Object.keys(sessionStore).filter(k => k.startsWith('plan_')));
  }

  // ============ T1b: stored plan past the 10-min TTL -> clear expiry ========
  console.log('\nT1b plan TTL expiry in storage.session');
  {
    const t1 = mkTab({ title: 'ttl one', url: 'https://ttl.example/1' });
    const t2 = mkTab({ title: 'ttl two', url: 'https://ttl.example/2' });
    const plan = {
      intent: 'close_tabs', tabIds: [t1.id, t2.id], uncertain: [],
      confidence: 0.4, destructive: true, path: 'semantic',
      action_params: {}, perTabReasons: {},
    };
    await deliver(plan);
    const planId = [...self.pendingPlans.keys()].find(k => !String(k).startsWith('mg_'));

    // SW death, then the stored row ages past the TTL before anyone reads it.
    self.pendingPlans.clear();
    const row = sessionStore['plan_' + planId];
    row.createdAt = Date.now() - (11 * 60 * 1000); // 11 min old > 10 min TTL
    row.expiresAt = Date.now() - 60 * 1000;

    const resp = await send('EXECUTE_PLAN', { planId, checkedTabIds: [t1.id, t2.id] },
      { id: 'test-ext-id', tab: { id: 999, windowId: 1 } });
    ok('expired plan -> clear expiry message', resp && resp.success === false &&
      resp.message === 'Plan expired or invalid. Please try again.', resp);
    ok('expired row purged from storage.session', sessionStore['plan_' + planId] === undefined);
    ok('expired plan executed nothing', tabsStore.has(t1.id) && tabsStore.has(t2.id));
  }

  // ============ T2: URL-hash mismatch -> hold back + delta report ============
  console.log('\nT2  URL-hash revalidation holds back navigated tabs');
  {
    const x = mkTab({ title: 'Xray page', url: 'https://x.example/one' });
    const y = mkTab({ title: 'Yankee page', url: 'https://y.example/two' });
    const z = mkTab({ title: 'Zulu page', url: 'https://z.example/three' });

    const plan = {
      intent: 'close_tabs', tabIds: [x.id, y.id, z.id], uncertain: [],
      confidence: 0.4, destructive: true, path: 'semantic',
      action_params: {}, perTabReasons: {},
    };
    await deliver(plan);
    const planId = [...self.pendingPlans.keys()].find(k => !String(k).startsWith('mg_'));

    // User navigated Zulu since the preview.
    tabsStore.get(z.id).url = 'https://z.example/navigated-elsewhere';

    const resp = await send('EXECUTE_PLAN', { planId, checkedTabIds: [x.id, y.id, z.id] },
      { id: 'test-ext-id', tab: { id: 999, windowId: 1 } });
    ok('response success:true with held-back delta', resp && resp.success === true, resp);
    ok('message reports 1 of 3 changed since preview',
      resp && /1 of 3 tabs changed since preview/.test(resp.message || ''), resp && resp.message);
    ok('changedTabs carries {id, from, to}', resp && Array.isArray(resp.changedTabs) &&
      resp.changedTabs.length === 1 && resp.changedTabs[0].id === z.id &&
      resp.changedTabs[0].from === 'Zulu page' && resp.changedTabs[0].to === 'Zulu page', resp && resp.changedTabs);
    ok('navigated tab held back (still open)', tabsStore.has(z.id), [...tabsStore.keys()]);
    ok('the other two tabs executed', !tabsStore.has(x.id) && !tabsStore.has(y.id), [...tabsStore.keys()]);
  }

  // ============ T3: undo after simulated restart (history hydrate) =========
  console.log('\nT3  undo history hydrates from storage after restart');
  {
    const t1 = { txId: 'tx-seed-1', action: 'close_tabs', affectedTabIds: [42], beforeState: { urls: ['https://seed.example/first'] }, timestamp: 2000 };
    const t2 = { txId: 'tx-seed-2', action: 'close_tabs', affectedTabIds: [43], beforeState: { urls: ['https://seed.example/second'] }, timestamp: 1000 };
    localStore['transactionHistory'] = [t1, t2, { ...t1 }]; // includes a duplicate tx id

    // Simulated SW death: in-memory history gone, hydration flag reset.
    self.transactionLog._history = [];
    self.transactionLog._hydrated = false;

    const u1 = await self.transactionLog.undo();
    ok('undo works after restart', u1 && u1.success === true, u1);
    ok('undo reopened the latest tx', u1 && /1\/1 tabs/.test(u1.message || '') &&
      [...tabsStore.values()].some(t => t.url === 'https://seed.example/first'), u1 && u1.message);
    ok('duplicate tx ids deduped', self.transactionLog._history.length === 1, self.transactionLog._history);

    const u2 = await self.transactionLog.undo();
    ok('second undo pops the older tx (sorted by ts)', u2 && u2.success === true &&
      [...tabsStore.values()].some(t => t.url === 'https://seed.example/second'), u2 && u2.message);

    const u3 = await self.transactionLog.undo();
    ok('history exhausted -> Nothing to undo', u3 && u3.success === false && u3.message === 'Nothing to undo', u3);
  }

  // ============ T4: EXECUTE_PLAN passes confirmation:false =================
  console.log('\nT4  double-confirm trap: EXECUTE_PLAN forces confirmation:false');
  {
    removeCalls.length = 0;
    const p = mkTab({ title: 'p1', url: 'https://p.example/1' });
    const q = mkTab({ title: 'q2', url: 'https://q.example/2' });
    const r = mkTab({ title: 'r3', url: 'https://r.example/3' });

    const plan = {
      intent: 'close_tabs', tabIds: [p.id, q.id, r.id], uncertain: [],
      confidence: 0.4, destructive: true, path: 'semantic',
      action_params: {}, perTabReasons: {},
    };
    await deliver(plan);
    const planId = [...self.pendingPlans.keys()].find(k => !String(k).startsWith('mg_'));

    // Spy the args object that actually reaches the tool (executeToolCall
    // logs '[ToolCall] Executing: <name>' with the args as the 2nd argument).
    let toolArgs = null;
    const origLog = console.log;
    console.log = (...a) => {
      if (String(a[0]).includes('[ToolCall] Executing:')) toolArgs = a[1];
      origLog(...a);
    };
    try {
      var resp = await send('EXECUTE_PLAN', { planId, checkedTabIds: [p.id, q.id, r.id] },
        { id: 'test-ext-id', tab: { id: 999, windowId: 1 } });
    } finally {
      console.log = origLog;
    }
    ok('close actually executed (no second-confirm bounce)', resp && resp.success === true &&
      resp.requiresConfirmation === undefined && !tabsStore.has(p.id) && !tabsStore.has(q.id) && !tabsStore.has(r.id), resp);
    ok('args reaching the tool carry confirmation:false', toolArgs && toolArgs.confirmation === false, toolArgs);
    ok('args reaching the tool are exactly the confirmed ids', toolArgs &&
      JSON.stringify([...toolArgs.tabIds].sort()) === JSON.stringify([p.id, q.id, r.id].sort()), toolArgs);
    ok('chrome.tabs.remove ran with the confirmed ids', removeCalls.some(c => JSON.stringify([...c].sort()) === JSON.stringify([p.id, q.id, r.id].sort())), removeCalls);
  }

  // ============ T5: sender decoupling =======================================
  console.log('\nT5  sender decoupling: extension surfaces vs content scripts');
  {
    // Content-script-shaped sender (page origin) with no tab -> rejected.
    const rejected = await send('EXECUTE_PLAN', { planId: 'nope', checkedTabIds: [] },
      { id: 'test-ext-id', url: 'https://evil.example/page' });
    ok('content-script sender without tab still rejected', rejected &&
      rejected.success === false && rejected.message === 'Tab context required', rejected);

    // Extension-surface sender (chrome-extension:// origin, no sender.tab)
    // resolves a window and proceeds past the sender checks.
    const ext = await send('EXECUTE_PLAN', { planId: 'nope', checkedTabIds: [] },
      { id: 'test-ext-id', url: 'chrome-extension://test-ext-id/options.html' });
    ok('extension-surface sender passes (plan lookup reached)', ext &&
      ext.message === 'Plan expired or invalid. Please try again.', ext);

    // AI_COMMAND (tab-scoped type) from an extension surface: no longer
    // bounced with 'Tab context required'.
    const ai = await send('AI_COMMAND', { command: 'close my tabs' },
      { id: 'test-ext-id', url: 'chrome-extension://test-ext-id/popup.html' });
    ok('AI_COMMAND from extension surface not sender-rejected', !(ai && ai.message === 'Tab context required'), ai);

    // Content-script senders WITH a tab keep working end to end.
    const s = mkTab({ title: 'sender tab', url: 'https://s.example/' });
    const withTab = await send('EXECUTE_PLAN', { planId: 'nope', checkedTabIds: [] },
      { id: 'test-ext-id', tab: { id: s.id, windowId: 1 } });
    ok('content-script sender with tab unaffected', withTab &&
      withTab.message === 'Plan expired or invalid. Please try again.', withTab);
  }

  // ============ T6: tabLastActive hydration on wake ==========================
  console.log('\nT6  tabLastActive hydrates from chrome.tabs.query on wake');
  {
    const h1 = mkTab({ title: 'hydr one', url: 'https://hydr.example/1' });
    const h2 = mkTab({ title: 'hydr two', url: 'https://hydr.example/2' });
    tabsStore.get(h1.id).lastAccessed = Date.now() - 123456;
    tabsStore.get(h2.id).lastAccessed = Date.now() - 654321;

    // Simulated SW death: the in-memory recency map is gone.
    self.tabLastActive.clear();
    ok('tabLastActive empty after simulated restart', self.tabLastActive.size === 0);

    // Wake: first access triggers hydration from tabs.query lastAccessed.
    self.ensureTabLastActive(true);
    await new Promise(r => setTimeout(r, 50));

    ok('map hydrated for every live tab', [h1.id, h2.id].every(id => typeof self.tabLastActive.get(id) === 'number'),
      [...self.tabLastActive.entries()]);
    ok('values are the tabs\' lastAccessed, not Date.now()',
      self.tabLastActive.get(h1.id) === tabsStore.get(h1.id).lastAccessed &&
      self.tabLastActive.get(h2.id) === tabsStore.get(h2.id).lastAccessed,
      [...self.tabLastActive.entries()]);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  R5 MV3 resilience  (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('RESILIENCE TEST ERROR', e); process.exit(1); });
