// tests/run-phase0.js
// Runs every standalone Phase 0 suite and exits non-zero if any fails.
// The jest suites in this repo target a src/ layout that does not exist here
// (12 of them fail module resolution on a clean checkout, before any of our
// changes), so these node suites are the real gate.
//
//   npm test

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['extract-core', 'A1  page extraction (puppeteer, 6 offline fixtures)'],
  ['intent',       'A2+A3  command routing + domain sanitization'],
  ['group-name',   'A4+A4b group titles + intent->tool mapping'],
  ['db-rekey',     'A5  tabCards urlHash re-key + v3->v4 migration'],
  ['enrich-math',  'pre-existing  tag/alias math'],
  ['domain-priors','pre-existing  domain priors'],
  ['clarify',      'V2-3  interpretation clarify loop: lexicon + split test + no-loop'],
  ['agent',        'A6  bounded agent: planner validate + executor set-exact + fallback chain'],
  ['chain-e2e',    'V3  chained plans: background confirm executes steps + ONE composite undo'],
  ['progress',     'NLI progress estimation threshold + UI progress clamping']
];

let failed = [];
const started = Date.now();

for (const [name, desc] of SUITES) {
  const file = path.join(__dirname, `${name}.test.js`);
  process.stdout.write(`\n── ${name}  ${desc}\n`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(name);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n' + '='.repeat(64));
if (failed.length === 0) {
  console.log(`ALL PHASE 0 SUITES PASS  (${SUITES.length} suites, ${secs}s)`);
} else {
  console.log(`FAILED: ${failed.join(', ')}  (${failed.length}/${SUITES.length} suites, ${secs}s)`);
}
console.log('='.repeat(64) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
