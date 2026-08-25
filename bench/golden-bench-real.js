// bench/golden-bench-real.js
// The REAL pipeline, scored against the golden set.
//
// Per command, exactly what the extension does after the domain fast path:
//   1. resolveDomainScopes + shape guard  -> deterministic selection (prod fast path)
//   2. else LlmQuery.decode (via adapter)  -> Ollama qwen2.5 (JSON-schema
//                                            format, temp 0, seed 42 --
//                                            identical options to
//                                            llm-query.js defaultCallModel)
//   3. NliSelect.select(cmd, cards, {query}) -> cosine bands + zero-shot NLI
//   4. matches with confidence >= 0.5 become tabIds (runSemanticPipeline rule)
//
// Preview policy is PRODUCTION's, not a bench invention:
//   needPreview = destructive || selectedCount >= 3 || planConfidence < 0.75
//   (background.js AI_COMMAND handler); planConfidence = mean match confidence.
// Ambiguous cases are compliant iff a preview would fire under that rule.
//
// Parse responses are cached to .llm-real-cache.json after EVERY call, so an
// interrupted first pass banks its work.
//
//   node bench/golden-bench-real.js            full run (first pass hits Ollama)
//   node bench/golden-bench-real.js --fresh    ignore parse cache
//   node bench/golden-bench-real.js --limit 6  quick wiring check

'use strict';
const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const {
  resolveDomainScopes, isDomainScopeCommand
} = require(path.join(__dirname, '..', 'command-agent.js'));

const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const DATA_FILE = path.join(__dirname, 'golden-set.jsonl');
const PARSE_CACHE = path.join(__dirname, '.llm-real-cache.json');
const INTERNAL_IDS = new Set([47, 48]);

// Parse cache entries are stamped with PROMPT_HASH|SCHEMA_HASH: a prompt OR
// decode-format edit invalidates ONLY the stale entries (incremental lazy
// reparse) instead of nuking the whole cache and costing 15-25 minutes of
// fresh Ollama parses. The second half hashes the actual decode format
// (DECODE_FORMAT below) -- switching between bare 'json' and a grammar schema
// changes model output, so old replies must not be trusted across the switch.
const crypto = require('crypto');
const Listwise = require(path.join(__dirname, '..', 'listwise.js'));
const PROMPT_HASH = crypto.createHash('sha256').update(LlmQuery.SYSTEM).digest('hex').slice(0, 10);
// Single source of truth for the grammar half of the stamp. M3 (format =
// LlmQuery.JSON_SCHEMA) is reverted to bare 'json'; hashing the actual format
// token means flipping decode mode reparses the cache honestly -- M3-era
// schema-decoded entries go stale here and lazily reparse under bare json.
const DECODE_FORMAT = 'json';
const SCHEMA_HASH = crypto.createHash('sha256').update(JSON.stringify(DECODE_FORMAT)).digest('hex').slice(0, 10);
const PARSE_STAMP = PROMPT_HASH + '|' + SCHEMA_HASH;
// Listwise verdicts get their own stamp (same pattern): an adjudication-prompt
// edit invalidates only the '::lw' entries.
const LW_PROMPT_HASH = crypto.createHash('sha256').update(Listwise.SYSTEM_PROMPT).digest('hex').slice(0, 10);
function loadParseCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(PARSE_CACHE, 'utf8'));
    // Legacy entries (no .p stamp) are treated as stale on read; they get
    // overwritten lazily as commands are reparsed.
    return raw;
  } catch { return {}; }
}
function entryValid(e) { return !!(e && e.q && e.p === PARSE_STAMP); }
function saveParseCache(c) { try { fs.writeFileSync(PARSE_CACHE, JSON.stringify(c)); } catch {} }

async function ollamaWarmup() {
  // Load model weights into memory while the NLI pipeline warms, and pin them
  // with keep_alive so mid-run unload stalls (the 391ms/pass spikes) can't
  // happen. Best-effort: failure just means the first parse pays the cold load.
  try {
    await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:latest', prompt: 'ok', stream: false, keep_alive: '30m', options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(120000)
    });
    console.log('[warmup] qwen2.5 loaded, pinned for 30m');
  } catch (e) {
    console.warn('[warmup] skipped:', e.message);
  }
}

