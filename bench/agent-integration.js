// bench/agent-integration.js
// Exercises the REAL retrieveCandidates from command-agent.js against a mocked
// chrome/IndexedDB, so the shipped code is tested rather than a bench replica.
// bench/retrieval-bench.js scores the ranking maths; this checks the wiring the
// maths sits inside -- window scope, prefilter caps, context budget, ties.
//
//   node bench/agent-integration.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cacheFile = path.join(__dirname, '.embed-cache.json');
const embedCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const shaKey = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const recs = fs.readFileSync(path.join(__dirname, 'commands.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;

let indexedCount = 0;   // how many times buildTabCard was invoked
let queriedAllWindows = false;

// --- Build a browser: the 15 gold tabs spread over 3 windows, padded with
// --- filler so the prefilter has something to actually filter.
const FILLER = 985;
function makeProfile() {
  const tabs = [];
  POOL.forEach((t, i) => {
    tabs.push({ id: t.id, url: t.url, title: t.title, windowId: 1 + (i % 3), _gold: t });
  });
  for (let i = 0; i < FILLER; i++) {
    tabs.push({
      id: 1000 + i,
      url: `https://filler-${i}.example.com/page/${i}`,
      title: `Untitled document ${i}`,
      windowId: 1 + (i % 3)
    });
  }
  return tabs;
}
const TABS = makeProfile();

// --- Mock chrome ------------------------------------------------------------
global.chrome = {
  tabs: {
    query: async (q) => {
      if (q.windowId === undefined) queriedAllWindows = true;
      return q.windowId === undefined ? TABS : TABS.filter(t => t.windowId === q.windowId);
    },
    get: async (id) => TABS.find(t => t.id === id)
  },
  storage: { sync: { get: (d, cb) => cb(d) } }
};

// --- Mock the globals command-agent.js reaches through `self` ---------------
global.self = global;

self.readAiSettings = async () => ({ useOllama: true, useBackend: false });
self.normalizeUrl = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
self.sha256 = async (s) => shaKey(s);

self.Embed = {
  embed: async (text) => {
    const v = embedCache[shaKey(text)];
    if (v) return v;
    // Deterministic stand-in for filler tabs absent from the cache. Random
    // would make the run unreproducible; a hash-derived vector is stable.
    const h = crypto.createHash('sha256').update(text).digest();
    return Array.from({ length: 384 }, (_, i) => (h[i % 32] / 255 - 0.5) * 0.05);
  }
};

// Gold tabs are pre-carded; filler tabs are not, so the dynamic-indexing path
// is exercised with a realistic ratio.
const cards = [];
(async () => {
  for (const t of TABS) {
    if (!t._gold) continue;
    const g = t._gold;
    cards.push({
      urlHash: await self.sha256(self.normalizeUrl(t.url)),
      tabId: t.id,
      title: t.title,
      url: t.url,
      domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
      embedding: await self.Embed.embed(`${g.title} ${g.url} ${g.category} ${(g.tags || []).join(' ')}`),
      enrichment: {
        category: g.category,
        tags: (g.tags || []).map(tag => ({ tag, score: 0.9 })),
        contentType: 'article',
        entities: { people: [], orgs: [], works: [] },
        subTopics: []
      }
    });
  }

  self.TabDB = { getAllTabCards: async () => cards };
  self.buildTabCard = async (tab) => {
    indexedCount++;
    return {
      urlHash: await self.sha256(self.normalizeUrl(tab.url)),
      tabId: tab.id, title: tab.title, url: tab.url,
      domain: (tab.url.match(/\/\/([^/]+)/) || [])[1] || '',
      embedding: await self.Embed.embed(tab.title),
      enrichment: { category: 'other', tags: [], contentType: 'other', entities: {}, subTopics: [] }
    };
  };

  require(path.join(__dirname, '..', 'command-agent.js'));

  const CASES = [
    { cmd: 'group all entertainment tabs', intent: 'group_tabs', want: [14] },
    { cmd: 'close my cricket tabs', intent: 'close_tabs', want: [1, 2, 4, 8] },
    { cmd: 'the football tabs', intent: 'search_and_switch', want: [3, 7] },
    { cmd: 'close all youtube.com tabs', intent: 'close_tabs', want: [2, 14] },
    { cmd: 'mute or pin my sports tabs', intent: 'mute_tabs', want: [1, 2, 3, 4, 7, 8] }
  ];

  console.log(`\nAGENT INTEGRATION -- real retrieveCandidates`);
  console.log(`profile: ${TABS.length} tabs across 3 windows, ${cards.length} carded\n`);
  console.log('='.repeat(76));

  let failures = 0;
  for (const c of CASES) {
    indexedCount = 0; queriedAllWindows = false;
    const t0 = Date.now();
    const out = await self.retrieveCandidates(c.cmd, 1, c.intent);
    const ms = Date.now() - t0;

    const ids = out.map(x => x.tabId);
    const scores = out.map(x => x.similarityScore);
    const top = scores[0] || 0;
    const ties = scores.filter(s => Math.abs(s - top) < 1e-9).length;

    // Recall is what retrieval owes the reranker.
    const found = c.want.filter(id => ids.includes(id));
    const missing = c.want.filter(id => !ids.includes(id));
    const ok = missing.length === 0;
    if (!ok) failures++;

    // Windows the surviving gold tabs came from -- proves cross-window reach.
    const wins = new Set(ids.map(id => (TABS.find(t => t.id === id) || {}).windowId).filter(Boolean));

    console.log(`${ok ? 'PASS' : 'FAIL'}  "${c.cmd}"  [${c.intent}]`);
    console.log(`      shortlist ${String(out.length).padStart(3)}   recall ${found.length}/${c.want.length}` +
                `${missing.length ? `  MISSING [${missing}]` : ''}`);
    console.log(`      ties@1 ${ties}   top ${top.toFixed(3)}   indexed ${indexedCount}   ` +
                `windows {${[...wins].sort().join(',')}}   allWindowsQuery=${queriedAllWindows}   ${ms}ms`);
    console.log(`      rank: ${out.slice(0, 8).map(x => `${x.tabId}:${x.similarityScore.toFixed(3)}`).join('  ')}`);
    console.log('');
  }
  console.log('='.repeat(76));
  console.log(failures ? `${failures}/${CASES.length} FAILED\n` : `all ${CASES.length} passed\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
