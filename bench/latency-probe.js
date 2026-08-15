// bench/latency-probe.js
// Why did selection take 90s in the browser when the bench said 128ms?
//
// Two reasons the bench structurally could not see:
//
//   1. BACKEND. Node resolves onnxruntime-node (native, multi-threaded). The MV3
//      service worker runs WASM, and nli-select.js pins numThreads = 1. Different
//      runtime, different order of magnitude. The bench never ran the shipping one.
//
//   2. CACHE. The bench replays 112 commands over the SAME 15-tab pool, so the
//      (term, tabText) score cache is ~99% hits after the first few commands. The
//      mean latency it printed was an amortised-cache number. A real command sees
//      30 tabs it has never scored: every pass is cold.
//
// This probe measures COLD per-forward-pass cost, which is the only number that
// predicts browser latency, and counts how many passes a command actually issues.
//
//   node bench/latency-probe.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const { env, pipeline } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const cards = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

const ms = t => `${t.toFixed(0)}ms`;

(async () => {
  const t0 = Date.now();
  const zs = await pipeline('zero-shot-classification', NliSelect.MODEL_ID);
  console.log(`\nmodel load: ${ms(Date.now() - t0)}   backend: ${process.versions.node ? 'onnxruntime-node (native)' : 'wasm'}`);

  const texts = cards.map(c => NliSelect.tabText(c));
  const avgChars = texts.reduce((a, s) => a + s.length, 0) / texts.length;
  const tok = zs.tokenizer(texts[0], { text_pair: 'This browser tab is about gaming.' });
  console.log(`tab card: ${avgChars.toFixed(0)} chars avg -> ${tok.input_ids.dims[1]} tokens (premise+hypothesis)\n`);

  // ---- cold per-pass cost vs premise length -------------------------------
  console.log('COLD per-forward-pass cost by premise length');
  console.log('='.repeat(58));
  console.log('  chars   passes   total      per-pass');
  console.log('-'.repeat(58));
  const perPass = {};
  for (const limit of [400, 240, 160, 100]) {
    const t = Date.now();
    for (const s of texts) {
      await zs(s.slice(0, limit), ['gaming'],
        { multi_label: true, hypothesis_template: 'This browser tab is about {}.' });
    }
    const el = Date.now() - t;
    perPass[limit] = el / texts.length;
    console.log(`  ${String(limit).padStart(5)}   ${String(texts.length).padStart(6)}   ${ms(el).padStart(8)}   ${ms(el / texts.length).padStart(8)}`);
  }

  // ---- how many passes does one real command issue? -----------------------
  const qcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.llm-query-cache.json'), 'utf8'));
  const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
  let withExp = 0, withoutExp = 0, n = 0;
  for (const c of recs.filter(r => r.command)) {
    const q = qcache[LlmQuery.normalizeCommand(c.command)];
    if (!q || !q.concepts?.length) continue;
    n++;
    for (const con of q.concepts) {
      withoutExp += 1;
      withExp += 1 + ((q.expansions && q.expansions[con]) || []).length;
    }
  }
  const passesPerTab = { on: withExp / n, off: withoutExp / n };
  console.log(`\nterms per command: ${passesPerTab.on.toFixed(2)} with expansions, ` +
    `${passesPerTab.off.toFixed(2)} without  (n=${n})`);

  // ---- projection ---------------------------------------------------------
  // The service worker is WASM single-thread. Measured ratio vs native is not
  // observable from here, so the projection is reported per-pass and the browser
  // multiplier is left explicit rather than invented.
  const observed = { tabs: 30, totalMs: 90177 };
  const passesObserved = observed.tabs * passesPerTab.on;
  console.log(`\nOBSERVED IN BROWSER: 30 candidates, ${ms(observed.totalMs)} total`);
  console.log(`  => ~${passesObserved.toFixed(0)} passes => ${ms(observed.totalMs / passesObserved)} per pass in WASM/1-thread`);
  console.log(`  => native here is ${ms(perPass[400])} per pass: WASM is ~${(observed.totalMs / passesObserved / perPass[400]).toFixed(0)}x slower\n`);

  console.log('LEVERS (multiplicative, on pass COUNT and pass COST)');
  console.log('='.repeat(58));
  const wasmPerPass = observed.totalMs / passesObserved;
  const rows = [
    ['baseline: 30 tabs, expansions on, 400 chars', 30 * passesPerTab.on, wasmPerPass],
    ['expansions off (bench: identical accuracy)', 30 * passesPerTab.off, wasmPerPass],
    ['+ shortlist 30 -> 12 (recall@10 was 97%)', 12 * passesPerTab.off, wasmPerPass],
    ['+ premise 400 -> 160 chars', 12 * passesPerTab.off, wasmPerPass * (perPass[160] / perPass[400])],
    ['+ 4 WASM threads', 12 * passesPerTab.off, wasmPerPass * (perPass[160] / perPass[400]) / 4],
  ];
  for (const [label, passes, cost] of rows) {
    console.log(`  ${label.padEnd(44)} ${String(passes.toFixed(0)).padStart(3)} passes  ${ms(passes * cost).padStart(9)}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
