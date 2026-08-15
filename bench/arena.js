// bench/arena.js
// Head-to-head on bench/commands.jsonl. Every arm sees the same commands, the
// same 15-tab pool, and is scored identically.
//
//   node bench/arena.js                     V1 + NLI  (no LLM, fast)
//   node bench/arena.js --ollama            + qwen2.5-coder:3b (the shipping model)
//   node bench/arena.js --ollama --ollama7b + qwen2.5:latest (7.6B)
//
// Metrics:
//   set-exact  selected set === expected set. The honest headline.
//   precision  of what was selected, how much was right
//   recall     of what was expected, how much was found
//   F1         harmonic mean
//   violations tabs in mustNotSelect that were selected anyway
//   ties       candidates tied at the top score (ranking dead when high)

const fs = require('fs');
const path = require('path');
const { selectV1, makeNliSelector, makeOllamaSelector, tabText } = require('./selectors');
const { parseCommand } = require('./concept');

const CACHE = path.join(__dirname, '.embed-cache.json');
const crypto = require('crypto');
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

async function getEmbedder(cache) {
  let extractor = null;
  return async function embed(text) {
    const key = sha(text);
    if (cache[key]) return Float32Array.from(cache[key]);
    if (!extractor) {
      const { pipeline, env } = require('@xenova/transformers');
      env.cacheDir = path.join(__dirname, '.model-cache');
      extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    cache[key] = vec;
    return Float32Array.from(vec);
  };
}

function scoreArm(results, cmds) {
  let exact = 0, pSum = 0, rSum = 0, f1Sum = 0, viol = 0, ties = 0, msSum = 0, halluc = 0;
  const failures = [];
  results.forEach((res, i) => {
    const c = cmds[i];
    const exp = new Set(c.expectedTabIds || []);
    const got = new Set(res.selected);
    const tp = [...got].filter(id => exp.has(id)).length;
    const precision = got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    const recall = exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
    const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
    const isExact = got.size === exp.size && [...exp].every(id => got.has(id));
    const v = (c.mustNotSelect || []).filter(id => got.has(id)).length;
    if (isExact) exact++;
    pSum += precision; rSum += recall; f1Sum += f1; viol += v;
    ties += (res.meta && res.meta.ties) || 0;
    msSum += (res.meta && res.meta.ms) || 0;
    halluc += (res.meta && res.meta.hallucinated) || 0;
    if (!isExact || v) {
      failures.push({ cmd: c.command, exp: [...exp].sort((a, b) => a - b), got: [...got].sort((a, b) => a - b), v });
    }
  });
  const n = cmds.length;
  return { exact, n, precision: pSum / n, recall: rSum / n, f1: f1Sum / n, violations: viol, ties: ties / n, ms: msSum / n, halluc, failures };
}

function row(name, s) {
  const p = (x) => (100 * x).toFixed(0).padStart(3) + '%';
  return `${name.padEnd(26)} ${String(s.exact + '/' + s.n).padStart(6)}  ${p(s.precision)}  ${p(s.recall)}  ${p(s.f1)}  ${String(s.violations).padStart(4)}  ${s.ms ? (s.ms / 1000).toFixed(1) + 's' : '  —'}`;
}

(async () => {
  const recs = fs.readFileSync(path.join(__dirname, 'commands.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
  const pool = recs.find(r => r._tabPool)._tabPool;
  const cmds = recs.filter(r => r.command);

  const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
  const embed = await getEmbedder(cache);
  const tabVecs = [];
  for (const t of pool) tabVecs.push(await embed(tabText(t)));

  // Per-command context shared by all arms.
  const ctxs = [];
  for (const c of cmds) {
    const parsed = parseCommand(c.command);
    ctxs.push({
      qVec: await embed(c.command),
      tabVecs,
      concept: parsed.concept || c.command,
      isSelectAll: parsed.isSelectAll,
      parsed
    });
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const arms = [];

  // --- V1: current shipping math
  arms.push({ name: 'V1 math (shipping)', fn: async (c, i) => selectV1(c.command, pool, ctxs[i]) });

  // --- NLI zero-shot
  const { pipeline, env } = require('@xenova/transformers');
  env.cacheDir = path.join(__dirname, '.model-cache');
  const t0 = Date.now();
  const zs = await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-xsmall');
  const nliLoad = ((Date.now() - t0) / 1000).toFixed(1);
  const nli = makeNliSelector(zs);
  arms.push({ name: 'NLI zero-shot (22M)', fn: async (c, i) => nli(c.command, pool, ctxs[i]) });

  if (process.argv.includes('--ollama')) {
    const coder = makeOllamaSelector('qwen2.5-coder:3b');
    arms.push({ name: 'Ollama qwen2.5-coder:3b', fn: async (c, i) => coder(c.command, pool, ctxs[i]) });
    if (process.argv.includes('--ollama7b')) {
      const big = makeOllamaSelector('qwen2.5:latest');
      arms.push({ name: 'Ollama qwen2.5 7.6B', fn: async (c, i) => big(c.command, pool, ctxs[i]) });
    }
  }

  console.log(`\nARENA — ${cmds.length} commands, ${pool.length}-tab pool  (NLI model loaded in ${nliLoad}s)`);
  console.log('='.repeat(74));

  const scored = [];
  for (const arm of arms) {
    process.stdout.write(`running ${arm.name} ... `);
    const t = Date.now();
    const results = [];
    for (let i = 0; i < cmds.length; i++) results.push(await arm.fn(cmds[i], i));
    const s = scoreArm(results, cmds);
    scored.push({ arm, s });
    console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  console.log('\n' + 'arm'.padEnd(26) + ' ' + 'exact'.padStart(6) + '   prec  recall     F1  viol   lat/cmd');
  console.log('-'.repeat(74));
  for (const { arm, s } of scored) console.log(row(arm.name, s));
  console.log('='.repeat(74));

  for (const { arm, s } of scored) {
    if (s.halluc) console.log(`note: ${arm.name} emitted ${s.halluc} hallucinated tabId(s)`);
    if (s.ties > 1.2) console.log(`note: ${arm.name} averaged ${s.ties.toFixed(1)} tabs tied at top score (ranking saturated)`);
  }

  const best = scored[scored.length - 1];
  console.log(`\nfailures — ${best.arm.name}:`);
  for (const f of best.s.failures.slice(0, 10)) {
    console.log(`  "${f.cmd}"\n     want [${f.exp}]  got [${f.got}]${f.v ? '  ** FORBIDDEN **' : ''}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
