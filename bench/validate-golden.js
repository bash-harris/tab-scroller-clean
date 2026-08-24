// bench/validate-golden.js
// Independent validator for bench/golden-set.jsonl. The generator self-checks,
// but this guards against hand edits to the JSONL afterwards. Exit 1 on any
// error; warnings do not fail the run.
//
//   node bench/validate-golden.js

'use strict';
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'golden-set.jsonl');
// External judge files may use their own id scheme and buckets; only the
// canonical golden set enforces the strict taxonomy.
const IS_DEFAULT = FILE === path.join(__dirname, 'golden-set.jsonl');
const ID_RE = IS_DEFAULT ? /^GS-\d{3}$/ : /^[A-Z]{1,6}-\d{1,4}$/;
const INTERNAL_IDS = new Set([47, 48]);
const BUCKETS = new Set([
  'domain-brand', 'all-tabs', 'topic', 'exception-negation', 'inverted-verb',
  'homograph', 'zero-match', 'ambiguous-intent', 'multi-group', 'vague-except',
  'imperfect-english', 'temporal', 'state-duplicate', 'adversarial', 'cross-window',
]);
const INTENTS = new Set([
  'close_tabs', 'group_tabs', 'group_multi', 'bookmark_tabs', 'pin_tabs',
  'unpin_tabs', 'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs',
  'retrieve_open', 'open_tabs', 'search_and_switch', 'clarify',
]);

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ---- structure -------------------------------------------------------------
const raw = fs.readFileSync(FILE, 'utf8').trim().split(/\r?\n/);
let recs;
try {
  recs = raw.map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { throw new Error(`line ${i + 1} is not valid JSON: ${e.message}`); }
  });
} catch (e) { console.error(e.message); process.exit(1); }

const metas = recs.filter(r => r._meta);
const pools = recs.filter(r => r._tabPool);
const cmds = recs.filter(r => r.command);

if (metas.length !== 1) err(`expected exactly 1 _meta line, found ${metas.length}`);
if (pools.length !== 1) err(`expected exactly 1 _tabPool line, found ${pools.length}`);
if (!metas.length || !pools.length) { console.error(errors.join('\n')); process.exit(1); }

// ---- pool ------------------------------------------------------------------
const pool = pools[0]._tabPool;
const poolIds = new Set();
for (const t of pool) {
  if (poolIds.has(t.id)) err(`pool: duplicate id ${t.id}`);
  poolIds.add(t.id);
  for (const f of ['id', 'url', 'title', 'category', 'windowId', 'lastAccessed', 'openedAt']) {
    if (!(f in t)) err(`pool tab ${t.id}: missing field "${f}"`);
  }
  if (t.windowId != null && ![1, 2].includes(t.windowId)) warn(`pool tab ${t.id}: unexpected windowId ${t.windowId}`);
  for (const f of ['lastAccessed', 'openedAt']) {
    if (t[f] && Number.isNaN(Date.parse(t[f]))) err(`pool tab ${t.id}: ${f} not ISO-parseable`);
  }
}
if (pool.some(t => t.url.startsWith('chrome')) && !INTERNAL_IDS.has(0)) {
  for (const t of pool) if (/^chrome(-extension)?:\/\//.test(t.url) && !INTERNAL_IDS.has(t.id)) {
    err(`pool tab ${t.id}: chrome URL not registered as internal`);
  }
}

// ---- commands --------------------------------------------------------------
const seenIds = new Set();
let lastNum = 0;
const selectable = [...poolIds].filter(id => !INTERNAL_IDS.has(id));

