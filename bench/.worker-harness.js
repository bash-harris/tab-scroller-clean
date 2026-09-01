// Reproduces the MV3 service-worker startup of background.js inside Node, in a
// vm context where `require` does NOT exist (the real worker condition) and the
// chrome.* APIs are stubbed. Prints progress per file so a top-level throw or a
// synchronous hang is attributable to an exact file.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const t0 = Date.now();
const mark = (s) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${s}`);

// ---- chrome API stub: records nothing, just must not be undefined ----
const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const cb = (...a) => { const f = a[a.length - 1]; if (typeof f === 'function') f(undefined); };
const chrome = {
  runtime: {
    onMessage: listener(), onInstalled: listener(), onStartup: listener(),
    onConnect: listener(), onSuspend: listener(), onMessageExternal: listener(),
    getURL: (p) => `chrome-extension://fake/${p}`, id: 'fakeid',
    getManifest: () => ({ version: '1.0.0' }), lastError: undefined,
    sendMessage: cb, getContexts: async () => [],
  },
  tabs: {
    onUpdated: listener(), onRemoved: listener(), onActivated: listener(),
    onCreated: listener(), onMoved: listener(), onDetached: listener(),
    onAttached: listener(), onReplaced: listener(), onZoomChange: listener(),
    query: cb, get: cb, create: cb, update: cb, remove: cb, group: cb,
    discard: async () => {}, sendMessage: cb, captureVisibleTab: cb,
  },
  tabGroups: { onUpdated: listener(), onCreated: listener(), onRemoved: listener(), onMoved: listener(), query: cb, update: cb, get: cb },
  windows: { onFocusChanged: listener(), onCreated: listener(), onRemoved: listener(), getAll: cb, get: cb, getCurrent: cb, create: cb, update: cb, WINDOW_ID_NONE: -1 },
  storage: {
    onChanged: listener(),
    sync: { get: cb, set: cb, remove: cb, clear: cb },
    local: { get: cb, set: cb, remove: cb, clear: cb },
    session: { get: cb, set: cb, remove: cb, clear: cb, setAccessLevel: async () => {} },
  },
  alarms: { onAlarm: listener(), create: cb, clear: cb, get: cb, getAll: cb },
  commands: { onCommand: listener() },
  action: { onClicked: listener(), setBadgeText: cb, setBadgeBackgroundColor: cb, setIcon: cb, setTitle: cb },
  contextMenus: { onClicked: listener(), create: cb, removeAll: cb },
  history: { onVisited: listener(), search: cb, getVisits: cb, deleteUrl: cb },
  bookmarks: { onCreated: listener(), onRemoved: listener(), onChanged: listener(), search: cb, getTree: cb, create: cb, getRecent: cb },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {}, Reason: { WORKERS: 'WORKERS', DOM_PARSER: 'DOM_PARSER' } },
  scripting: { executeScript: async () => [], insertCSS: async () => {} },
  idle: { onStateChanged: listener(), queryState: cb },
  permissions: { contains: cb, request: cb },
  webNavigation: { onCommitted: listener(), onCompleted: listener() },
};

const sandbox = {
  chrome, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, Promise, URL, URLSearchParams, TextEncoder, TextDecoder,
  fetch: async () => { throw new Error('fetch stubbed'); },
  WebAssembly, Math, JSON, Date, Intl, structuredClone,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  crypto: require('crypto').webcrypto,
  indexedDB: undefined,
  navigator: { userAgent: 'probe', hardwareConcurrency: 8, gpu: undefined, storage: { estimate: async () => ({}) } },
  location: { href: 'chrome-extension://fake/background.js', origin: 'chrome-extension://fake' },
  caches: undefined,
  performance,
  Blob: globalThis.Blob, FileReader: undefined, OffscreenCanvas: undefined,
  ReadableStream: globalThis.ReadableStream,
  importScripts: null, // set below
  // deliberately NOT provided: require, module, exports, process
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

const loaded = [];
sandbox.importScripts = function (...files) {
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) {
      mark(`  !! importScripts MISSING FILE: ${f}`);
      throw new Error(`Failed to load script: ${f}`);
    }
    const src = fs.readFileSync(p, 'utf8');
    mark(`  -> importScripts ${f} (${(src.length / 1024).toFixed(0)}kb) ...`);
    try {
      vm.runInContext(src, ctx, { filename: f, timeout: 60000 });
      loaded.push(f);
      mark(`  ok  ${f}`);
    } catch (e) {
      mark(`  !! THROW inside ${f}: ${e.name}: ${e.message}`);
      if (e.stack) console.log(e.stack.split('\n').slice(0, 8).join('\n'));
      throw e;
    }
  }
};

mark('evaluating background.js top level...');
try {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'background.js', timeout: 120000 });
  mark('background.js top level COMPLETED without throwing');
} catch (e) {
  mark(`*** background.js TOP-LEVEL FAILURE: ${e.name}: ${e.message}`);
  if (e.stack) console.log(e.stack.split('\n').slice(0, 12).join('\n'));
}

mark(`files loaded: ${loaded.length}`);
console.log('\n=== globals the worker ended up with ===');
for (const g of ['TabCards','ConceptCore','LlmQuery','CommandAgent','DomainPriors','EnrichMath',
                 'SessionMemoryEngine','OrtConfig','TabDB','Embed','Indexer','RecallTabs',
                 'NliSelect','assignMultiGroupsCore','AgentRouter','AgentPlanner','AgentExecutor',
                 'PlanOps','Listwise','Facet','transformers']) {
  console.log(`  ${g.padEnd(24)} ${typeof sandbox[g] === 'undefined' ? 'MISSING' : 'present'}`);
}
process.exit(0);