async function ollamaParse(cmd, sampleOpts = {}) {
  // Hard abort: a stalled Ollama (model unload, queue jam) must fail the parse
  // and fall through to the deterministic parser, never hang the whole run.
  // format is bare 'json' (DECODE_FORMAT): M3's grammar-constrained decode was
  // reverted after it regressed v2. sampleOpts carries the M2 self-consistency
  // temperature/seed overrides.
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5:latest',
      system: LlmQuery.SYSTEM,
      prompt: `Command: "${cmd}"`,
      stream: false,
      format: DECODE_FORMAT,
      keep_alive: '30m',
      options: {
        temperature: Number.isFinite(sampleOpts.temperature) ? sampleOpts.temperature : 0,
        seed: Number.isFinite(sampleOpts.seed) ? sampleOpts.seed : 42,
        num_predict: 300
      }
    }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await res.json();
  return data.response;
}

// Listwise adjudication channel (Tier 1.3). Same endpoint/model/options as
// ollamaParse -- format:'json' KEPT because listwise wants JSON -- with a
// tighter budget: the reply is one small object, not a parse schema.
async function ollamaChat(system, user) {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5:latest',
      system,
      prompt: user,
      stream: false,
      format: 'json',
      keep_alive: '30m',
      options: { temperature: 0, seed: 42, num_predict: 200 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await res.json();
  return data.response;
}

function effectiveReference(c, got) {
  const primary = (c.expectedTabIds || []).slice().sort((a, b) => a - b);
  const sameAs = (arr, ref) => arr.length === ref.length && ref.every(id => arr.includes(id));
  if (sameAs(got, primary)) return primary;
  for (const alt of c.acceptableSuperset || []) {
    if (sameAs(got, alt.slice().sort((a, b) => a - b))) return alt;
  }
  return primary;
}

function bucketUnion(c, selectableIds) {
  if (!c.expectedBuckets) return null;
  const named = new Set();
  for (const b of c.expectedBuckets) if (!b.rest) for (const id of b.tabIds || []) named.add(id);
  const out = new Set(named);
  for (const b of c.expectedBuckets) if (b.rest) for (const id of selectableIds) if (!named.has(id)) out.add(id);
  return [...out];
}

(async () => {
  const tRunStart = Date.now();
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx > -1 ? Number(argv[limitIdx + 1]) : Infinity;
  // --file lets independent judges score their own command sets against the
  // SAME frozen 52-tab pool without touching bench/golden-set.jsonl. The file
  // must be JSONL: first line {"_tabPool":[...]} optional (defaults to the
  // golden pool), then one command record per line using the golden schema
  // (id/command/expectedIntent/expectedTabIds/mustNotSelect/...). Validate
  // authoring with `node bench/validate-golden.js <yourfile>`.
  const fileIdx = argv.indexOf('--file');
  const dataFile = fileIdx > -1 && argv[fileIdx + 1] ? path.resolve(argv[fileIdx + 1]) : DATA_FILE;

  const recs = fs.readFileSync(dataFile, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
  const hasPool = !!recs.find(r => r._tabPool);
  let pool, all;
  if (hasPool) {
    pool = recs.find(r => r._tabPool)._tabPool;
    all = recs.filter(r => r.command);
  } else {
    pool = recs.find(r => r._meta)._tabPoolFallback || null;
  }
  if (!pool) {
    // Fall back to the frozen golden pool so user-authored command-only files
    // (no _tabPool line) still evaluate against identical tabs.
    const grecs = fs.readFileSync(DATA_FILE, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
    pool = grecs.find(r => r._tabPool)._tabPool;
  }
  const casesAll = all.filter(c => !(c.expectedIntent === 'group_multi' && !c.expectedBuckets));

  // FAST MODE: iterate on the previous run's failures plus one sentinel per
  // bucket (regression tripwire) instead of the full set. Full runs seed the
  // failure state file; --fast reads it. Typical loop: 80 cmds -> ~35.
  const stateDir = path.join(__dirname, '.bench-state');
  const stateKey = crypto.createHash('sha256').update(dataFile).digest('hex').slice(0, 10);
  const failStatePath = path.join(stateDir, `failures-${stateKey}.json`);
  let cases = casesAll;
  if (argv.includes('--fast')) {
    const sentinels = new Map();
    for (const c of casesAll) if (!sentinels.has(c.bucket)) sentinels.set(c.bucket, c.id);
    let failIds = [];
    try {
      const st = JSON.parse(fs.readFileSync(failStatePath, 'utf8'));
      failIds = st.failures || [];
    } catch {
      console.warn('--fast: no prior failure state; running FULL set to seed one.');
    }
    const keep = new Set([...failIds, ...sentinels.values()]);
    cases = casesAll.filter(c => keep.has(c.id));
    console.log(`FAST MODE: ${cases.length}/${casesAll.length} commands (${failIds.length} prior failures + ${sentinels.size} bucket sentinels)`);
  }
  cases = cases.slice(0, limit);
  const selectableIds = pool.map(t => t.id).filter(id => !INTERNAL_IDS.has(id));

  // Candidates shaped exactly as retrieveCandidates hands them to select().
  // Qualifier fields (pinned/muted/audible/timestamps/duplicateOf) pass
  // through from the pool records so the deterministic time/state filters in
  // nli-select.js see what production chrome.tabs.Tab objects carry.
  const candidates = pool.filter(t => !INTERNAL_IDS.has(t.id)).map(t => ({
    tabId: t.id,
    title: t.title,
    url: t.url,
    domain: (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
    lastAccessed: t.lastAccessed ? Date.parse(t.lastAccessed) : null,
    openedAt: t.openedAt ? Date.parse(t.openedAt) : null,
    pinned: t.pinned === true,
    muted: t.muted === true,
    audible: t.audible === true,
    duplicateOf: t.duplicateOf != null ? t.duplicateOf : null,
    enrichment: {
      category: t.category,
      tags: (t.tags || []).map(tag => ({ tag, score: 0.9 }))
    }
  }));

  // chrome mock so executeDomainScopePlan queries the frozen pool.
  global.chrome = { tabs: { query: async () => pool.map(t => ({ id: t.id, url: t.url, title: t.title })) } };

  // Warm Ollama weights concurrently with NLI load — the first parse stops
  // paying the cold-start tax.
  const warmupP = ollamaWarmup();
  await NliSelect.load();
  await warmupP;

  let exact = 0, precSum = 0, recSum = 0, f1Sum = 0, n = 0;
  let violations = 0;
  let abstainCases = 0, abstainCorrect = 0;
  let ambigCases = 0, ambigCompliant = 0;
  let closeWrong = 0, closeSelected = 0;
  let previewsFired = 0;
  const sourceCounts = {};
  const failures = [];
  let msLlm = 0, msNli = 0;

  const parseCache = fresh ? {} : loadParseCache();
  {
    // Cache-stamp migration telemetry: how many main entries the new
    // PROMPT|SCHEMA stamp invalidates (they reparse lazily below).
    const mains = Object.keys(parseCache).filter(k => !k.includes('::lw'));
    const stale = mains.filter(k => !entryValid(parseCache[k]));
    console.log(`[cache] ${mains.length - stale.length}/${mains.length} parse entries valid under ${PARSE_STAMP}; ${stale.length} stale -> lazy reparse`);
  }

  for (const c of cases) {
    const cmdLower = c.command.toLowerCase();
    let selected = [], planConfidence = 1.0, source = 'domain-fastpath', destructive = false;

    // --- Stage 1: deterministic domain fast path (prod order) ---
    // Guarded: if the extension no longer exports the fast path (regressed),
    // score against the semantic path as it truly behaves today.
    const hasFastPath = typeof resolveDomainScopes === 'function' && typeof isDomainScopeCommand === 'function';
    const scopes = hasFastPath ? resolveDomainScopes(cmdLower) : null;
    if (!hasFastPath) source = 'semantic-only';
    if (hasFastPath && scopes && isDomainScopeCommand(cmdLower)) {
      const hosts = scopes.flat();
      selected = selectableIds.filter(id => {
        const t = pool.find(p => p.id === id);
        const host = t ? t.url.match(/\/\/([^/]+)/)?.[1]?.replace(/^www\./, '') : '';
        return host && hosts.some(h => host === h || host.endsWith('.' + h));
      });
    } else {
      // --- Stage 2: Ollama parse via the shared decode pipeline ---
      // M1 coverage gate + M2 self-consistency live inside LlmQuery.decode;
      // the adapter only owns transport (keep_alive, hard timeout) and file
      // caching. forceSample:'auto': during a lazy reparse, any first-pass
      // drift signal (coverage < 1 or low confidence) buys the 3-sample
      // repair; clean high-confidence parses skip straight through.
      const key = LlmQuery.normalizeCommand(c.command);
      const t0 = Date.now();
      let parsed;
      const cached = !fresh ? parseCache[key] : null;
      if (entryValid(cached)) {
        // Reconcile on read as well: it is a pure (cmd, parse) function, so
        // entries written before a guard change converge to current behavior
        // without paying a reparse.
        parsed = LlmQuery.reconcile(c.command, cached.q); source = 'cache';
      } else {
        try {
          parsed = await LlmQuery.decode(
            c.command,
            (_system, _prompt, _timeout, so) => ollamaParse(c.command, so || {}),
            { forceSample: 'auto' }
          );
          if (parsed) {
            // Production parity: apply the same deterministic post-guards
            // parse() applies to its own decodes (domain hallucination,
            // open_tabs downgrade, select-all reconciliation).
            parsed = LlmQuery.reconcile(c.command, parsed);
            parseCache[key] = { q: parsed, _t: Date.now(), p: PARSE_STAMP };
            saveParseCache(parseCache);
            source = 'llm';
          } else {
            source = 'fallback';
          }
        } catch (e) {
          parsed = null; source = 'error';
        }
      }
      if (!parsed) parsed = LlmQuery.parse(c.command, { noCache: true }); // sync-free fallback via concept-core
      if (!parsed) parsed = { intent: 'group_tabs', concepts: [], combine: 'union', expansions: {}, domains: [], confidence: 0.5, source: 'fallback' };
      msLlm += Date.now() - t0;

      // --- Stage 3: cosine bands + zero-shot NLI (+ listwise cascade) ---
      // callModel is cache-aware: listwise verdicts bank under key
      // cmd+'::lw' with the adjudication PROMPT_HASH stamp, so a rerun never
      // repays a settled comparative pick. The enabled flag is explicit --
      // without it nli-select keeps today's byte-identical path.
      const tn = Date.now();
      const lwKey = c.command + '::lw';
      const callModel = async (system, user) => {
        const hit = !fresh ? parseCache[lwKey] : null;
        if (hit && hit.p === LW_PROMPT_HASH && typeof hit.reply === 'string') return hit.reply;
        const reply = await ollamaChat(system, user);
        parseCache[lwKey] = { reply, _t: Date.now(), p: LW_PROMPT_HASH };
        saveParseCache(parseCache);
        return reply;
      };
      const res = await NliSelect.select(c.command, candidates, {
        query: parsed,
        callModel,
        listwise: { enabled: true }
      });
      msNli += Date.now() - tn;
      source = source === 'llm' && parsed.source !== 'llm' ? parsed.source : source;
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;

      const matches = (res.matches || []).filter(m => (Number(m.confidence ?? m.score)) >= 0.5);
      selected = matches.map(m => Number(m.tabId));
      planConfidence = matches.length
        ? matches.reduce((s, m) => s + Number(m.confidence ?? m.score), 0) / matches.length
        : 0;
    }

    destructive = c.expectedIntent === 'close_tabs';
    const needPreview = destructive || selected.length >= 3 || planConfidence < 0.75;
    if (needPreview) previewsFired++;

    // --- Scoring (identical semantics to golden-bench.js) ---
    if (c.expectedIntent === 'group_multi' && !c.expectedBuckets) continue;
    let expArr;
    if (c.expectedIntent === 'group_multi') expArr = bucketUnion(c, selectableIds) || [];
    else expArr = effectiveReference(c, selected);
    const exp = new Set(expArr);
    const got = new Set(selected);

    const tp = [...got].filter(id => exp.has(id)).length;
    precSum += got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    recSum += exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);

    // Per-case set-F1: the steering gradient exact-match hides. A 4-of-5
    // selection must score visibly better than returning nothing, or lever
    // selection is guesswork.
    let f1SumCase = 0;
    {
      const fp = got.size - tp, fn = exp.size - tp;
      f1SumCase = (tp + fp / 2 + fn / 2) > 0 ? (2 * tp) / (2 * tp + fp + fn) : 1;
    }
    f1Sum += f1SumCase;

    const isExact = got.size === exp.size && expArr.every(id => got.has(id));
    if (isExact) exact++;

    let viol = (c.mustNotSelect || []).filter(id => got.has(id)).length;
    for (const id of got) if (INTERNAL_IDS.has(id)) viol++;
    if (c.expectedIntent === 'clarify' && got.size > 0) viol++;
    violations += viol;

    if ((c.expectedTabIds || []).length === 0 && c.expectedIntent !== 'group_multi') {
      abstainCases++; if (got.size === 0) abstainCorrect++;
    }
    if (c.expectAmbiguous) {
      ambigCases++; if (needPreview) ambigCompliant++;
    }
    if (c.expectedIntent === 'close_tabs' && exp.size > 0) {
      closeSelected += got.size; closeWrong += (got.size - tp);
    }
    n++;

    if (!isExact || viol > 0) {
      failures.push({ id: c.id, bucket: c.bucket, command: c.command,
        expected: expArr.slice().sort((a, b) => a - b),
        got: [...got].sort((a, b) => a - b), viol, conf: planConfidence.toFixed(2) });
    }
    process.stdout.write(`\r${n}/${cases.length} parsed=${Object.entries(sourceCounts).map(([k, v]) => k + ':' + v).join(' ')}`);
  }
  console.log('');

  const pct = x => (100 * x).toFixed(0) + '%';
  console.log(`\nGOLDEN BENCH -- REAL PIPELINE (ollama qwen2.5 -> cosine/NLI)`);
  console.log(`  ${n} commands | parse sources: ${JSON.stringify(sourceCounts)} | llm ${Math.round(msLlm / Math.max(1, n))}ms avg | nli+cosine ${Math.round(msNli / Math.max(1, n))}ms avg`);
  console.log('-'.repeat(64));
  console.log(`  set-exact             ${exact}/${n} (${pct(exact / n)})`);
  console.log(`  precision             ${pct(precSum / n)}`);
  console.log(`  recall                ${pct(recSum / n)}`);
  console.log(`  set-F1 (macro)        ${pct(f1Sum / n)}`);
  console.log(`  violations            ${violations}`);
  console.log(`  abstain-correct       ${abstainCorrect}/${abstainCases}`);
  console.log(`  ambiguous-compliance  ${ambigCompliant}/${ambigCases} (production preview policy)`);
  console.log(`  false-close           ${closeWrong}/${closeSelected} wrong-on-close`);
  console.log(`  preview-rate          ${previewsFired}/${n}`);

  const gates = [
    ['set-exact >= 75%', exact / n >= 0.75],
    ['precision >= 95%', precSum / n >= 0.95],
    ['recall >= 85%', recSum / n >= 0.85],
    ['violations = 0', violations === 0],
    ['ambiguous-compliance = 100%', ambigCases === 0 || ambigCompliant === ambigCases],
  ];
  gates.forEach(([l, ok]) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}`));
  console.log(`  GATES: ${gates.every(g => g[1]) ? 'ALL GREEN' : 'NOT MET'}`);

  const lws = NliSelect.listwiseStats();
  console.log(`  [listwise] escalated ${lws.escalated} times (${lws.adjudicated} adjudicated)`);

  console.log(`\n  failures (${failures.length}):`);
  for (const f of failures.slice(0, 40)) {
    console.log(`   [${f.id}/${f.bucket}] "${f.command}"`);
    console.log(`      expected [${f.expected}]  got [${f.got}]${f.viol ? `  ** ${f.viol} VIOL **` : ''}  conf=${f.conf}`);
  }

  // Seed the fast-mode failure state (full runs only — a --fast run must not
  // shrink its own scope for the next iteration).
  if (!argv.includes('--fast')) {
    try {
      fs.mkdirSync(path.join(__dirname, '.bench-state'), { recursive: true });
      fs.writeFileSync(failStatePath, JSON.stringify({
        generatedAt: new Date().toISOString(), dataFile: path.basename(dataFile),
        failures: failures.map(f => f.id)
      }, null, 1));
      console.log(`\n  failure state seeded -> ${path.basename(failStatePath)} (${failures.length} ids)`);
    } catch {}
  }
  console.log(`  wall time: ${((Date.now() - tRunStart) / 1000).toFixed(1)}s`);
})().catch(e => { console.error(e); process.exit(1); });
