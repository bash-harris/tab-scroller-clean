// bench/golden-bench.js
// Scores a selection scorer against bench/golden-set.jsonl:
// 128 labeled commands over a frozen 52-tab pool with states, timestamps,
// windows, duplicates, homographs, injection traps and internal pages.
//
// Metrics
//   set-exact            selected == expectedTabIds, OR == any acceptableSuperset
//                        alternative (the superset then becomes the reference
//                        for precision/recall on that case)
//   precision / recall   micro-averaged per case against the effective reference
//   violations           selected ∩ mustNotSelect; PLUS global rules: chrome://
//                        internal tabs (47,48) must never be selected, and a
//                        clarify case with any selection is a violation
//   abstain-correct      empty-expected cases answered with an empty selection
//   ambiguous-compliance expectAmbiguous cases where the scorer returned
//                        needsPreview:true (or abstained) instead of silently
//                        executing one reading
//   false-close          wrong tabs carried by close_tabs selections
//   top-score ties       saturation proxy, ties within 1e-9 of the top score
//
// group_multi cases are graded by the UNION of their named buckets (a rest:true
// bucket expands to the selectable complement). Cases with only
// expectedBucketCount cannot derive ids and are reported as count-only.
//
//   node bench/golden-bench.js            current V2 scorer from command-bench.js
//   node bench/golden-bench.js --v1       reference scorer for contrast

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { selectV1, selectV2, tabText } = require('./command-bench.js');

const DATA_FILE = path.join(__dirname, 'golden-set.jsonl');
const CACHE = path.join(__dirname, '.embed-cache.json');
const INTERNAL_IDS = new Set([47, 48]);

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }

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

// Expand a case to its effective reference set. Superset alternatives that
// match the selection take over as the reference so they earn full credit.
function effectiveReference(c, got) {
  const primary = (c.expectedTabIds || []).slice().sort((a, b) => a - b);
  const sameAs = (arr, ref) => arr.length === ref.length && ref.every(id => arr.includes(id));
  if (sameAs(got, primary)) return primary;
  for (const alt of c.acceptableSuperset || []) {
    if (sameAs(got, alt.slice().sort((a, b) => a - b))) return alt;
  }
  return primary;
}

// Union of named buckets; rest buckets expand to the selectable complement.
function bucketUnion(c, selectableIds) {
  if (!c.expectedBuckets) return null;
  const named = new Set();
  for (const b of c.expectedBuckets) if (!b.rest) for (const id of b.tabIds || []) named.add(id);
  const out = new Set(named);
  for (const b of c.expectedBuckets) {
    if (!b.rest) continue;
    for (const id of selectableIds) if (!named.has(id)) out.add(id);
  }
  return [...out];
}

function evaluateGolden(name, selectFn, pool, cases, qVecs, vecs) {
  const selectableIds = pool.map(t => t.id).filter(id => !INTERNAL_IDS.has(id));
  let exact = 0, precSum = 0, recSum = 0, n = 0;
  let violations = 0, satSum = 0;
  let abstainCases = 0, abstainCorrect = 0;
  let ambigCases = 0, ambigCompliant = 0;
  let closeWrong = 0, closeSelected = 0;
  const failures = [];

  for (const c of cases) {
    // Count-only multi-group plans have no derivable ids: report, don't grade.
    if (c.expectedIntent === 'group_multi' && !c.expectedBuckets) continue;

    const r = selectFn(c.command, pool, qVecs[c.command], vecs) || {};
    const got = (r.selected || []).map(Number);
    const gotSet = new Set(got);

    let expArr;
    if (c.expectedIntent === 'group_multi') expArr = bucketUnion(c, selectableIds) || [];
    else expArr = effectiveReference(c, got);
    const exp = new Set(expArr);

    const tp = [...gotSet].filter(id => exp.has(id)).length;
    const precision = gotSet.size ? tp / gotSet.size : (exp.size === 0 ? 1 : 0);
    const recall = exp.size ? tp / exp.size : (gotSet.size === 0 ? 1 : 0);
    const isExact = gotSet.size === exp.size && expArr.every(id => gotSet.has(id));

    let viol = (c.mustNotSelect || []).filter(id => gotSet.has(id)).length;
    for (const id of gotSet) if (INTERNAL_IDS.has(id)) viol++;           // chrome:// pages
    if (c.expectedIntent === 'clarify' && gotSet.size > 0) viol++;        // asking back is the answer

    if ((c.expectedTabIds || []).length === 0 && c.expectedIntent !== 'group_multi') {
      abstainCases++;
      if (gotSet.size === 0) abstainCorrect++;
    }
    if (c.expectAmbiguous) {
      ambigCases++;
      if (r.needsPreview === true || gotSet.size === 0) ambigCompliant++;
    }
    if (c.expectedIntent === 'close_tabs' && exp.size > 0) {
      closeSelected += gotSet.size; closeWrong += (gotSet.size - tp);
    }

    const scored = r.scored || [];
    const topScore = scored.length ? scored[0].score : 0;
    const tied = scored.filter(s => Math.abs((s.score || 0) - topScore) < 1e-9).length;

    if (isExact) exact++;
    precSum += precision; recSum += recall; violations += viol; satSum += tied; n++;

    if (!isExact || viol > 0) {
      failures.push({
        id: c.id,
        bucket: c.bucket,
        command: c.command,
        expected: expArr.slice().sort((a, b) => a - b),
        got: [...gotSet].sort((a, b) => a - b),
        viol,
        ambig: !!c.expectAmbiguous,
        preview: r.needsPreview === true,
      });
    }
  }

  return {
    name, exact, n,
    precision: precSum / n,
    recall: recSum / n,
    violations,
    saturation: satSum / n,
    abstainCases, abstainCorrect,
    ambigCases, ambigCompliant,
    closeWrong, closeSelected,
    failures
  };
}