for (const c of cmds) {
  const tag = c.id || c.command;

  // id hygiene
  if (!ID_RE.test(c.id || '')) err(`${tag}: bad case id`);
  else {
    if (seenIds.has(c.id)) err(`${c.id}: duplicate case id`);
    seenIds.add(c.id);
    const num = parseInt(String(c.id).split('-')[1], 10);
    if (IS_DEFAULT && num !== lastNum + 1) err(`${c.id}: non-sequential numbering (expected GS-${String(lastNum + 1).padStart(3, '0')})`);
    lastNum = num;
  }

  // required fields
  for (const f of ['command', 'expectedIntent', 'expectedTabIds', 'mustNotSelect', 'requiresConfirmation', 'expectAmbiguous', 'bucket']) {
    if (!(f in c)) err(`${tag}: missing field "${f}"`);
  }
  if (!Array.isArray(c.expectedTabIds)) err(`${tag}: expectedTabIds not an array`);

  // enums
  if (!BUCKETS.has(c.bucket)) {
    if (IS_DEFAULT) err(`${tag}: unknown bucket "${c.bucket}"`);
    else warn(`${tag}: custom bucket "${c.bucket}"`);
  }
  if (!INTENTS.has(c.expectedIntent)) err(`${tag}: unknown intent "${c.expectedIntent}"`);

  // id membership
  for (const id of c.expectedTabIds || []) {
    if (!poolIds.has(id)) err(`${tag}: expectedTabIds id ${id} not in pool`);
    if (INTERNAL_IDS.has(id)) err(`${tag}: internal tab ${id} must never be an expected selection`);
  }
  for (const id of c.mustNotSelect || []) {
    if (!poolIds.has(id)) err(`${tag}: mustNotSelect id ${id} not in pool`);
  }
  for (const alt of c.acceptableSuperset || []) {
    if (!Array.isArray(alt)) { err(`${tag}: acceptableSuperset entry not an array`); continue; }
    for (const id of alt) {
      if (!poolIds.has(id)) err(`${tag}: superset id ${id} not in pool`);
      if ((c.mustNotSelect || []).includes(id)) err(`${tag}: superset id ${id} collides with mustNotSelect`);
    }
    const same = alt.length === (c.expectedTabIds || []).length && alt.every(id => (c.expectedTabIds || []).includes(id));
    if (same) warn(`${tag}: superset alternative equals primary set (pointless)`);
  }

  const inter = (c.expectedTabIds || []).filter(id => (c.mustNotSelect || []).includes(id));
  if (inter.length) err(`${tag}: expected∩mustNotSelect = [${inter}]`);

  // policy consistency
  if (c.expectAmbiguous && !c.requiresConfirmation) {
    err(`${tag}: expectAmbiguous=true requires requiresConfirmation=true (repo policy)`);
  }
  if (c.expectedIntent === 'clarify' && (c.expectedTabIds || []).length > 0) {
    err(`${tag}: clarify intent with non-empty selection`);
  }
  if (c.bucket === 'zero-match' && (c.expectedTabIds || []).length > 0) {
    err(`${tag}: zero-match bucket with non-empty selection`);
  }
  if (c.expectedIntent === 'close_tabs' && !c.requiresConfirmation && (c.expectedTabIds || []).length > 0
      && !['adversarial'].includes(c.bucket)) {
    warn(`${tag}: destructive close without confirmation flag — verify this is intentional`);
  }

  // group_multi shape
  if (c.expectedIntent === 'group_multi') {
    if (!c.expectedBuckets && c.expectedBucketCount == null) err(`${tag}: group_multi needs buckets or bucketCount`);
    if (c.expectedBuckets) {
      const claimed = new Set();
      let hasRest = false;
      for (const b of c.expectedBuckets) {
        if (!b.name || !Array.isArray(b.tabIds)) { err(`${tag}: malformed bucket`); continue; }
        if (b.rest) hasRest = true;
        for (const id of b.tabIds) {
          if (!poolIds.has(id)) err(`${tag}: bucket "${b.name}" id ${id} not in pool`);
          if (!b.rest && claimed.has(id)) err(`${tag}: id ${id} claimed by two buckets`);
          claimed.add(id);
        }
      }
      if (hasRest) {
        const restBuckets = c.expectedBuckets.filter(b => b.rest);
        if (restBuckets.length > 1) err(`${tag}: more than one rest-bucket`);
        for (const b of restBuckets) {
          const expectRest = selectable.filter(id => !c.expectedBuckets.some(o => o !== b && (o.tabIds || []).includes(id)));
          const got = new Set(b.tabIds);
          if (expectRest.length !== got.size || !expectRest.every(id => got.has(id))) {
            err(`${tag}: rest-bucket does not equal the complement of named buckets`);
          }
        }
      }
    }
  } else if ('expectedBuckets' in c || 'expectedBucketCount' in c) {
    err(`${tag}: bucket fields present on non-group_multi case`);
  }
}

// ---- coverage report --------------------------------------------------------
const byBucket = {};
for (const c of cmds) byBucket[c.bucket] = (byBucket[c.bucket] || 0) + 1;
const zeroMatch = cmds.filter(c => c.bucket === 'zero-match').length;
const ambiguous = cmds.filter(c => c.expectAmbiguous).length;
const destructive = cmds.filter(c => c.expectedIntent === 'close_tabs').length;

console.log(`golden-set.jsonl: ${pool.length} tabs, ${cmds.length} cases`);
console.log('\ncoverage:');
for (const [b, n] of Object.entries(byBucket).sort((a, b2) => b2[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${b}`);
console.log(`\nzero-match abstain cases : ${zeroMatch}`);
console.log(`ambiguous (must preview) : ${ambiguous}`);
console.log(`destructive close cases  : ${destructive}`);

if (warnings.length) {
  console.log(`\nwarnings (${warnings.length}):`);
  warnings.forEach(w => console.log('  ! ' + w));
}
if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s):`);
  errors.forEach(e => console.error('  x ' + e));
  process.exit(1);
}
console.log('\nOK - all checks passed');
