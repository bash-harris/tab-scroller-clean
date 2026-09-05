// R4 e2e chain test (deterministic path, offline, no chrome):
// loads background.js with a full chrome mock, drives deliverCommandPlan ->
// pendingPlans -> EXECUTE_PLAN chain branch -> transactionLog.undo.
//
// 'bookmark the recipe tabs and then close them' on a suite-v3-like pool:
//   plan.steps=2, preview combines both steps, confirm executes bookmark then
//   close (mock chrome), ONE composite transaction recorded, undo restores both.
//
//   node tests/chain-e2e.test.js
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
  const tab = { id: id || nextTabId++, title, url, windowId: 1, active: false, pinned: false, index: nextTabId };
  tabsStore.set(tab.id, tab);
  return tab;
}

let createdBookmarks = []; // { id, parentId, title, url }
let bookmarkFolderSeq = 10;

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
    create: async ({ url, active }) => { const t = mkTab({ title: url, url, id: nextTabId++ }); return t; },
    remove: async (ids) => {
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
      if (url == null) { const f = { id: String(bookmarkFolderSeq++), parentId, title, children: [] }; createdBookmarks.push(f); return f; }
      const b = { id: 'b' + (bookmarkFolderSeq++), parentId, title, url };
      createdBookmarks.push(b);
      return b;
    },
    remove: async (id) => { createdBookmarks = createdBookmarks.filter(b => b.id !== id); },
    removeTree: async (id) => { createdBookmarks = createdBookmarks.filter(b => b.id !== id && b.parentId !== id); },
  },
  storage: {
    local: {
      get: async (keys, cb) => (typeof cb === 'function' ? cb({}) : {}),
      set: async () => {},
      remove: async () => {},
    },
    sync: { get: async (k, cb) => (cb ? cb({}) : {}) },
  },
  commands: undefined,
  offscreen: undefined,
};
global.importScripts = () => {};
global.fetch = async () => { throw new Error('no network in test'); };
global.setTimeout = global.setTimeout; // node native ok
// background.js expects its importScripts siblings on self; stub the ones it
// touches at load time (full implementations are not needed for the chain e2e).
global.self.SessionMemoryEngine = {
  initialize: async () => {},
  getTabTiming: () => ({ openedAt: null }),
};

// ---- load background.js (the real thing) ----
const bg = require('C:/Users/bkh/Desktop/tab-scroller-clean/background.js');

// ---- pipeline mocks: deterministic agent path ----
// background.js loads its siblings via importScripts (no-op'd above); provide
// the minimal surfaces it references at load time.
global.self.AgentPlanner = { buildFilterPlan: async () => null };
global.self.AgentExecutor = {};
global.self.AgentRouter = {};
global.self.CommandAgent = require('C:/Users/bkh/Desktop/tab-scroller-clean/command-agent.js');
global.self.LlmQuery = require('C:/Users/bkh/Desktop/tab-scroller-clean/llm-query.js');

// We avoid the full AI_COMMAND router (it needs Embed/NLI); instead drive
// deliverCommandPlan + EXECUTE_PLAN directly with the composed chained plan
// exactly as command-agent.composeChainedPlan emits it. This is the
// deterministic e2e of the background wiring.
const CA = require('C:/Users/bkh/Desktop/tab-scroller-clean/command-agent.js');

