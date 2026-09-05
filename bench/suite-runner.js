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
//
// CLARIFY SIMULATION (V2-3): after selection, the runner replays the exact
// orchestrator clarify decision from command-agent.js. If the pipeline would
// return clarify-needed, the runner SIMULATES the user: it auto-picks the
// option whose (a) label matches the gold notes (case-insensitive substring),
// else (b) whose matchCount best matches |expectedTabIds| (nearest absolute
// distance; TIE-BREAK: the FIRST such option in presentation order). The
// picked option's plan is then what gets scored. Metrics printed per run:
//   clarify-fire rate            clarify-needed decisions / gold commands
//   correct-option-present rate  fired clarifications where the auto-picked
//                                option reproduces the gold selection

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
const RCACHE_EMB = path.join(__dirname, '.suite-v3-emb-cache.json');
const RCACHE_RES = path.join(__dirname, '.suite-v3-result-cache.json');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const CommandAgent = require(path.join(__dirname, '..', 'command-agent.js'));

const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const args = process.argv.slice(2);
const NO_LLM = args.includes('--no-llm');
const IMPLEMENTED_ONLY = args.includes('--implemented-only');
const catArg = args.find(a => a.startsWith('--category'));
const CAT = catArg ? Number(catArg.split('=')[1]) : null;

const SUITE = (args.find(a=>a.startsWith('--suite')) || '--suite=suite-v3').split('=')[1];
const CMD_FILE = path.join(__dirname, SUITE + '.commands.jsonl');
const POOL_FILE = path.join(__dirname, SUITE + '.pool.json');
const QCACHE = path.join(__dirname, '.llm-query-cache.json');
const CLARIFY_CACHE = path.join(__dirname, '.suite-clarify-cache.json');

const qcache = (() => { try { return JSON.parse(fs.readFileSync(QCACHE, 'utf8')); } catch { return {}; } })();
// Sense-score cache: sense concepts are command-derived, so scores are
// deterministic per (suite, command, parse). Cached separately from the
// selection result cache so a clarify replay never re-runs NLI passes.
const clarifyCache = (() => { try { const j = JSON.parse(fs.readFileSync(CLARIFY_CACHE, 'utf8')); return (j && j.codeHash === codeHash) ? j.entries : {}; } catch { return {}; } })();

const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
const CMDS = fs.readFileSync(CMD_FILE, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l)).filter(r => r.command)
  .filter(r => !IMPLEMENTED_ONLY || r.implemented)
  .filter(r => CAT == null || r.category === CAT);

// Cache keys are suite-scoped: poolHash per pool file, entries per (suite,
// command, parse, mode) so identically-phrased commands on different pools
// never share results.
const poolHash = sha(fs.readFileSync(POOL_FILE, 'utf8'));
const resultCache = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(RCACHE_RES, 'utf8'));
    return (j.codeHash === codeHash && j.poolHash === poolHash) ? j.entries : {};
  } catch { return {}; }
})();
const flushResultCache = () => {
  try {
    fs.writeFileSync(RCACHE_RES, JSON.stringify({ codeHash, poolHash, entries: resultCache }, null, 1));
  } catch (e) {
    // A failed cache write (transient Windows file lock / AV scan on the
    // multi-MB JSON) must never abort a gate run -- results are still
    // computed and printed; only the warm cache is lost.
    console.warn(`[cache] result-cache flush failed (${e.code || e.message}); continuing`);
  }
};

