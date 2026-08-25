// tests/coverage.test.js
// Pure-function gate for the M1 span-coverage invariant (llm-query.js).
//
// The failure class this kills: a parse that silently DROPS part of the
// command ("cryptocurrency tax documents" truncated to concepts
// ["cryptocurrency"]) and hands selection a broad topic with no qualifier.
// coverage() must expose exactly which content words never reached any span
// channel -- concepts / expansions / domains / state / exclude.
//
// Pure logic, no model, no network:
//   node tests/coverage.test.js

global.self = global;

const { coverage } = require('../llm-query.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

const P = (over) => Object.assign({
  intent: 'group_tabs', concepts: [], combine: 'union', expansions: {},
  domains: [], selectAll: false, exclude: [], time: null, state: []
}, over);

// 1. Full coverage: every content token lands in concepts/expansions.
{
  const cmd = 'close my recipe pages';
  const r = coverage(cmd, P({
    intent: 'close_tabs',
    concepts: ['recipe'],
    expansions: { recipe: ['cooking', 'baking'] }
  }));
  check('full coverage ratio 1', r.ratio === 1, JSON.stringify(r));
  check('full coverage uncovered empty', r.uncovered.length === 0);
  check('content token "recipe" covered', r.covered.includes('recipe'));
  // page-noun filler ("pages") is not a content token at all
  check('page-word not demanded', !r.covered.includes('pages') && !r.uncovered.includes('pages'));
}

// 2. THE canonical drift: qualifier truncated away. Only the bare topic
//    survived; "documents" vanished from every span -> uncovered, ratio < 0.6.
{
  const cmd = 'group my cryptocurrency tax documents';
  const r = coverage(cmd, P({ concepts: ['cryptocurrency'] }));
  check('truncated parse flags missing qualifier', r.uncovered.includes('documents'), JSON.stringify(r));
  check('truncated parse keeps covered topic', r.covered.includes('cryptocurrency'));
  check('truncated parse ratio below gate', r.ratio < 0.6, `ratio=${r.ratio}`);
}

// 3. Recovered: qualifier phrase kept as ONE concept -> full coverage.
{
  const cmd = 'group my cryptocurrency tax documents';
  const r = coverage(cmd, P({ concepts: ['cryptocurrency tax documents'] }));
  check('recovered phrase covers all tokens', r.ratio === 1 && r.uncovered.length === 0, JSON.stringify(r));
}

// 4. Domain channel: bare-brand scope counts as covering the site token,
//    punctuation-insensitively, alongside the concept channel.
{
  const cmd = 'close my amazon.com cart tabs';
  const r = coverage(cmd, P({ intent: 'close_tabs', domains: ['amazon.com'], concepts: ['cart'] }));
  check('domain token covered via domains[]', r.covered.includes('amazon') && r.covered.includes('cart') && r.ratio === 1, JSON.stringify(r));
}

// 5. Exclude channel: exception survivors count as accounted-for spans.
{
  const cmd = 'mute everything except the interview recordings';
  const r = coverage(cmd, P({
    intent: 'mute_tabs', selectAll: true,
    concepts: [], exclude: ['interview']
  }));
  // "recordings" rides nothing; "interview" is covered by exclude["interview"]
  check('exclude[] covers survivor token', r.covered.includes('interview'), JSON.stringify(r));
  check('uncovered residue reported honestly', r.uncovered.includes('recordings'), JSON.stringify(r));
  check('partial ratio between 0 and 1', r.ratio > 0 && r.ratio < 1);
}

// 6. State channel: live tab properties cover their own tokens.
{
  const cmd = 'reload whichever tabs are pinned right now';
  const r = coverage(cmd, P({ intent: 'reload_tabs', state: ['pinned'] }));
  check('state word covered via state[]', r.covered.includes('pinned') && r.ratio === 1, JSON.stringify(r));
}

// 7. Typo rescue parity: the parser fixes spelling ("amzon" -> amazon.com),
//    so the command's own misspelling counts as covered by its correction.
{
  const r = coverage('cloes alll amzon tabs',
    P({ intent: 'close_tabs', domains: ['amazon.com'] }));
  check('typo token covered by corrected domain', r.covered.includes('amzon') && r.ratio === 1, JSON.stringify(r));
}

// 8. Intent verbs are never content: pin-family noise in a homograph command
//    cannot drag the ratio down when the parse carries the real spans.
{
  const cmd = 'unpin the social media pinning guide';
  const r = coverage(cmd, P({
    intent: 'unpin_tabs', concepts: ['social media'],
    expansions: { 'social media': ['social networks'] },
    exclude: ['pinning guide']
  }));
  check('verbs excluded from token set', !r.covered.includes('pinning') && !r.uncovered.includes('pinning'));
  check('homograph command fully covered', r.ratio === 1 && r.uncovered.length === 0, JSON.stringify(r));
}

// 9. Time cues are never content: "from yesterday" demands nothing.
{
  const cmd = 'bookmark recipes from yesterday';
  const r = coverage(cmd, P({ intent: 'bookmark_tabs', concepts: ['recipe'] }));
  check('time cue not demanded', !r.covered.includes('yesterday') && !r.uncovered.includes('yesterday'));
  check('stemmed plural covered (recipes->recipe)', r.covered.includes('recipes') && r.ratio === 1, JSON.stringify(r));
}

// 10. No content words at all -> trivially covered, never flags drift.
{
  const r = coverage('refresh everything now', P({ intent: 'reload_tabs', selectAll: false }));
  check('empty token set -> ratio 1', r.ratio === 1 && r.covered.length === 0 && r.uncovered.length === 0, JSON.stringify(r));
}

// 11. Null/garbage inputs stay pure (no throw, honest empties).
{
  const r1 = coverage('', null);
  const r2 = coverage(null, undefined);
  check('null parsed -> ratio 1', r1.ratio === 1 && r1.uncovered.length === 0, JSON.stringify(r1));
  check('null cmd -> ratio 1', r2.ratio === 1, JSON.stringify(r2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
