// bench/suite-runner.js
// Full-spec suite runner: 181 gold commands over suite-v3.pool.json (117 tabs,
// 3 windows, 7 groups, offset times). Same pipeline as llm-nli-integration.js
// (LLM query parser -> hybrid cosine/NLI) so its numbers are directly
// comparable with the 112-command v2 benchmark.
//
//   node bench/suite-runner.js [--no-llm] [--implemented-only] [--category N]
//
// Scoring: set-exact, precision, recall, mustNotSelect violations.
// Two cuts are reported: implemented-only (what v2-style reporting gives) and
// all commands (the spec-coverage gap measurement). Abstain/featureGap cases
// pass only when the pipeline selects nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Result cache: NLI stage + pool embeddings are deterministic given
// (selection code, parse, pool). JSON-cache both, keyed on hashes, so repeat
// runs skip the ~300s of model forward passes. Hashing the selection modules
// means a builder's code change invalidates the cache automatically -- the
// loop can never measure stale results.
const DEPS = ['nli-select.js', 'plan-ops.js', 'concept-core.js', 'llm-query.js', 'facet.js', 'domain-priors.js'];
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const codeHash = sha(DEPS.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n'));
const poolHash = sha(fs.readFileSync(path.join(__dirname, 'suite-v3.pool.json'), 'utf8'));
const RCACHE_EMB = path.join(__dirname, '.suite-v3-emb-cache.json');
const RCACHE_RES = path.join(__dirname, '.suite-v3-result-cache.json');
const resultCache = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(RCACHE_RES, 'utf8'));
    return (j.codeHash === codeHash && j.poolHash === poolHash) ? j.entries : {};
  } catch { return {}; }
})();
const flushResultCache = () => fs.writeFileSync(RCACHE_RES, JSON.stringify({ codeHash, poolHash, entries: resultCache }, null, 1));

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));

const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const args = process.argv.slice(2);
const NO_LLM = args.includes('--no-llm');
const IMPLEMENTED_ONLY = args.includes('--implemented-only');
const catArg = args.find(a => a.startsWith('--category'));
const CAT = catArg ? Number(catArg.split('=')[1]) : null;

const CMD_FILE = path.join(__dirname, 'suite-v3.commands.jsonl');
const POOL_FILE = path.join(__dirname, 'suite-v3.pool.json');
const QCACHE = path.join(__dirname, '.llm-query-cache.json');

const qcache = (() => { try { return JSON.parse(fs.readFileSync(QCACHE, 'utf8')); } catch { return {}; } })();

const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
const CMDS = fs.readFileSync(CMD_FILE, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l)).filter(r => r.command)
  .filter(r => !IMPLEMENTED_ONLY || r.implemented)
  .filter(r => CAT == null || r.category === CAT);

// Offset-based times -> epoch ms at suite load. refNow in nli-select anchors
// to the freshest candidate timestamp, which is load-time minus minutes, so
// relative windows reproduce.
const now = Date.now();
const MIN = 60 * 1000;
const at = minAgo => (minAgo == null ? null : now - minAgo * MIN);

const groupById = new Map(pool.groups.map(g => [g.id, g]));

const candidates = pool.tabs.map(t => {
  const c = {
    tabId: t.id,
    title: t.title,
    url: t.url,
    domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
    openedAt: at(t.openedMinAgo),
    lastAccessed: at(t.neverActivated ? t.openedMinAgo : t.lastActiveMinAgo),
    pinned: t.pinned === true,
    muted: t.muted === true,
    audible: t.audible === true,
    incognito: t.incognito === true,
    loading: t.loading === true,
    discarded: t.discarded === true,
    windowId: t.windowId,
    groupId: t.groupId,
    groupName: t.groupId ? groupById.get(t.groupId).name : null,
    groupColor: t.groupId ? groupById.get(t.groupId).color : null,
    index: t.index,
    scrollPct: t.scrollPct,
    watchPct: t.watchPct,
    estReadMin: t.estReadMin,
    lang: t.lang,
    visitCount: t.visitCount,
    userTag: t.userTag,
    priority: t.priority,
    deadlineDays: t.deadlineDays,
    price: t.price,
    inStock: t.inStock,
    rating: t.rating,
    shipsToIndia: t.shipsToIndia,
    currency: t.currency,
    schemaType: t.schemaType,
    datePublished: t.datePublished,
    mainText: t.mainText,
    bookmarked: t.bookmarked === true,
    bookmarkFolder: t.bookmarkFolder,
    opener: t.opener,
    autoOpened: t.autoOpened === true,
    neverActivated: t.neverActivated === true,
    enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
  };
  if (t.duplicateOf != null) c.duplicateOf = t.duplicateOf;
  return c;
});

