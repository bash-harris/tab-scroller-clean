// bench/llm-nli-integration.js
// The full MVP pipeline: LLM query parser -> NLI selector.
//
//   node bench/llm-nli-integration.js [commands.jsonl] [--no-llm]
//
// Parses are cached on disk (bench/.llm-query-cache.json) because the point of
// putting the model at the query stage is that a command string repeats and its
// parse is reusable. The cache also makes repeat bench runs fast and
// deterministic -- without it every run pays ~5s x 112 commands.
//
// --no-llm scores the deterministic parser through the same code path, which is
// what the extension does when Ollama is not running. Both numbers matter: one
// is the ceiling, the other is the floor.

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));

const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const args = process.argv.slice(2);
const NO_LLM = args.includes('--no-llm');
const CMD_FILE = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'commands-v2.jsonl');
const QCACHE = path.join(__dirname, '.llm-query-cache.json');
const MODEL = process.env.QUERY_MODEL || 'qwen2.5:latest';

const qcache = (() => { try { return JSON.parse(fs.readFileSync(QCACHE, 'utf8')); } catch { return {}; } })();

async function callModel(system, prompt, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, system, prompt, stream: false, format: 'json',
        options: { temperature: 0, seed: 42, num_predict: 300 }
      }),
      signal: ctrl.signal
    });
    return (await res.json()).response;
  } finally { clearTimeout(timer); }
}

const recs = fs.readFileSync(CMD_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const CMDS = recs.filter(r => r.command);

const candidates = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

(async () => {
  await NliSelect.load();

  // Give every card the embedding the indexer would have stored, and hand the
  // selector the same embedder. Without this the bench measures a pipeline the
  // extension does not run: no card vectors means the cosine stage abstains and
  // EVERY tab falls through to NLI, which is exactly the 15-passes-per-command
  // path the hybrid exists to avoid. The bench must exercise the shipping path.
  const { pipeline } = require('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const embed = async (s) => Array.from(
    (await embedder(s, { pooling: 'mean', normalize: true })).data);
  for (const c of candidates) c.embedding = await embed(NliSelect.tabText(c));
  NliSelect.setEmbedder(embed);

  const label = NO_LLM ? 'deterministic parser (no Ollama)' : `LLM parser (${MODEL}) + NLI`;
  console.log(`\nPIPELINE -- ${label}`);
  console.log(`${path.basename(CMD_FILE)}: ${CMDS.length} commands, ${candidates.length}-tab pool`);
  console.log('='.repeat(78));

  let exact = 0, pSum = 0, rSum = 0, f1Sum = 0, viol = 0;
  let llmMs = 0, nliMs = 0, hits = 0, misses = 0, fallbacks = 0;
  let totalPasses = 0, totalCached = 0;
  const modes = {};
  const failures = [];

  for (const c of CMDS) {
    let query = null;
    if (!NO_LLM) {
      const key = LlmQuery.normalizeCommand(c.command);
      if (qcache[key]) { query = qcache[key]; hits++; }
      else {
        const t0 = Date.now();
        query = await LlmQuery.parse(c.command, { callModel, noCache: true });
        llmMs += Date.now() - t0;
        misses++;
        qcache[key] = query;
        fs.writeFileSync(QCACHE, JSON.stringify(qcache, null, 1));
      }
      if (query.source === 'fallback') fallbacks++;
    }

    const t1 = Date.now();
    const res = await NliSelect.select(c.command, candidates, query ? { query } : {});
    nliMs += Date.now() - t1;
    if (res.stats) { totalPasses += res.stats.passes; totalCached += res.stats.cached; }
    modes[res.mode] = (modes[res.mode] || 0) + 1;

    const got = new Set(res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId));
    const exp = new Set(c.expectedTabIds || []);
    const tp = [...got].filter(id => exp.has(id)).length;
    const precision = got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    const recall = exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
    const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
    const isExact = got.size === exp.size && [...exp].every(id => got.has(id));
    const v = (c.mustNotSelect || []).filter(id => got.has(id)).length;

    if (isExact) exact++;
    pSum += precision; rSum += recall; f1Sum += f1; viol += v;
    if (!isExact || v) {
      failures.push({
        cmd: c.command, exp: [...exp].sort((a, b) => a - b), got: [...got].sort((a, b) => a - b),
        v, mode: res.mode, concepts: (query && query.concepts) || res.concepts
      });
    }
  }

  const n = CMDS.length;
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`  set-exact        ${exact}/${n} (${pct(exact / n)})`);
  console.log(`  precision        ${pct(pSum / n)}`);
  console.log(`  recall           ${pct(rSum / n)}`);
  console.log(`  F1               ${pct(f1Sum / n)}`);
  console.log(`  mustNotSelect    ${viol} violation(s)`);

  // LATENCY REPORTING IS DELIBERATELY PESSIMISTIC.
  //
  // The naive number here -- total ms / commands -- read 128ms, and it was
  // misleading twice over, both times in my favour:
  //
  //   1. Node resolves onnxruntime-node (native, multi-threaded, ~13ms/pass).
  //      The extension runs WASM in a service worker at 1423ms/pass, MEASURED on
  //      a 453-tab profile with simd confirmed on. Same code, ~110x apart.
  //   2. All 112 commands share ONE 15-tab pool, so the score cache is warm
  //      after the first few commands. A real command scores tabs it has never
  //      seen, so every pass is cold.
  //
  // That is how a 90-second real command passed a bench claiming 128ms. Report
  // the pass COUNT -- backend-independent, and the thing the code actually
  // controls -- and project the service-worker cost from the measured per-pass
  // number rather than a hoped-for one.
  const WASM_MS_PER_PASS = 1423;   // measured in-browser, simd=true
  const perCmd = totalPasses / n;
  console.log(`  forward passes   ${perCmd.toFixed(1)} per command (${totalPasses} cold, ${totalCached} cache hits)`);
  console.log(`  latency (node)   ${(nliMs / n).toFixed(0)}ms per command   [native onnxruntime -- NOT what ships]`);
  console.log(`  latency (WASM)   ~${(perCmd * WASM_MS_PER_PASS / 1000).toFixed(1)}s per command   [projected at the measured ${WASM_MS_PER_PASS}ms/pass]`);
  if (!NO_LLM) {
    console.log(`  query parse      ${hits} cached, ${misses} live` +
      (misses ? ` (${(llmMs / misses / 1000).toFixed(1)}s each)` : '') +
      `, ${fallbacks} fell back to deterministic`);
  }
  console.log(`  modes            ${JSON.stringify(modes)}`);

  if (failures.length) {
    console.log(`\n  failures (${failures.length}):`);
    for (const f of failures) {
      console.log(`   "${f.cmd}"  [${f.mode}] concepts=${JSON.stringify(f.concepts)}`);
      console.log(`      want [${f.exp}]  got [${f.got}]${f.v ? '  ** FORBIDDEN **' : ''}`);
    }
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