// Offset-based times -> epoch ms at suite load. refNow in nli-select anchors
// to the freshest candidate timestamp, which is load-time minus minutes, so
// relative windows reproduce.
const now = Date.now();
const MIN = 60 * 1000;
const at = minAgo => (minAgo == null ? null : now - minAgo * MIN);
const closedTabs = pool.closedTabs || [];

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
  // defaultSenseScorer (command-agent) resolves the engine through self; the
  // runner keeps its own const binding, so expose it for the clarify replay.
  self.NliSelect = NliSelect;

  // Same reasoning as llm-nli-integration: hand every card the embedding the
  // indexer would have stored, or the bench exercises the abstaining path.
  // Embeddings cached per pool hash (pool is read-only gold, so a hit is safe).
  const { pipeline } = require('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const embed = async s => Array.from((await embedder(s, { pooling: 'mean', normalize: true })).data);
  let embCache = {};
  try { embCache = JSON.parse(fs.readFileSync(RCACHE_EMB, 'utf8')); } catch {}
  if (!embCache[poolHash] || typeof embCache[poolHash] !== 'object') embCache = { [poolHash]: {} };
  embCache.poolHash = poolHash;
  for (const c of candidates) {
    const key = NliSelect.tabText(c);
    c.embedding = embCache[poolHash][key] || await embed(key);
    embCache[poolHash][key] = c.embedding;
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
  let clarifyFired = 0, clarifyCorrect = 0;
  const clarifyFires = [];

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
    const rkey = sha(SUITE + '|' + c.command + '|' + JSON.stringify(query) + '|' + (NO_LLM ? 'floor' : 'ceil'));
    const cached = resultCache[rkey];
    let res, nliElapsed = 0, hit = false;
    if (cached && Array.isArray(cached.matches) && Array.isArray(cached.mode)) {
      res = { matches: cached.matches, mode: cached.mode[0] };
      if (Array.isArray(cached.steps)) res.results = cached.steps;
      hit = true; cacheHits++;
    } else {
      const t1 = Date.now();
      res = await NliSelect.select(c.command, candidates, query ? {
        query, meta: {
          currentTabId: pool.meta && pool.meta.currentTabId != null ? pool.meta.currentTabId : null,
          currentWindowId: pool.meta && pool.meta.currentWindowId != null ? pool.meta.currentWindowId : 1
        }
      } : {});
      nliElapsed = Date.now() - t1;
      nliMs += nliElapsed;
      resultCache[rkey] = {
        matches: res.matches.map(m => ({ tabId: m.tabId, confidence: m.confidence, reason: m.reason })),
        mode: [res.mode],
        // Composite (chained) results persist per-step too, so a warm cache
        // reproduces the union scoring exactly.
        ...(Array.isArray(res.results) ? { steps: res.results.map(r => ({ matches: (r.matches || []).map(m => ({ tabId: m.tabId, confidence: m.confidence })) })) } : {})
      };
      flushResultCache();
      cacheMisses++;
    }

    // Composite-plan acceptance (tool-call schema v3): a chained result
    // carries per-step results ({results:[{matches:[...]}]}) instead of one
    // flat match list. Scoring is UNCHANGED -- the selection set is the union
    // of every step's selection.
    //
    // NOTE (R4): this branch is INERT today -- nli-select.select() never
    // emits res.results (it has no steps consumer yet), so on the gold suites
    // every result flows through the flat res.matches path. The branch stays
    // for future use, ready for the day the deterministic/bench selection
    // path starts emitting per-step results; production chains run through
    // background.js's executeChainedPlanSteps instead.
    const flatMatches = Array.isArray(res.results)
      ? res.results.flatMap(r => (Array.isArray(r.matches) ? r.matches : []))
      : res.matches;
    const got = new Set(flatMatches.filter(m => m.confidence >= 0.5).map(m => m.tabId));

    // --- CLARIFY SIMULATION (orchestrator replay, triggers 1+2) ------------
    // Replays command-agent.maybeClarify's decision on the bench pipeline:
    // answerable===false interpretations and the polysemy sense split test.
    // The dual-intent arm (trigger 3) is orchestrator-only in production and
    // needs live-tab action routing; on these gold pools its detector is 0
    // after the participle/noun-phrase suppression, so there is nothing to
    // simulate. When the split test requires clarification, the runner plays
    // the user: notes-label match first, else closest |matchCount| to
    // |expectedTabIds|, tie-break FIRST. The picked option's plan replaces
    // `got` for scoring (the orchestrator would execute exactly that plan).
    let scoredGot = got;
    try {
      const senses = (query && Array.isArray(query.senses)) ? query.senses : [];
      const answerableFalse = !!(query && query.answerable === false);
      if ((senses.length >= 2 || answerableFalse) && CommandAgent.ambiguousIntents(c.command.toLowerCase()).length < 2) {
        const destructive = CommandAgent.DESTRUCTIVE_INTENTS.has(CommandAgent.detectIntent(c.command.toLowerCase()));
        const ckey = sha(SUITE + '|clarify|' + c.command + '|' + JSON.stringify(query));
        let senseScores = clarifyCache[ckey];
        if (!Array.isArray(senseScores)) {
          senseScores = [];
          for (const sense of senses) {
            const sc = await CommandAgent.defaultSenseScorer(sense.concept, candidates);
            senseScores.push({ label: sense.label, concept: sense.concept, matchCount: sc.matchCount, topConf: sc.topConf, tabIds: sc.tabIds });
          }
          clarifyCache[ckey] = senseScores;
          fs.writeFileSync(CLARIFY_CACHE, JSON.stringify(clarifyCache, null, 1));
        }
        let options = null;
        if (senses.length >= 2) {
          const split = CommandAgent.senseSplitTest(senseScores, { destructive });
          if (split.required) {
            options = senseScores.map(sc => ({ label: sc.label, matchCount: sc.matchCount, tabIds: sc.tabIds }));
          }
        } else {
          // answerable===false: score the parser's alternative readings.
          const interps = LlmQuery.generateInterpretations(c.command, 3);
          options = [];
          for (const interp of interps) {
            const sel = await NliSelect.select(c.command, candidates, {
              query: { ...(query || {}), ...interp.query, concepts: interp.query.concepts, selectAll: interp.query.selectAll }
            });
            const ids = (sel.matches || []).filter(m => m.confidence >= 0.5).map(m => m.tabId);
            options.push({ label: interp.label, matchCount: ids.length, tabIds: ids });
          }
          if (options.length < 2) options = null;
        }

        if (options && options.length) {
          clarifyFired++;
          const exp = c.expectedTabIds || [];
          const notesLower = String(c.notes || '').toLowerCase();
          // (a) gold notes name the reading; (b) nearest matchCount; tie -> first.
          let pickIdx = options.findIndex(o => o.label && notesLower && notesLower.includes(o.label.split('—')[0].trim().toLowerCase()));
          if (pickIdx === -1 && exp.length) {
            let best = Infinity;
            for (let i = 0; i < options.length; i++) {
              const d = Math.abs(options[i].matchCount - exp.length);
              if (d < best) { best = d; pickIdx = i; }
            }
          }
          if (pickIdx === -1) pickIdx = 0;
          const picked = options[pickIdx];
          const pickedSet = new Set(picked.tabIds || []);
          const correct = pickedSet.size === exp.length && exp.every(id => pickedSet.has(id));
          if (correct) clarifyCorrect++;
          clarifyFires.push({ id: c.command, suite: SUITE, reason: senses.length >= 2 ? 'senses' : 'answerable', picked: picked.label, pickCount: picked.matchCount, exp: exp.length, correct });
          console.log(`[CLARIFY-FIRE] ${SUITE} "${c.command}" -> picked "${picked.label}" (${picked.matchCount}) exp ${exp.length}`);
          scoredGot = pickedSet;
        }
      }
    } catch (e) {
      console.warn('[CLARIFY] evaluation failed (inert):', e && e.message);
    }

    const b = bucketOf(c);
    const r = score(byBucket[b], c, scoredGot);

    byCategory[c.category] = byCategory[c.category] || s();
    score(byCategory[c.category], c, scoredGot);

    if (!r.exact || r.v) {
      failures.push({ id: c.command, bucket: b, cat: c.category, ...r, got: [...scoredGot], exp: c.expectedTabIds });
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
  console.log(`clarify-fire ${clarifyFired}/${CMDS.length}${CMDS.length ? ` (${(100 * clarifyFired / CMDS.length).toFixed(1)}%)` : ''} | correct-option-present ${clarifyCorrect}/${clarifyFired}${clarifyFired ? ` (${Math.round(100 * clarifyCorrect / clarifyFired)}%)` : ''}`);
  if (clarifyFires.length) {
    for (const f of clarifyFires) {
      console.log(`  [CLARIFY] ${f.suite} "${f.id}" reason=${f.reason} picked="${f.picked}" got ${f.pickCount} exp ${f.exp} correct=${f.correct}`);
    }
  }
  if (failures.length) {
    console.log(`\n-- failures (${failures.length}) ---------------------------------------------`);
    for (const f of failures) {
      console.log(`[${f.bucket}] cat${f.cat} "${f.id}"`);
      console.log(`   got ${JSON.stringify(f.got)} exp ${JSON.stringify(f.exp)}${f.v ? `  VIOLATIONS ${f.v}` : ''}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
