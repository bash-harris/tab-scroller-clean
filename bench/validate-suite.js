// bench/validate-suite.js
// Gate for suite-v3.commands.jsonl against suite-v3.pool.json.
// A wrong gold label is worse than a missing feature — this blocks the suite
// from being trusted until every label contradiction is fixed.
//
//   node bench/validate-suite.js [suite-v3.commands.jsonl]

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, 'suite-v3.commands.jsonl');
const poolFile = path.join(__dirname, 'suite-v3.pool.json');

const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
const tabById = new Map(pool.tabs.map(t => [t.id, t]));
const groupById = new Map(pool.groups.map(g => [g.id, g]));
const closedIds = new Set(pool.closedTabs.map(c => c.id));

const INTENTS = new Set([
  'close_tabs', 'group_tabs', 'bookmark_tabs', 'pin_tabs', 'unpin_tabs',
  'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs', 'search_and_switch', 'open_tabs'
]);

const CATEGORIES = new Set(Array.from({ length: 27 }, (_, i) => i + 1));

const errors = [];
const warnings = [];
let n = 0;

fs.readFileSync(file, 'utf8').trim().split('\n').forEach((line, i) => {
  if (!line.trim()) return;
  const ln = i + 1;
  let rec;
  try { rec = JSON.parse(line); } catch (e) { errors.push(`L${ln}: bad JSON — ${e.message}`); return; }
  if (rec._poolFile) return;
  n++;
  const tag = `L${ln} "${rec.command}"`;

  if (!rec.command) errors.push(`${tag}: no command`);
  if (!CATEGORIES.has(rec.category)) errors.push(`${tag}: category ${rec.category} out of range 1-27`);
  if (!(rec.level >= 1 && rec.level <= 5)) errors.push(`${tag}: level must be 1-5`);
  if (typeof rec.implemented !== 'boolean') errors.push(`${tag}: missing implemented flag`);
  if (!INTENTS.has(rec.expectedIntent)) errors.push(`${tag}: unknown intent "${rec.expectedIntent}"`);
  if (!Array.isArray(rec.expectedTabIds)) errors.push(`${tag}: expectedTabIds must be array`);
  if (rec.abstain && (rec.expectedTabIds || []).length) errors.push(`${tag}: abstain case must have empty gold`);

  const seen = new Set();
  for (const id of rec.expectedTabIds || []) {
    if (!tabById.has(id) && !closedIds.has(id)) errors.push(`${tag}: unknown tab ${id}`);
    if (seen.has(id)) errors.push(`${tag}: duplicate id ${id} in expectedTabIds`);
    seen.add(id);
  }
  for (const id of rec.mustNotSelect || []) {
    if (!tabById.has(id)) errors.push(`${tag}: mustNotSelect unknown tab ${id}`);
    if (seen.has(id)) errors.push(`${tag}: tab ${id} in BOTH expectedTabIds and mustNotSelect`);
  }
  if (rec.requiresConfirmation === undefined) warnings.push(`${tag}: missing requiresConfirmation`);

  // destructive-action expectations
  const DESTRUCTIVE = new Set(['close_tabs']);
  if (DESTRUCTIVE.has(rec.expectedIntent) && rec.requiresConfirmation !== true && !rec.abstain) {
    errors.push(`${tag}: close_tabs requires requiresConfirmation=true`);
  }

  // time-sanity: a command mentioning minutes/hours/days should have at least
  // one tab whose offset is within plausibility of the claim (loose check)
  const minRe = /(\d+)\s*(minute|hour|day|week)/i;
  if (minRe.test(rec.command) && !rec.abstain && !rec.featureGap) {
    // no hard assert — just surface if gold is empty for a time command
    if (!(rec.expectedTabIds || []).length) warnings.push(`${tag}: time command with empty gold — intentional?`);
  }

  // abstain cases should be marked unimplemented (nothing to compare)
  if (rec.abstain && rec.implemented) warnings.push(`${tag}: abstain case marked implemented — verify semantics`);
});

console.log(`\nvalidate-suite: ${n} commands against ${pool.tabs.length} tabs, ${pool.groups.length} groups`);
console.log(`  categories covered: ${[...new Set(recsOf(file).map(r => r.category))].sort((a, b) => a - b).join(',')}`);

function recsOf(f) {
  return fs.readFileSync(f, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return {}; } })
    .filter(r => r.command);
}

if (errors.length) {
  console.error(`\nFAIL — ${errors.length} errors:`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
if (warnings.length) {
  console.warn(`\n${warnings.length} warnings:`);
  for (const w of warnings) console.warn('  ' + w);
}
console.log('\nPASS — gold labels internally consistent.');
