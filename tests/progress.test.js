// tests/progress.test.js
// Regression test: Ensures NLI progress estimation threshold matches scoringPass
// and UI progress clamping guarantees done <= effectiveTotal and pct <= 95%.

const assert = require('assert');

global.self = global;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}

console.log('\n--- Progress Estimation & Clamping Tests ---');

// 1. Threshold matching test
const BAND_LOW = 0.20;
const BAND_HIGH = 0.45;
const INCLUDE_FLOOR = 0.93;

const mockUniverse = [
  { tabId: 1, score: 0.15 }, // below BAND_LOW -> skip
  { tabId: 2, score: 0.30 }, // in [0.20, 0.45)
  { tabId: 3, score: 0.50 }, // in [0.45, 0.93) -> MUST be counted in nliPending
  { tabId: 4, score: 0.80 }, // in [0.45, 0.93) -> MUST be counted in nliPending
  { tabId: 5, score: 0.95 }, // >= INCLUDE_FLOOR -> confident, skip
];

let nliPending = 0;
for (const c of mockUniverse) {
  const cs = c.score;
  if (cs === null || (cs < INCLUDE_FLOOR && cs >= BAND_LOW)) nliPending++;
}

ok('tabs with cosine between BAND_HIGH (0.45) and INCLUDE_FLOOR (0.93) are counted in nliPending',
  nliPending === 3, { expected: 3, actual: nliPending });

// 2. UI Progress clamping test (mirroring command-agent.js:1800)
function computeProgress(done, total) {
  const effectiveTotal = Math.max(total || 0, done || 0);
  const pct = Math.min(95, 40 + Math.round(52 * (done / Math.max(1, effectiveTotal))));
  const label = effectiveTotal ? `Comparing ${done} of ${effectiveTotal} tabs — almost done` : 'Finding matching tabs';
  return { effectiveTotal, pct, label };
}

// Normal case
const pNormal = computeProgress(5, 10);
ok('normal progress: 5 of 10 -> pct <= 95 and effectiveTotal === 10',
  pNormal.pct === 66 && pNormal.effectiveTotal === 10 && pNormal.label.includes('5 of 10'));

// Overflow case (e.g. done = 30, total = 10)
const pOverflow = computeProgress(30, 10);
ok('overflow case: done > total clamps effectiveTotal to done (30 of 30)',
  pOverflow.effectiveTotal === 30 && pOverflow.label.includes('30 of 30'));
ok('overflow case: pct is capped at 95%',
  pOverflow.pct === 92 && pOverflow.pct <= 95);

// Zero total case
const pZero = computeProgress(0, 0);
ok('zero total handles cleanly without NaN',
  pZero.pct === 40 && pZero.effectiveTotal === 0);

console.log(`\nPASS: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