async function callModel(system, prompt, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.QUERY_MODEL || 'qwen2.5:latest', system, prompt,
        stream: false, format: 'json', options: { temperature: 0, seed: 42, num_predict: 300 }
      }),
      signal: ctrl.signal
    });
    return (await res.json()).response;
  } finally { clearTimeout(timer); }
}

const bucketOf = c => {
  if (c.abstain) return 'abstain';
  if (c.featureGap) return 'featureGap';
  return c.implemented ? 'implemented' : 'gap';
};

const CAT_NAMES = {
  1: 'url-domain', 2: 'structured-url', 3: 'title', 4: 'time', 5: 'tab-state',
  6: 'window-group-position', 7: 'relationship-current', 8: 'duplicates',
  9: 'page-content', 10: 'content-type', 11: 'topic-category', 12: 'entities',
  13: 'nav-origin', 14: 'search-query', 15: 'reading-progress', 16: 'bookmarks',
  17: 'history-frequency', 18: 'error-health', 19: 'language-geo',
  20: 'price-availability', 21: 'task-project', 22: 'quality-authority',
  23: 'cross-tab', 24: 'ranking-limit', 25: 'compound-boolean',
  26: 'conversational', 27: 'user-defined'
};

(async () => {
  await NliSelect.load();

  // Same reasoning as llm-nli-integration: hand every card the embedding the
  // indexer would have stored, or the bench exercises the abstaining path.
  // Embeddings cached per pool hash (pool is read-only gold, so a hit is safe).
  const { pipeline } = require('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const embed = async s => Array.from((await embedder(s, { pooling: 'mean', normalize: true })).data);
  let embCache = {};
  try { embCache = JSON.parse(fs.readFileSync(RCACHE_EMB, 'utf8')); } catch {}
  if (embCache.poolHash !== poolHash) embCache = { poolHash, texts: {} };
  for (const c of candidates) {
    const key = NliSelect.tabText(c);
    c.embedding = embCache.texts[key] || await embed(key);
    embCache.texts[key] = c.embedding;
  }
  fs.writeFileSync(RCACHE_EMB, JSON.stringify(embCache));
  NliSelect.setEmbedder(embed);

  const label = [
    NO_LLM ? 'deterministic parser' : 'LLM parser + NLI',
    IMPLEMENTED_ONLY ? 'implemented-only' : 'all commands',
    CAT != null ? `category ${CAT}` : 'all categories'
  ].join(' | ');
  console.log(`\nSUITE-V3 -- ${label}`);
  console.log(`${CMDS.length} commands, ${candidates.length}-tab pool, ${pool.groups.length} groups, 3 windows`);
  console.log('='.repeat(78));

  const failures = [];
  const byBucket = { implemented: s(), gap: s(), abstain: s(), featureGap: s() };
  const byCategory = {};
  let llmMs = 0, nliMs = 0, cacheHits = 0, cacheMisses = 0, fallbacks = 0;

  function s() { return { n: 0, exact: 0, pSum: 0, rSum: 0, f1Sum: 0, viol: 0 }; }
  function score(slot, c, got) {
    slot.n++;
    const exp = new Set(c.expectedTabIds || []);
    const tp = [...got].filter(id => exp.has(id)).length;
    const p = got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    const r = exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
    const f1 = (p + r) ? 2 * p * r / (p + r) : 0;
    const exact = got.size === exp.size && [...exp].every(id => got.has(id));
    const v = (c.mustNotSelect || []).filter(id => got.has(id)).length;
    slot.exact += exact ? 1 : 0;
    slot.pSum += p; slot.rSum += r; slot.f1Sum += f1; slot.viol += v;
    return { exact, p, r, f1, v };
  }

  for (const c of CMDS) {
    let query = null;
    if (!NO_LLM) {
      const key = LlmQuery.normalizeCommand(c.command);
      if (qcache[key]) { query = qcache[key]; cacheHits++; }
      else {
        const t0 = Date.now();
        query = await LlmQuery.parse(c.command, { callModel, noCache: true });
        llmMs += Date.now() - t0;
        cacheMisses++;
        qcache[key] = query;
        fs.writeFileSync(QCACHE, JSON.stringify(qcache, null, 1));
      }
      if (query.source === 'fallback') fallbacks++;
    }

    // Result cache keyed on (code, pool, command, parse). Parse enters the key
    // so a changed parse after cache eviction still selects honestly.
    const rkey = sha(c.command + '|' + JSON.stringify(query) + '|' + (NO_LLM ? 'floor' : 'ceil'));
    const cached = resultCache[rkey];
    let res, nliElapsed = 0, hit = false;
    if (cached && Array.isArray(cached.matches) && Array.isArray(cached.mode)) {
      res = { matches: cached.matches, mode: cached.mode[0] };
      hit = true; cacheHits++;
    } else {
      const t1 = Date.now();
      res = await NliSelect.select(c.command, candidates, query ? {
        query, meta: { currentTabId: 10, currentWindowId: 1 }
      } : {});
      nliElapsed = Date.now() - t1;
      nliMs += nliElapsed;
      resultCache[rkey] = {
        matches: res.matches.map(m => ({ tabId: m.tabId, confidence: m.confidence, reason: m.reason })),
        mode: [res.mode]
      };
      flushResultCache();
      cacheMisses++;
    }

    const got = new Set(res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId));
    const b = bucketOf(c);
    const r = score(byBucket[b], c, got);

    byCategory[c.category] = byCategory[c.category] || s();
    score(byCategory[c.category], c, got);

    if (!r.exact || r.v) {
      failures.push({ id: c.command, bucket: b, cat: c.category, ...r, got: [...got], exp: c.expectedTabIds });
    }
  }

  const pct = (x, n) => n ? `${x}/${n} (${Math.round(100 * x / n)}%)` : '0/0';
  const avg = (sum, n) => n ? (sum / n).toFixed(2) : '0.00';

  console.log('\n-- by bucket --------------------------------------------------');
  for (const [name, slot] of Object.entries(byBucket)) {
    if (!slot.n) continue;
    console.log(`${name.padEnd(12)} set-exact ${pct(slot.exact, slot.n).padEnd(18)} P ${avg(slot.pSum, slot.n)} R ${avg(slot.rSum, slot.n)} F1 ${avg(slot.f1Sum, slot.n)} violations ${slot.viol}`);
  }
  const total = Object.values(byBucket).reduce((a, b) => ({ n: a.n + b.n, exact: a.exact + b.exact, viol: a.viol + b.viol }), { n: 0, exact: 0, viol: 0 });
  console.log(`${'TOTAL'.padEnd(12)} set-exact ${pct(total.exact, total.n).padEnd(18)} violations ${total.viol}`);

  console.log('\n-- by spec category ------------------------------------------');
  for (const [cat, slot] of Object.entries(byCategory).sort((a, b) => a[0] - b[0])) {
    console.log(`cat ${String(cat).padStart(2)} ${CAT_NAMES[cat].padEnd(22)} set-exact ${pct(slot.exact, slot.n).padEnd(18)} violations ${slot.viol}`);
  }

  console.log(`\nllm ${llmMs}ms (${cacheHits} cache hits, ${cacheMisses} fresh) | nli ${nliMs}ms${resultCache && Object.keys(resultCache).length ? ` | result-cache ${Object.keys(resultCache).size} entries, code ${codeHash}` : ''}`);
  if (failures.length) {
    console.log(`\n-- failures (${failures.length}) ---------------------------------------------`);
    for (const f of failures) {
      console.log(`[${f.bucket}] cat${f.cat} "${f.id}"`);
      console.log(`   got ${JSON.stringify(f.got)} exp ${JSON.stringify(f.exp)}${f.v ? `  VIOLATIONS ${f.v}` : ''}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
