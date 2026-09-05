// r6 probe: single-command pipeline run over suite-v3 pool, reusing the
// suite-runner caches (query parse + embeddings) so no model calls happen.
'use strict';
const path = require('path');
global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const fs = require('fs');

const CMD = process.argv[2];
const args = process.argv.slice(3);
const SHOW_ALL = args.includes('--all');
const DUMP_TOP = Number((args.find(a => a.startsWith('--top=')) || '--top=12').split('=')[1]);

const qcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.llm-query-cache.json'), 'utf8'));
const rcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.suite-v3-result-cache.json'), 'utf8'));

const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'suite-v3.pool.json'), 'utf8'));
const groupById = new Map(pool.groups.map(g => [g.id, g]));
const now = Date.now();
const MIN = 60 * 1000;
const at = minAgo => (minAgo == null ? null : now - minAgo * MIN);

const candidates = pool.tabs.map(t => {
  const c = {
    tabId: t.id, title: t.title, url: t.url,
    domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
    openedAt: at(t.openedMinAgo),
    lastAccessed: at(t.neverActivated ? t.openedMinAgo : t.lastActiveMinAgo),
    pinned: t.pinned === true, muted: t.muted === true, audible: t.audible === true,
    incognito: t.incognito === true, loading: t.loading === true, discarded: t.discarded === true,
    windowId: t.windowId, groupId: t.groupId,
    groupName: t.groupId ? groupById.get(t.groupId).name : null,
    groupColor: t.groupId ? groupById.get(t.groupId).color : null,
    index: t.index, scrollPct: t.scrollPct, watchPct: t.watchPct, estReadMin: t.estReadMin,
    lang: t.lang, visitCount: t.visitCount, userTag: t.userTag, priority: t.priority,
    deadlineDays: t.deadlineDays, price: t.price, inStock: t.inStock,
    rating: t.rating, shipsToIndia: t.shipsToIndia, currency: t.currency,
    schemaType: t.schemaType, datePublished: t.datePublished, mainText: t.mainText,
    bookmarked: t.bookmarked === true, bookmarkFolder: t.bookmarkFolder,
    opener: t.opener, autoOpened: t.autoOpened === true, neverActivated: t.neverActivated === true,
    enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
  };
  if (t.duplicateOf != null) c.duplicateOf = t.duplicateOf;
  return c;
});

(async () => {
  await NliSelect.load();
  const { pipeline } = require('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const embed = async s => Array.from((await embedder(s, { pooling: 'mean', normalize: true })).data);
  const embCache = JSON.parse(fs.readFileSync(path.join(__dirname, '.suite-v3-emb-cache.json'), 'utf8'));
  for (const c of candidates) {
    const key = NliSelect.tabText(c);
    c.embedding = embCache.texts[key] || await embed(key);
  }
  NliSelect.setEmbedder(embed);

  const key = LlmQuery.normalizeCommand(CMD);
  const query = qcache[key];
  if (!query) { console.log('NO PARSE for', CMD); process.exit(1); }
  console.log('PARSE:', JSON.stringify(query));
  const res = await NliSelect.select(CMD, candidates, { query, meta: { currentTabId: 10, currentWindowId: 1 } });
  console.log('MODE:', res.mode, '| matches:', res.matches.length);
  const sel = res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId);
  console.log('GOT:', JSON.stringify(sel));
  const rest = res.matches.slice(0, DUMP_TOP).map(m => `${m.tabId}:${(m.confidence ?? 0).toFixed(2)} ${m.reason.slice(0, 90)}`);
  console.log('TOP:\n' + rest.join('\n'));
  if (SHOW_ALL) {
    console.log('ALL REASONS:');
    for (const m of res.matches) console.log(` ${m.tabId} ${(m.confidence ?? 0).toFixed(2)} ${m.reason}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
