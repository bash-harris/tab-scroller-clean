// R7 perf + freshness suite (standalone node, same style as db-rekey.test.js).
// Covers the four confirmed defects:
//   1. getCardsByHashes  -- indexed batch lookup replaces the per-command
//      getAllTabCards() full-store scan for the retrieval join.
//   2. Dynamic-index budget -- a slow buildTabCard beyond
//      DYNAMIC_INDEX_BUDGET_MS hands the remaining tabs shallow cards and the
//      command still completes with a full candidate list.
//   3. SPA staleness -- onUpdated title/url changes (pushState navigations
//      never fire status:'complete') delete the stale card immediately and
//      schedule exactly ONE debounced re-index per burst; tab close cancels it.
//   4. Round-2 veto -- a round-2 "rejected" entry removes a round-1 match
//      (ratchet fix); without an explicit veto the max-confidence rule is
//      unchanged; the round-2 prompt advertises the rejected verdict.
//
//   node tests/perffresh.test.js

require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok:', name); }
  else { fail++; console.log('  FAIL:', name, extra !== undefined ? '->' + JSON.stringify(extra) : ''); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// db.js is an IIFE assigning self.TabDB. Give it a self and run it (same
// sandbox pattern as db-rekey.test.js).
function loadTabDB() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const sandbox = { indexedDB, IDBKeyRange, console, Float32Array, Math, Promise, JSON, Date, Map, Set, Array, Object, Error, setTimeout, clearTimeout };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.self.TabDB;
}

