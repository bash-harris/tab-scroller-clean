// GOLD CRITIC: adapted schema check (validate-suite.js pattern) for real-v1
const fs = require('fs');
const pool = JSON.parse(fs.readFileSync(__dirname + '/real-v1.pool.json', 'utf8'));
const lines = fs.readFileSync(__dirname + '/real-v1.commands.jsonl', 'utf8').trim().split('\n');
const tabById = new Set(pool.tabs.map(t => t.id));
const groupById = new Map(pool.groups.map(g => [g.id, g]));
const INTENTS = new Set(['close_tabs','group_tabs','bookmark_tabs','pin_tabs','unpin_tabs','mute_tabs','unmute_tabs','reload_tabs','sort_tabs','search_and_switch','open_tabs']);
const errors = [], warnings = [];
const recs = [];
let n = 0;
lines.forEach((line, i) => {
  if (!line.trim()) return;
  const rec = JSON.parse(line);
  if (rec._poolFile) return;
  n++; recs.push(rec);
  const tag = `L${i+1} "${rec.command}"`;
  if (!rec.command) errors.push(tag + ': no command');
  if (!(rec.category >= 1 && rec.category <= 27)) errors.push(tag + ': category out of 1-27');
  if (!(rec.level >= 1 && rec.level <= 5)) errors.push(tag + ': level out of 1-5');
  if (typeof rec.implemented !== 'boolean') errors.push(tag + ': missing implemented flag');
  if (!INTENTS.has(rec.expectedIntent)) errors.push(tag + ': unknown intent ' + rec.expectedIntent);
  if (!Array.isArray(rec.expectedTabIds)) errors.push(tag + ': expectedTabIds not array');
  if (rec.abstain && (rec.expectedTabIds || []).length) errors.push(tag + ': abstain with non-empty gold');
  if (!rec.abstain && (rec.expectedTabIds || []).length === 0 && rec.expectedIntent === 'close_tabs' && !rec.requiresConfirmation) {
    // empty-gold close still destructive -> still require confirmation flag
  }
  const seen = new Set();
  for (const id of rec.expectedTabIds || []) {
    if (!tabById.has(id)) errors.push(tag + ': unknown tab id ' + id);
    if (seen.has(id)) errors.push(tag + ': duplicate id in gold ' + id);
    seen.add(id);
  }
  for (const id of rec.mustNotSelect || []) {
    if (!tabById.has(id)) errors.push(tag + ': mustNotSelect unknown ' + id);
    if (seen.has(id)) errors.push(tag + ': tab in BOTH gold and mustNotSelect: ' + id);
  }
  if (rec.requiresConfirmation === undefined) warnings.push(tag + ': missing requiresConfirmation');
  if (rec.expectedIntent === 'close_tabs' && !rec.abstain && rec.requiresConfirmation !== true)
    errors.push(tag + ': close_tabs non-abstain without requiresConfirmation=true');
});
// abstain⇔empty + coverage
const abstains = recs.filter(r => r.abstain);
console.log('commands:', n, '| abstain:', abstains.length);
for (const a of abstains) if ((a.expectedTabIds || []).length) errors.push('abstain non-empty: ' + a.command);
for (const a of abstains) if (a.requiresConfirmation === undefined) warnings.push('abstain missing conf: ' + a.command);
const cats = new Set(recs.map(r => r.category));
console.log('categories covered:', [...cats].sort((a,b)=>a-b).join(','));
const missing = []; for (let c = 1; c <= 27; c++) if (!cats.has(c)) missing.push(c);
if (missing.length) console.log('MISSING CATEGORIES:', missing.join(','));
// cross-command contradiction check among single-cluster dup commands (informational)
const byLine = recs;
if (errors.length) { console.log('\nSCHEMA FAIL — ' + errors.length + ' errors:'); errors.forEach(e => console.log('  ' + e)); }
else console.log('\nSCHEMA: no structural errors');
if (warnings.length) { console.log('\n' + warnings.length + ' warnings:'); warnings.forEach(w => console.log('  ' + w)); }
