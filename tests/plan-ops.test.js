// tests/plan-ops.test.js
// Pure unit tests for the deterministic command-shape operators
// (plan-ops.js). No model, no network, no candidate pool from any bench.
'use strict';
const PlanOps = require('../plan-ops.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log('--- plan-ops: rest-partition ---');

const UNIVERSE = [{ tabId: 9001 }, { tabId: 9002 }, { tabId: 9003 }];

(() => {
  const r = PlanOps.tryRestPartition(
    'make three groups: red things, blue things, and the rest', UNIVERSE);
  ok(!!r && r.matches.length === 3 &&
    r.matches.every(m => m.confidence === 1.0) &&
    r.mode === 'Multi-group partition (rest expands to complement)',
    'positive: groups-list + "the rest" -> whole universe');
})();

(() => {
  const r = PlanOps.tryRestPartition(
    'split my tabs into two buckets: reading now and everything else', UNIVERSE);
  ok(!!r && r.matches.length === 3, 'positive: split-into + "everything else"');
})();

(() => {
  const r = PlanOps.tryRestPartition(
    'split my tabs into Work, Shopping, and News', UNIVERSE);
  ok(r === null, 'negative: finite enumeration, no rest cue');
})();

(() => {
  const r = PlanOps.tryRestPartition(
    'ignore the pinned tabs and close everything else', UNIVERSE);
  ok(r === null, 'negative: rest cue without partition shape');
})();

(() => {
  const r = PlanOps.tryRestPartition('sort my tabs into buckets: red, blue', []);
  ok(r === null, 'negative: empty universe never fires');
})();

console.log('--- plan-ops: superlative ---');

const CARDS = [
  { tabId: 7001, openedAt: Date.parse('2026-01-01T00:00:00Z'), lastAccessed: Date.parse('2026-07-05T10:00:00Z') },
  { tabId: 7002, openedAt: Date.parse('2026-03-01T00:00:00Z'), lastAccessed: Date.parse('2026-08-01T10:00:00Z') },
  { tabId: 7003, openedAt: Date.parse('2026-06-01T00:00:00Z'), lastAccessed: NaN }
];
CARDS[2].lastAccessed = null; // missing-timestamp card

(() => {
  const matches = CARDS.map(c => ({ tabId: c.tabId }));
  const r = PlanOps.trySuperlative(
    'switch to the oldest stale recipe tab', matches, CARDS);
  ok(!!r && r.matches.length === 1 && r.matches[0].tabId === 7001 &&
    r.dir === 'asc' && r.basis === 'accessed' && r.matches[0].confidence === 1.0,
    'asc: oldest -> MIN lastAccessed (7001), confidence 1.0');
})();

(() => {
  const matches = CARDS.map(c => ({ tabId: c.tabId }));
  const r = PlanOps.trySuperlative('open the newest recipe page', matches, CARDS);
  ok(!!r && r.matches[0].tabId === 7002 && r.dir === 'desc' && r.basis === 'accessed',
    'desc: newest -> MAX lastAccessed (7002)');
})();

(() => {
  const matches = CARDS.map(c => ({ tabId: c.tabId }));
  const r = PlanOps.trySuperlative('close the oldest open recipe tab', matches, CARDS);
  ok(!!r && r.matches[0].tabId === 7001 && r.basis === 'opened',
    'basis: "oldest open" ranks by openedAt, not lastAccessed');
})();

(() => {
  // Only the timestamp-less card matched: it is alone, so it may be picked.
  const r1 = PlanOps.trySuperlative('open the oldest recipe tab',
    [{ tabId: 7003 }], CARDS);
  ok(!!r1 && r1.matches[0].tabId === 7003,
    'missing ts: picked when alone');
  // With a ranked sibling present, the missing-ts card is never the pick.
  const r2 = PlanOps.trySuperlative('open the oldest recipe tab',
    [{ tabId: 7003 }, { tabId: 7002 }], CARDS);
  ok(!!r2 && r2.matches[0].tabId === 7002,
    'missing ts: sorts last, loses to any timestamped sibling');
})();

(() => {
  const r = PlanOps.trySuperlative('group tabs touched in the last 20 minutes',
    CARDS.map(c => ({ tabId: c.tabId })), CARDS);
  ok(r === null, 'guard: duration window owns "last" -> no superlative');
})();

(() => {
  const r = PlanOps.trySuperlative('switch to the oldest stale recipe tab', [], CARDS);
  ok(r === null, 'zero matches -> fall through (null)');
})();

(() => {
  const r = PlanOps.trySuperlative('close the stale recipe tab',
    CARDS.map(c => ({ tabId: c.tabId })), CARDS);
  ok(r === null, 'no superlative word -> no fire');
})();

console.log('--- plan-ops: literal title tokens ---');

(() => {
  const e = PlanOps.extractLiteralToken(
    'close all tabs containing the word shutdown in their title');
  ok(!!e && e.mode === 'title_contains' && Array.isArray(e.tokens) &&
    e.tokens.length === 1 && e.tokens[0] === 'shutdown' && e.token === 'shutdown',
    'meta-noun: "containing the word X in their title" -> [x]');
})();

(() => {
  const e = PlanOps.extractLiteralToken('mute tabs with the term "GitHub"');
  ok(!!e && e.tokens.length === 1 && e.tokens[0] === 'github',
    'quotes + casing: \'with the term "GitHub"\' -> github');
})();

(() => {
  const e = PlanOps.extractLiteralToken('group pages titled The Daily Brief');
  ok(!!e && e.tokens.join('+') === 'the+daily+brief'.replace('the+', '') &&
    JSON.stringify(e.tokens) === JSON.stringify(['daily', 'brief']),
    'titled phrase: multi-token extraction, stopword dropped, AND list');
})();

(() => {
  const e = PlanOps.extractLiteralToken(
    'reload every page that has the phrase BREAKING NEWS in its title');
  ok(!!e && JSON.stringify(e.tokens) === JSON.stringify(['breaking', 'news']),
    'meta-noun: "has the phrase BREAKING NEWS in its title" -> [breaking, news], casing folded');
})();

(() => {
  const e = PlanOps.extractLiteralToken('tabs with the word js inside titles');
  ok(e === null, 'guard: token shorter than 3 chars rejected');
})();

(() => {
  const e = PlanOps.extractLiteralToken('pages titled something worth keeping');
  ok(e === null, 'guard: no action verb -> no literal mode');
})();

(() => {
  const e = PlanOps.extractLiteralToken('sort all tabs alphabetically by title');
  ok(e === null, 'negative: bare "by title" with nothing after -> no fire');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