function gates(r) {
  return [
    ['set-exact >= 75%', r.exact / r.n >= 0.75],
    ['precision >= 95%', r.precision >= 0.95],
    ['recall >= 85%', r.recall >= 0.85],
    ['violations = 0', r.violations === 0],
    ['ambiguous-compliance = 100%', r.ambigCases === 0 || r.ambigCompliant === r.ambigCases],
  ];
}

function report(r) {
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`\n${r.name}`);
  console.log('-'.repeat(64));
  console.log(`  set-exact             ${r.exact}/${r.n} (${pct(r.exact / r.n)})`);
  console.log(`  precision             ${pct(r.precision)}`);
  console.log(`  recall                ${pct(r.recall)}`);
  console.log(`  violations            ${r.violations}`);
  console.log(`  abstain-correct       ${r.abstainCorrect}/${r.abstainCases}`);
  console.log(`  ambiguous-compliance  ${r.ambigCompliant}/${r.ambigCases}`);
  console.log(`  false-close           ${r.closeWrong}/${r.closeSelected} wrong-on-close`);
  console.log(`  top-score ties        ${r.saturation.toFixed(2)} avg`);
  const g = gates(r);
  for (const [label, ok] of g) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`  GATES: ${g.every(x => x[1]) ? 'ALL GREEN' : 'NOT MET'}`);
}

(async () => {
  const recs = fs.readFileSync(DATA_FILE, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
  const pool = recs.find(r => r._tabPool)._tabPool;
  const all = recs.filter(r => r.command);
  const gradable = all.filter(c => !(c.expectedIntent === 'group_multi' && !c.expectedBuckets));
  const countOnly = all.length - gradable.length;

  const cache = loadCache();
  const embed = await getEmbedder(cache);

  const vecs = [];
  for (const t of pool) vecs.push(await embed(tabText(t)));
  const qVecs = {};
  for (const c of gradable) qVecs[c.command] = await embed(c.command);
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  console.log(`\nGOLDEN BENCH  --  ${gradable.length} commands over a ${pool.length}-tab pool${countOnly ? ` (${countOnly} count-only multi-group skipped)` : ''}`);

  const results = [];
  if (process.argv.includes('--v1')) results.push(evaluateGolden('V1  (reference)', selectV1, pool, gradable, qVecs, vecs));
  results.push(evaluateGolden('V2  (golden)', selectV2, pool, gradable, qVecs, vecs));

  results.forEach(report);

  const last = results[results.length - 1];
  console.log(`\n  failures for ${last.name}:`);
  for (const f of last.failures.slice(0, 20)) {
    console.log(`   [${f.id}/${f.bucket}] "${f.command}"${f.ambig && !f.preview ? '  ** NO PREVIEW **' : ''}`);
    console.log(`      expected [${f.expected}]  got [${f.got}]${f.viol ? `  ** ${f.viol} VIOLATION(S) **` : ''}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
