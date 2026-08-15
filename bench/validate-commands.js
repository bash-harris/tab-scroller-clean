// bench/validate-commands.js
// Checks a generated commands.jsonl before it is trusted as a gold set.
//
// This exists because the original 25-case set contained a self-contradiction:
// tab 8 was cricket in one case and not-cricket in another, which silently
// penalised a correct selector by one point. Machine-generated labels have that
// failure mode at a higher rate, so the labels get checked before they are used
// to judge anything.
//
//   node bench/validate-commands.js                  validate commands.jsonl
//   node bench/validate-commands.js path/to/new.jsonl

const fs = require('fs');
const path = require('path');

const INTENTS = new Set([
  'close_tabs', 'group_tabs', 'bookmark_tabs', 'pin_tabs', 'unpin_tabs',
  'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs', 'search_and_switch'
]);

const file = process.argv[2] || path.join(__dirname, 'commands.jsonl');
const raw = fs.readFileSync(file, 'utf8').trim().split('\n');

const errors = [];
const warnings = [];
const recs = [];
let pool = null;

raw.forEach((line, i) => {
  const ln = i + 1;
  if (!line.trim()) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    errors.push(`L${ln}: unparseable JSON — ${e.message}`);
    return;
  }
  if (rec._tabPool) { pool = rec._tabPool; return; }
  if (!rec.command) { errors.push(`L${ln}: no "command" field`); return; }
  recs.push({ rec, ln });
});

if (!pool) {
  console.error('FAIL: no _tabPool record found in ' + file);
  process.exit(1);
}

const validIds = new Set(pool.map(t => t.id));
const byId = new Map(pool.map(t => [t.id, t]));

for (const { rec, ln } of recs) {
  const tag = `L${ln} "${rec.command}"`;

  if (!INTENTS.has(rec.expectedIntent)) {
    errors.push(`${tag}: unknown intent "${rec.expectedIntent}"`);
  }

  if (!Array.isArray(rec.expectedTabIds)) {
    errors.push(`${tag}: expectedTabIds must be an array (use [] for "no match")`);
  } else {
    for (const id of rec.expectedTabIds) {
      if (!validIds.has(id)) errors.push(`${tag}: expectedTabIds has unknown tab ${id}`);
    }
    if (new Set(rec.expectedTabIds).size !== rec.expectedTabIds.length) {
      errors.push(`${tag}: duplicate ids in expectedTabIds`);
    }
  }

  for (const id of rec.mustNotSelect || []) {
    if (!validIds.has(id)) errors.push(`${tag}: mustNotSelect has unknown tab ${id}`);
    if ((rec.expectedTabIds || []).includes(id)) {
      errors.push(`${tag}: tab ${id} is in BOTH expectedTabIds and mustNotSelect`);
    }
  }

  const needsConfirm = rec.expectedIntent === 'close_tabs';
  if (!!rec.requiresConfirmation !== needsConfirm) {
    errors.push(`${tag}: requiresConfirmation should be ${needsConfirm} for ${rec.expectedIntent}`);
  }
}

// --- cross-case consistency -------------------------------------------------
// The check the original gold set failed. For each topic word appearing in a
// command, collect which tabs were included and which were forbidden. A tab that
// is expected for a topic in one case and forbidden for the same topic in
// another is a contradiction in the labels, not a hard test.
//
// Two sources of false positive had to be excluded, or real contradictions get
// buried in noise:
//
// 1. Generic container nouns. "page", "story", "pages" are not topics -- every
//    command mentions one, so every pair of commands looks like it disagrees.
// 2. Compound commands. "close my cricket and YouTube tabs" legitimately
//    includes the cat video via YouTube, while "unmute the YouTube cricket
//    video" legitimately forbids it via the intersection. A single-word index
//    cannot represent union vs intersection, so commands joined by and/or are
//    skipped rather than mis-flagged.
const STOP = new Set([
  'my', 'all', 'the', 'a', 'an', 'tabs', 'tab', 'everything', 'every', 'them',
  'those', 'these', 'this', 'that', 'about', 'related', 'to', 'of', 'for', 'and',
  'or', 'just', 'please', 'now', 'any', 'some', 'open', 'close', 'group', 'pin',
  'unpin', 'mute', 'unmute', 'reload', 'refresh', 'bookmark', 'sort', 'switch',
  'find', 'go', 'dont', "don't", 'do', 'not', 'no', 'me', 'i', 'is', 'are',
  'with', 'on', 'in', 'from', 'into', 'up', 'out', 'only', 'could', 'you',
  'can', 'would', 'get', 'rid', 'make', 'put', 'take', 'keep', 'leave',
  // generic container nouns -- these name no topic
  'page', 'pages', 'story', 'stories', 'article', 'articles', 'thing', 'things',
  'stuff', 'item', 'items', 'show', 'search', 'instead', 'both', 'two', 'three',
  'every', 'each', 'it', 'they', 'one', 'ones', 'here', 'there'
]);

// A command naming two topics joined by and/or expresses a union or an
// intersection; either way its label cannot be compared per-word.
const COMPOUND = /\b(and|or)\b/i;

const topicIncl = new Map();
const topicExcl = new Map();
for (const { rec } of recs) {
  if (COMPOUND.test(rec.command)) continue;
  const words = rec.command.toLowerCase().split(/[^a-z0-9.]+/).filter(w => w.length > 3 && !STOP.has(w));
  for (const w of words) {
    if (!topicIncl.has(w)) { topicIncl.set(w, new Map()); topicExcl.set(w, new Map()); }
    for (const id of rec.expectedTabIds || []) {
      topicIncl.get(w).set(id, rec.command);
    }
    for (const id of rec.mustNotSelect || []) {
      topicExcl.get(w).set(id, rec.command);
    }
  }
}
for (const [w, incl] of topicIncl) {
  const excl = topicExcl.get(w);
  for (const [id, cmdA] of incl) {
    if (excl.has(id)) {
      const t = byId.get(id);
      warnings.push(
        `contradiction on "${w}" for tab ${id} (${t ? t.title : '?'}):\n` +
        `      included by  "${cmdA}"\n` +
        `      forbidden by "${excl.get(id)}"`
      );
    }
  }
}

// --- coverage ---------------------------------------------------------------
const empties = recs.filter(r => (r.rec.expectedTabIds || []).length === 0).length;
const intentCounts = {};
for (const { rec } of recs) intentCounts[rec.expectedIntent] = (intentCounts[rec.expectedIntent] || 0) + 1;
const dupes = new Map();
for (const { rec, ln } of recs) {
  const k = rec.command.toLowerCase().trim();
  if (dupes.has(k)) warnings.push(`duplicate command on L${ln} and L${dupes.get(k)}: "${rec.command}"`);
  else dupes.set(k, ln);
}

console.log(`\nVALIDATE  ${path.basename(file)}`);
console.log('='.repeat(66));
console.log(`cases              ${recs.length}`);
console.log(`pool               ${pool.length} tabs`);
console.log(`expect-empty       ${empties}  ${empties === 0 ? '<-- none: cannot detect an always-answer bug' : ''}`);
console.log(`intents covered    ${Object.keys(intentCounts).length}/${INTENTS.size}`);
const missing = [...INTENTS].filter(i => !intentCounts[i]);
if (missing.length) console.log(`  untested intents: ${missing.join(', ')}`);
console.log('-'.repeat(66));

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors) console.log(`  x ${e}`);
  console.log('\nFAIL — fix these before using this file as a gold set.\n');
  process.exit(1);
}
console.log(`\nOK — ${recs.length} cases, no errors.${warnings.length ? ' Review warnings above.' : ''}\n`);
