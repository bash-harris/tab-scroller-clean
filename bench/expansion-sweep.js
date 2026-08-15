// bench/expansion-sweep.js
// How much should an LLM-supplied expansion term be trusted relative to the
// concept the user actually typed?
//
// This exists because the first version trusted them equally (plain max over
// terms) and that made accuracy WORSE: the parser expanded "cricket" to
// ["test match","ipl","football"], and one bad term pulled both football tabs
// into every cricket command. Set-exact fell 82% -> 56% with 21 forbidden-tab
// violations, while recall rose to 100% -- expansions make everything match.
//
// w = 0 disables expansions entirely (pure concept, the pre-LLM baseline).
//
//   node bench/expansion-sweep.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const qcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.llm-query-cache.json'), 'utf8'));
const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const CMDS = recs.filter(r => r.command);
const candidates = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

(async () => {
  await NliSelect.load();
  console.log('\nEXPANSION WEIGHT SWEEP  (112 commands)');
  console.log('Trust placed in LLM-supplied expansion terms vs the typed concept.');
  console.log('='.repeat(62));
  console.log('    w   set-exact   prec  recall   violations');
  console.log('-'.repeat(62));

  for (const w of [0, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0]) {
    let exact = 0, pSum = 0, rSum = 0, viol = 0;
    for (const c of CMDS) {
      const q = qcache[LlmQuery.normalizeCommand(c.command)];
      const res = await NliSelect.select(c.command, candidates,
        q ? { query: q, expansionWeight: w } : { expansionWeight: w });
      const got = new Set(res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId));
      const exp = new Set(c.expectedTabIds || []);
      const tp = [...got].filter(i => exp.has(i)).length;
      pSum += got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
      rSum += exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
      if (got.size === exp.size && [...exp].every(i => got.has(i))) exact++;
      viol += (c.mustNotSelect || []).filter(i => got.has(i)).length;
    }
    const n = CMDS.length;
    console.log(`  ${w.toFixed(1)}   ${String(exact + '/' + n).padStart(7)}   ` +
      `${(100 * pSum / n).toFixed(0).padStart(3)}%   ${(100 * rSum / n).toFixed(0).padStart(3)}%   ` +
      `${String(viol).padStart(6)}${w === 0 ? '   <- expansions off' : ''}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