// Minimal but honest card for seeding the tabCards store.
function mkCard(urlHash, tabId, title) {
  return {
    tabId, urlHash, url: 'https://x.test/' + title, domain: 'x.test',
    title, extractedAt: Date.now(), contentHash: 'ch-' + urlHash,
    mainText: 'text ' + title, embedding: new Float32Array(0),
    structured: { type: 'other', headline: '', keywords: [], people: [], datePublished: '' },
    enrichment: { category: 'other', subTopics: [], entities: { people: [], orgs: [], works: [] }, contentType: 'other', summary: title, enrichedAt: Date.now(), vecVersion: 3 },
    extractionLevel: 'minimal'
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Listener registries for background.js sections (3 and 5 share the module).
const listeners = { onUpdated: [], onRemoved: [], onStartup: [], onInstalled: [] };

(async () => {
  console.log('\n--- 1. getCardsByHashes: one transaction, indexed gets, misses ABSENT (never null) ---');
  {
    const TabDB = loadTabDB();
    await TabDB.init();
    await TabDB.storeTabCard(mkCard('hash-a', 11, 'A'));
    await TabDB.storeTabCard(mkCard('hash-b', 22, 'B'));

    const m = await TabDB.getCardsByHashes(['hash-a', 'hash-b', 'missing', null]);
    ok('returns a Map', m instanceof Map);
    ok('existing hash -> card object', m.get('hash-a') && m.get('hash-a').title === 'A');
    ok('existing hash 2 -> card object', m.get('hash-b') && m.get('hash-b').title === 'B');
    ok('missing hash -> ABSENT (no key), never a null value',
      !m.has('missing') && !Array.from(m.values()).some(v => v == null));
    eq('map contains only found cards', Array.from(m.keys()).sort(), ['hash-a', 'hash-b']);
    eq('every value is a card with a urlHash', Array.from(m.values()).every(c => c && c.urlHash), true);
    eq('empty input -> empty Map', Array.from((await TabDB.getCardsByHashes([])).keys()), []);
    eq('null input -> empty Map', Array.from((await TabDB.getCardsByHashes(null)).keys()), []);
    // Round-trip against the existing single-get path: same row, same key.
    const single = await TabDB.getCardByUrlHash('hash-a');
    ok('agrees with getCardByUrlHash', m.get('hash-a').urlHash === single.urlHash);
  }

  console.log('\n--- 2. dynamic-index budget: deep cards until budget, then shallow, command completes ---');
  {
    // Load command-agent the way clarify/agent suites do.
    global.self = global;
    global.self.TabDB = loadTabDB();
    await global.self.TabDB.init();
    require(path.join(__dirname, '..', 'tab-cards.js')); // real buildShallowCard + sha256/normalizeUrl
    const CA = require(path.join(__dirname, '..', 'command-agent.js'));

    // 25 uncarded tabs; a deep buildTabCard takes 200ms; concurrency 5 ->
    // batches end at 200/400/600/800ms. The pre-batch check trips at 800ms
    // (>700), so 20 tabs index deep and the last 5 go shallow.
    //
    // CRITIC FIX: the stub now CONSUMES cachedCards exactly like the real
    // buildTabCard does (prepareTabCard's savedCards.find(c => c.urlHash ...)
    // scan). Under the old null-mapped lookup a null in that array would throw
    // TypeError here and the command would lose every deep card -- so this
    // test fails on the defect, not just on budget behavior.
    const tabs = [];
    for (let i = 0; i < 25; i++) {
      tabs.push({ id: 100 + i, title: 'T' + i, url: 'https://site' + i + '.test/page' + i });
    }
    let deepBuilds = 0;
    global.self.buildTabCard = async (tab, cachedCards) => {   // override AFTER require
      if (!Array.isArray(cachedCards)) throw new Error('buildTabCard must receive cachedCards array');
      if (!cachedCards.every(c => c && typeof c.urlHash === 'string')) {
        throw new TypeError("Cannot read properties of null (reading 'urlHash')");  // the fatal symptom
      }
      // Real consume: the same find-scan prepareTabCard performs on cache hits.
      const hit = cachedCards.find(c => c.urlHash === 'never-matches-but-scan-costs');
      await sleep(200);
      deepBuilds++;
      return { ...mkCard('d' + tab.id, tab.id, tab.title), embedding: new Float32Array(4).fill(0.1) };
    };
    const storedShallow = [];
    const realStore = global.self.TabDB.storeTabCard.bind(global.self.TabDB);
    global.self.TabDB.storeTabCard = async (card) => {
      if (card && card.extractionLevel === 'shallow') storedShallow.push(card);
      return realStore(card);
    };
    global.self.Embed = { embed: async () => new Float32Array(8).fill(0) };
    global.self.readAiSettings = async () => ({ selectionEngine: 'nli' });
    global.chrome = {
      tabs: { query: async () => tabs },
      runtime: { lastError: null }
    };

    const t0 = Date.now();
    const ranked = await global.self.retrieveCandidates('find tabs', 1);
    ok('retrieveCandidates exposed', typeof global.self.retrieveCandidates === 'function');
    ok('command result complete: 25 candidates ranked', Array.isArray(ranked) && ranked.length === 25, ranked && ranked.length);
    ok('deep builds stopped at budget (<=20, >=15)', deepBuilds >= 15 && deepBuilds <= 20, { deepBuilds });
    const shallow = ranked.filter(c => c.extractionLevel === 'shallow');
    ok('remaining tabs present as shallow cards', shallow.length >= 5 && shallow.length <= 10, { shallow: shallow.length });
    ok('shallow cards carry no embedding (skip embed under budget)', shallow.every(c => !c.embedding || c.embedding.length === 0));
    ok('shallow cards carry title+url+domain', shallow.every(c => c.title && c.url && typeof c.domain === 'string'));
    ok('shallow cards stored for the background upgrade pass', storedShallow.length === shallow.length, { stored: storedShallow.length });
    ok('shallow card not "fresh" (vecVersion absent -> sweep rebuilds it)',
      shallow.every(c => !(c.enrichment && c.enrichment.vecVersion === 3 && c.enrichment.enrichedAt > 0)));
    ok('wall-clock bounded: ~800-1200ms not 5s of deep builds', Date.now() - t0 < 2000, { ms: Date.now() - t0 });
  }

  console.log('\n--- 3. SPA staleness: title change -> card deleted + one debounced re-index ---');
  {
    // Fresh module registry so background.js re-loads with OUR mocks.
    delete require.cache[require.resolve(path.join(__dirname, '..', 'command-agent.js'))];
    const listeners3 = listeners; // registries are module-scope; section 5 reuses them
    global.self = global;
    const TabDB = loadTabDB();
    await TabDB.init();
    global.self.TabDB = TabDB;
    global.chrome = {
      runtime: { id: 'x', lastError: null, onMessage: { addListener: () => {} }, onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) }, onStartup: { addListener: (fn) => listeners.onStartup.push(fn) }, sendMessage: async () => {}, getURL: (p) => 'chrome-extension://x/' + p },
      tabs: {
        query: async () => [],
        get: async () => tabs3[0],
        group: async () => 1, update: async () => {}, remove: async () => {}, create: async () => {}, move: async () => {}, reload: async () => {},
        sendMessage: async () => {},
        onCreated: { addListener: () => {} }, onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
        onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
        onActivated: { addListener: () => {} }, onMoved: { addListener: () => {} }, onAttached: { addListener: () => {} }, onDetached: { addListener: () => {} },
      },
      tabGroups: { update: async () => {}, onCreated: { addListener: () => {} }, onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onMoved: { addListener: () => {} } },
      windows: { WINDOW_ID_CURRENT: -1, onFocusChanged: { addListener: () => {} }, get: async () => ({ id: 1 }), getLastFocused: async () => ({ id: 1 }) },
      bookmarks: { getTree: async () => [{ id: '0', title: 'root', children: [] }], create: async () => ({}), remove: async () => {}, removeTree: async () => {} },
      storage: {
        local: { get: (k, cb) => { cb({}); return Promise.resolve({}); }, set: (o, cb) => { if (cb) cb(); return Promise.resolve(); }, remove: () => {} },
        sync: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})) },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
      commands: undefined, offscreen: undefined,
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      action: { onClicked: { addListener: () => {} } },
      scripting: { executeScript: async () => [] },
    };
    global.importScripts = () => {};
    global.fetch = async () => { throw new Error('no network in test'); };
    global.self.SessionMemoryEngine = { initialize: async () => {}, getTabTiming: () => ({ openedAt: null }), isEnabled: () => false, recordTabEvent: async () => {} };
    global.self.Indexer = { indexTab: async () => {} };
    global.self.Embed = { init: async () => {}, embed: async () => new Float32Array(8).fill(0), embedBatch: async () => [] };
    global.self.NliSelect = { load: async () => {}, select: async () => ({}) };
    global.self.ensureRagReady = async () => {};
    require(path.join(__dirname, '..', 'tab-cards.js'));

    const tabs3 = [{ id: 500, title: 'Old Title', url: 'https://youtube.test/watch?v=1', windowId: 1, active: true }];
    // Count re-index attempts: indexTabById's first observable action is
    // chrome.tabs.get (after the _indexQueue guard).
    let getCalls = [];
    global.chrome.tabs.get = async (id) => { getCalls.push(id); return tabs3[0]; };
    const urlHash = await global.self.sha256(global.self.normalizeUrl(tabs3[0].url));
    await TabDB.storeTabCard(mkCard(urlHash, 500, 'Old Title'));

    require(path.join(__dirname, '..', 'background.js'));

    const upd = listeners.onUpdated;
    ok('onUpdated listeners registered (incl. SPA one)', upd.length >= 2, upd.length);
    const spaListener = upd[upd.length - 1]; // ours is registered last

    // Two rapid SPA title events (YouTube-style pushState updates)...
    const evt = { type: 'title', tabId: 500, changeInfo: { title: 'New Title' }, tab: tabs3[0] };
    spaListener(evt.tabId, evt.changeInfo, evt.tab);
    spaListener(evt.tabId, { title: 'Newer Title' }, evt.tab);
    await sleep(30);

    ok('stale card deleted immediately (stale-but-absent beats wrong)',
      (await TabDB.getCardByUrlHash(urlHash)) === null);

    // Re-index is debounced 4s trailing; both events must collapse into ONE.
    await sleep(4300);
    ok('two rapid events dedupe to ONE scheduled re-index (single tabs.get attempt)',
      getCalls.length === 1, getCalls);

    // Cancel on tab close: schedule a new burst, close the tab, re-index must
    // never fire.
    getCalls = [];
    const realTab3 = { id: 500, title: 'Third Title', url: 'https://youtube.test/watch?v=2', windowId: 1, active: true };
    spaListener(500, { title: 'Third Title' }, realTab3); // schedule (resets debounce)
    const rem = listeners.onRemoved;
    const spaRemoved = rem[rem.length - 1]; // ours is registered LAST (line 6148 > 5696)
    spaRemoved(500, {});                    // close the tab
    await sleep(4300);
    ok('tab close cancels the pending re-index', getCalls.length === 0, getCalls);
  }

  console.log('\n--- 4. round-2 veto: rejected verdict removes R1 match; max rule otherwise ---');
  {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'command-agent.js'))];
    global.self = global;
    const CA = require(path.join(__dirname, '..', 'command-agent.js'));
    global.self.readAiSettings = async () => ({}); // provider default -> Gemini path
    const candidates = [
      { tabId: 1, title: 'Speculative', url: 'https://a.test/x', domain: 'a.test', mainText: 'pricing page' },
      { tabId: 2, title: 'Solid', url: 'https://b.test/x', domain: 'b.test', mainText: 'exact match' },
      { tabId: 3, title: 'Unseen', url: 'https://c.test/x', domain: 'c.test', mainText: 'never shown to round 2' },
    ];

    async function runWithRounds(round1, round2) {
      const prompts = [];
      global.self.callGeminiWithFallback = async (opts) => {
        prompts.push(opts.prompt + '\n|SYS|' + (opts.systemInstruction || ''));
        const payload = prompts.length === 1 ? round1 : round2;
        return { text: JSON.stringify(payload) };
      };
      return { result: await global.self.reasonOverCandidates('match the thing', candidates), prompts };
    }

    // veto via verdict field
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'looks right', confidence: 0.65 }, { tabId: 2, reason: 'right', confidence: 0.9 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 1, verdict: 'rejected', reason: 'content contradicts', confidence: 0.1 }, { tabId: 2, reason: 'still right', confidence: 0.9 }], needDetails: [] }
      );
      const ids = result.matches.map(m => m.tabId);
      ok('R2 verdict:"rejected" removes the R1 match', !ids.includes(1), ids);
      ok('unrelated R1 match survives the veto', ids.includes(2), ids);
    }
    // veto via confidence<=0.15 + reason "reject..."
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'looks right', confidence: 0.65 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 1, reason: 'reject: page is about pricing', confidence: 0.1 }], needDetails: [] }
      );
      ok('R2 low-confidence reject-reason also vetoes', !result.matches.some(m => m.tabId === 1), result.matches);
    }
    // no verdict -> max rule unchanged
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'first', confidence: 0.65 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 1, reason: 'better read', confidence: 0.9 }], needDetails: [] }
      );
      eq('R2 higher confidence wins (0.9)', result.matches.find(m => m.tabId === 1).confidence, 0.9);
    }
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'first', confidence: 0.65 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 1, reason: 'meh, no verdict', confidence: 0.3 }], needDetails: [] }
      );
      eq('R2 lower confidence, no verdict -> max rule keeps 0.65', result.matches.find(m => m.tabId === 1).confidence, 0.65);
    }
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'first', confidence: 0.65 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 1, reason: 'weak but not a rejection', confidence: 0.1 }], needDetails: [] }
      );
      eq('low confidence WITHOUT reject-reason/verdict does NOT veto', result.matches.find(m => m.tabId === 1).confidence, 0.65);
    }

    // VETO GUARD: R2 only saw text for tabs it requested in needDetails.
    // A "rejected" verdict for a tabId outside needDetails is a hallucination
    // and must be ignored -- the R1 match survives via the max rule.
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'looks right', confidence: 0.65 }, { tabId: 3, reason: 'unsure', confidence: 0.5 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 3, verdict: 'rejected', reason: 'hallucinated rejection, tab 3 text never shown' }], needDetails: [] }
      );
      ok('R2 veto for tabId NOT in needDetails is ignored (R1 match survives)',
        result.matches.some(m => m.tabId === 1) && result.matches.some(m => m.tabId === 3), result.matches);
    }
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'looks right', confidence: 0.65 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 3, verdict: 'rejected', reason: 'hallucinated, unseen tab' }], needDetails: [] }
      );
      ok('rejected-verdict entry for unseen tab never becomes a match',
        !result.matches.some(m => m.tabId === 3), result.matches);
    }
    {
      const { result } = await runWithRounds(
        { decision: 'need_details', matches: [{ tabId: 1, reason: 'looks right', confidence: 0.65 }], needDetails: [1] },
        { decision: 'final', matches: [{ tabId: 3, reason: 'reject: unseen but low-conf phrasing', confidence: 0.1 }], needDetails: [] }
      );
      ok('implicit veto (reject-reason) for tabId outside needDetails does not remove anything',
        !result.matches.some(m => m.tabId === 3), result.matches);
      ok('R1 match untouched by hallucinated implicit veto',
        result.matches.find(m => m.tabId === 1)?.confidence === 0.65, result.matches);
    }

    // prompt advertises the veto option
    {
      const { prompts } = await runWithRounds(
        { decision: 'need_details', matches: [], needDetails: [1] },
        { decision: 'final', matches: [], needDetails: [] }
      );
      const r2 = prompts[1];
      ok('round-2 prompt includes the rejected-verdict option',
        r2.includes('"rejected"') && r2.includes('verdict'), { r2len: r2.length });
      ok('round-2 prompt is the R1 prompt plus details (structure preserved)', r2.includes('Additional text details'));
    }
  }

  console.log('\n--- 5. startup sweep: shallow card is NOT "already indexed" -- it gets rebuilt ---');
  {
    // Reuses the background.js module + mocks from section 3 (listeners.onStartup
    // captured there). Under the old existence-only sweep the shallow card below
    // would be treated as already indexed and persist forever.
    const tabS = { id: 600, title: 'Sweep Target', url: 'https://sweep.test/page1', windowId: 1, active: true };
    const hashS = await global.self.sha256(global.self.normalizeUrl(tabS.url));
    const shallowCard = {
      tabId: 600, urlHash: hashS, url: tabS.url, domain: 'sweep.test',
      title: 'Sweep Target', extractedAt: Date.now(), contentHash: '', mainText: '',
      structured: { type: 'other', headline: '', keywords: [], people: [], datePublished: '' },
      enrichment: { category: 'other', subTopics: [], entities: { people: [], orgs: [], works: [] }, contentType: 'other', summary: 'Sweep Target', enrichedAt: 0 },
      embedding: new Float32Array(0), extractionLevel: 'shallow'
    };
    await global.self.TabDB.storeTabCard(shallowCard);
    ok('shallow card seeded', (await global.self.TabDB.getCardByUrlHash(hashS))?.extractionLevel === 'shallow');

    global.chrome.tabs.query = async () => [tabS];
    const startupLsn = listeners.onStartup[listeners.onStartup.length - 1];
    ok('onStartup listener captured', typeof startupLsn === 'function');
    startupLsn();

    // onStartup schedules the sweep after 1s; poll for the upgrade.
    let upgraded = null;
    for (let i = 0; i < 60 && !upgraded; i++) {
      await sleep(100);
      const c = await global.self.TabDB.getCardByUrlHash(hashS);
      if (c && c.extractionLevel !== 'shallow') upgraded = c;
    }
    ok('startup sweep rebuilt the shallow card (extractionLevel upgraded)', !!upgraded, upgraded && upgraded.extractionLevel);
    ok('rebuilt card is full-fresh (vecVersion 3, enrichedAt > 0)',
      upgraded && upgraded.enrichment && upgraded.enrichment.vecVersion === 3 && upgraded.enrichment.enrichedAt > 0,
      upgraded && upgraded.enrichment);

    // Second sweep: the now-full card must count as already indexed -- no
    // further store of this hash (existence+freshness condition holds both ways).
    let storesAfterUpgrade = 0;
    const realStore5 = global.self.TabDB.storeTabCard.bind(global.self.TabDB);
    global.self.TabDB.storeTabCard = async (card) => {
      if (card && card.urlHash === hashS) storesAfterUpgrade++;
      return realStore5(card);
    };
    startupLsn();
    await sleep(2500);
    ok('second sweep leaves the fresh card alone', storesAfterUpgrade === 0, storesAfterUpgrade);
  }

  console.log('\n' + '='.repeat(64));
  console.log(`PERF+FRESHNESS SUITE: ${pass} pass, ${fail} fail`);
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