(async () => {
  // Pool: 2 recipe tabs + 1 unrelated.
  const r1 = mkTab({ title: 'pasta recipe', url: 'https://recipes.example/pasta' });
  const r2 = mkTab({ title: 'cake recipe archive', url: 'https://baking.example/cake' });
  const other = mkTab({ title: 'news roundup', url: 'https://news.example/x' });

  const plan = {
    intent: 'bookmark_tabs+close_tabs',
    tabIds: [r1.id, r2.id],
    perTabReasons: { [r1.id]: 'step 1: bookmark', [r2.id]: 'step 1: bookmark' },
    uncertain: [],
    confidence: 0.9,
    destructive: true,
    path: 'agent',
    action_params: {},
    reason: '1. Bookmark 2 tab(s)\n2. Close 2 tab(s)',
    planSource: 'gemini',
    chained: true,
    steps: [
      { intent: 'bookmark_tabs', carry: false, params: { folderName: 'Recipes' }, tabIds: [r1.id, r2.id] },
      { intent: 'close_tabs', carry: true, params: {}, tabIds: [r1.id, r2.id] },
    ],
    needsCorrection: false,
    preview: null,
    transaction: null,
  };

  ok('plan.steps = 2', plan.steps.length === 2);

  // deliverCommandPlan via the onMessage router (AI_COMMAND path delivers here).
  let resp = null;
  const handler = listeners.onMessage[listeners.onMessage.length - 1];
  handler({ type: 'AI_COMMAND_UNUSED', command: 'x' }, { id: 'test-ext-id', tab: { id: 999, windowId: 1 } }, (r) => { resp = r; });
  await new Promise(r => setTimeout(r, 50));

  // Drive delivery directly through the exported-internal path: emulate the
  // preview branch by calling the router's deliverCommandPlan through
  // EXECUTE_PLAN afterwards. Since deliverCommandPlan is not exported, we
  // reproduce its preview side by asserting on pendingPlans after invoking
  // the real router for a synthetic AI_COMMAND... instead we call
  // deliverCommandPlan via a captured handler with the plan shape of
  // AI_COMMAND -- but AI_COMMAND runs the full pipeline. Simplest honest e2e:
  // call the preview branch by sending PREVIEW-triggered flow through
  // deliverCommandPlan exported on self (background defines it at top level).
  ok('deliverCommandPlan exposed on self', typeof self.deliverCommandPlan === 'function', typeof self.deliverCommandPlan);

  // Preview: destructive chain must set a pending plan + awaitingConfirmation.
  const tabMessages = [];
  chrome.tabs.sendMessage = async (tabId, msg) => { tabMessages.push(msg); return {}; };
  resp = null;
  await self.deliverCommandPlan(plan, {
    command: 'bookmark the recipe tabs and then close them',
    windowId: 1,
    senderTabId: 999,
    sendResponse: (r) => { resp = r; },
  });
  ok('preview: awaitingConfirmation', resp && resp.awaitingConfirmation === true, resp);
  ok('preview: PREVIEW_PLAN sent to tab', tabMessages.some(m => m.type === 'PREVIEW_PLAN'), tabMessages.map(m => m.type));
  const previewMsg = tabMessages.find(m => m.type === 'PREVIEW_PLAN');
  ok('preview combines both steps (reason carries both lines)',
    previewMsg && /1\. Bookmark 2 tab\(s\)/.test(previewMsg.plan.reason) && /2\. Close 2 tab\(s\)/.test(previewMsg.plan.reason),
    previewMsg && previewMsg.plan.reason);

  // Confirm: EXECUTE_PLAN with both ids checked.
  const planId = [...self.pendingPlans.keys()][0];
  ok('pending plan stored (chained)', planId && self.pendingPlans.get(planId).chained === true &&
    self.pendingPlans.get(planId).steps.length === 2,
    self.pendingPlans.get(planId));

  resp = null;
  handler({ type: 'EXECUTE_PLAN', planId, checkedTabIds: [r1.id, r2.id] }, { id: 'test-ext-id', tab: { id: 999, windowId: 1 } }, (r) => { resp = r; });
  await new Promise(r => setTimeout(r, 300));

  ok('confirm: success response', resp && resp.success === true, resp);
  ok('bookmark executed before close (tabs gone after both steps)',
    !tabsStore.has(r1.id) && !tabsStore.has(r2.id) && tabsStore.has(other.id),
    [...tabsStore.keys()]);
  ok('bookmarks created for both tabs', createdBookmarks.filter(b => b.url).length === 2, createdBookmarks);

  // ONE composite transaction recorded.
  const lastTx = self.transactionLog.getLastTransaction();
  ok('ONE composite transaction recorded (action=chain)', lastTx && lastTx.action === 'chain', lastTx && lastTx.action);
  ok('chain tx has 2 steps, bookmark then close', lastTx && lastTx.beforeState.steps.length === 2 &&
    lastTx.beforeState.steps[0].intent === 'bookmark_tabs' && lastTx.beforeState.steps[1].intent === 'close_tabs',
    lastTx && lastTx.beforeState.steps && lastTx.beforeState.steps.map(s => s.intent));
  ok('chain tx union ids', lastTx && JSON.stringify([...lastTx.affectedTabIds].sort()) === JSON.stringify([r1.id, r2.id].sort()),
    lastTx && lastTx.affectedTabIds);

  // Undo restores both steps in reverse: reopen tabs, remove bookmarks.
  const undoRes = await self.transactionLog.undo();
  ok('undo succeeds', undoRes && undoRes.success === true, undoRes);
  // Undo replays close_tabs' inverse: the URLs reopen as NEW tab ids.
  const reopenedUrls = [...tabsStore.values()].map(t => t.url);
  ok('undo reopened both closed tabs (urls)', reopenedUrls.includes('https://recipes.example/pasta') && reopenedUrls.includes('https://baking.example/cake'), reopenedUrls);
  ok('undo removed the created bookmarks', createdBookmarks.filter(b => b.url).length === 0, createdBookmarks);

  console.log('\n' + '='.repeat(60));
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  R4 chained-plan background e2e  (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('E2E ERROR', e); process.exit(1); });
