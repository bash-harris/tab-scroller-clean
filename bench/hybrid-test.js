// bench/hybrid-test.js
// Guards the property the whole redesign rests on: NLI must be spent only where
// cosine is uncertain, and NO tab may be dropped without being scored.
//
// This replaces bench/budget-test.js, which asserted that a wall-clock valve
// truncated the scan. That behaviour was removed: at 1423ms/pass the valve fired
// after ~18 of 120 tabs, so real matches went missing and the same command
// returned 14 tabs, then 23, then 40+ depending on cache warmth. A limiter that
// makes results nondeterministic is worse than no limiter.
//
// The assertions here are the inverse of that one: everything gets scored, and
// the model is called only for the ambiguous middle.
//
//   node bench/hybrid-test.js

const path = require('path');
global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));

const DIM = 384;
// Three groups: clearly matching, clearly not, and deliberately ambiguous.
function vecToward(target, alignment) {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = target[i] * alignment + (i % 7) * 0.001 * (1 - alignment);
  return v;
}
const CONCEPT_VEC = new Array(DIM).fill(0).map((_, i) => Math.sin(i) * 0.05);

// alignment ~1.0 -> cosine high (free accept), ~0 -> cosine low (free reject),
// mid -> lands inside the band and must cost a forward pass.
const GROUPS = [
  { n: 20, align: 1.00, label: 'clear match' },
  { n: 60, align: 0.02, label: 'clear miss' },
  { n: 8, align: 0.35, label: 'ambiguous' }
];

let id = 0;
const candidates = [];
for (const g of GROUPS) {
  for (let i = 0; i < g.n; i++) {
    candidates.push({
      tabId: ++id,
      title: `${g.label} ${i}`,
      url: `https://example.com/${g.label.replace(' ', '-')}/${i}`,
      embedding: vecToward(CONCEPT_VEC, g.align),
      enrichment: { category: 'x', tags: [] }
    });
  }
}

let nliCalls = 0;
NliSelect.__setClassifierForTest(async () => {
  nliCalls++;
  return { scores: [0.9], labels: ['programming'] };
});
NliSelect.setEmbedder(async () => CONCEPT_VEC);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + detail}`);
  if (!cond) failures++;
};

(async () => {
  console.log('\nHYBRID SELECTION');
  console.log('='.repeat(64));
  console.log(`  ${candidates.length} tabs: 20 clear match, 60 clear miss, 8 ambiguous\n`);

  const q = { concepts: ['programming'], combine: 'union', expansions: {}, domains: [], isSelectAll: false };
  const res = await NliSelect.select('group programming tabs', candidates, { query: q });
  const s = res.stats;

  check('every tab is accounted for', s.scanned === candidates.length,
    `scanned ${s.scanned}/${candidates.length}`);
  check('cosine decides the vast majority for free', s.cosineTabs >= candidates.length * 0.8,
    `only ${s.cosineTabs} free`);
  check('NLI is called for far fewer tabs than exist', s.nliTabs < candidates.length * 0.2,
    `${s.nliTabs} tabs hit NLI`);
  check('forward passes match NLI-routed tabs', nliCalls === s.passes,
    `${nliCalls} calls vs ${s.passes} passes`);
  check('clear matches are selected', res.matches.length >= 20,
    `${res.matches.length} matches`);
  check('no time budget in stats', s.budgetHit === undefined, 'budgetHit still present');
  check('nothing reported unscored', s.unscored === undefined, 'unscored still present');

  console.log(`\n  ${s.cosineTabs} free / ${s.nliTabs} via NLI, ${s.passes} passes, ${res.matches.length} matches`);

  // No embedder: correctness must not depend on the cosine stage being available.
  NliSelect.setEmbedder(null);
  nliCalls = 0;
  const res2 = await NliSelect.select('group programming tabs', candidates, { query: q });
  check('no embedder -> every tab still scored', res2.stats.scanned === candidates.length,
    `scanned ${res2.stats.scanned}`);
  check('no embedder -> falls back to NLI for all', res2.stats.nliTabs === candidates.length,
    `${res2.stats.nliTabs} routed to NLI`);

  console.log(`\n${failures ? `HYBRID TEST FAILED (${failures})` : 'HYBRID TEST PASS'}\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
