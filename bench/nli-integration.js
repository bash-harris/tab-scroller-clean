// bench/nli-integration.js
// Runs the REAL nli-select.js against the gold command set, through the same
// entry point command-agent.js calls. bench/arena.js scored a bench-local
// reimplementation of NLI selection; this scores the module that ships.
//
//   node bench/nli-integration.js

const fs = require('fs');
const path = require('path');

// nli-select.js resolves transformers at call time and reads self.ConceptCore.
global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));

// Point transformers at the bench's warm model cache so this does not re-download
// the 70MB model on every run.
const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

// Gold set defaults to commands.jsonl; pass a path to score a different one.
//   node bench/nli-integration.js bench/commands-v2.jsonl
const CMD_FILE = process.argv[2] || path.join(__dirname, 'commands.jsonl');
const recs = fs.readFileSync(CMD_FILE, 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const CMDS = recs.filter(r => r.command);

// Shape the gold pool as tab cards, the way retrieveCandidates hands them over.
const candidates = POOL.map(t => ({
  tabId: t.id,
  title: t.title,
  url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: {
    category: t.category,
    tags: (t.tags || []).map(tag => ({ tag, score: 0.9 }))
  }
}));

(async () => {
  console.log('\nNLI INTEGRATION -- real nli-select.js');
  console.log(`${path.basename(CMD_FILE)}: ${CMDS.length} commands, ${candidates.length}-tab pool, model ${NliSelect.MODEL_ID}`);
  const t0 = Date.now();
  await NliSelect.load();
  console.log(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('='.repeat(78));

  let exact = 0, pSum = 0, rSum = 0, f1Sum = 0, viol = 0, msSum = 0;
  const modes = {};
  const failures = [];

  for (const c of CMDS) {
    const t1 = Date.now();
    const res = await NliSelect.select(c.command, candidates);
    const ms = Date.now() - t1;
    msSum += ms;
    modes[res.mode] = (modes[res.mode] || 0) + 1;

    // Confidence >= 0.5 is a match; below that runSemanticPipeline routes the
    // tab to `uncertain`, so it is not a selection.
    const got = new Set(res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId));
    const unc = res.matches.filter(m => m.confidence < 0.5).map(m => m.tabId);
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
        cmd: c.command,
        exp: [...exp].sort((a, b) => a - b),
        got: [...got].sort((a, b) => a - b),
        unc, v, mode: res.mode
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
  console.log(`  latency          ${(msSum / n).toFixed(0)}ms per command`);
  console.log(`  modes            ${JSON.stringify(modes)}`);

  if (failures.length) {
    console.log(`\n  failures (${failures.length}):`);
    for (const f of failures) {
      console.log(`   "${f.cmd}"  [${f.mode}]`);
      console.log(`      want [${f.exp}]  got [${f.got}]` +
        `${f.unc.length ? `  uncertain [${f.unc}]` : ''}${f.v ? '  ** FORBIDDEN **' : ''}`);
    }
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
