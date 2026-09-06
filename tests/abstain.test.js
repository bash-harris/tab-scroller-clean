// tests/abstain.test.js
// GA-1 (abstain over-fire): pool-aware answerability at the selection layer.
//
//   1. Signal census: per-dimension availability over the candidate pool.
//   2. Requires cue emission: llm-query.js names pool-dimension claims
//      (visitCount/opener/mainText/scroll/price/userTag/bookmarks/timestamps).
//   3. Abstain rule: a command whose required dimension has ZERO pool signal
//      must not be answered by the semantic fallback -- empty abstain result.
//      A pool that HAS the dimension anywhere scores as before (non-regression).
//
//   node tests/abstain.test.js

'use strict';
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok:', name); }
  else { fail++; console.log('  FAIL:', name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); }

// ---- candidate factories ---------------------------------------------------

// Production-shaped card: title/url/category/tags only (a text-less pool).
function plainCard(id, title, url, cat, tags) {
  return {
    tabId: id, title, url, domain: 'example.com',
    lastAccessed: null, openedAt: null, pinned: false, muted: false, audible: false,
    duplicateOf: null,
    enrichment: { category: cat, tags: (tags || []).map(t => ({ tag: t, score: 0.9 })) }
  };
}

// ---- 1. SIGNAL CENSUS ------------------------------------------------------

console.log('\n--- 1. signal census ---');

{
  const census = NliSelect.signalCensus([
    plainCard(1, 'Cricket scores', 'https://cricbuzz.com', 'sports', ['cricket'])
  ]);
  for (const k of ['timestamps', 'visitCount', 'opener', 'mainText', 'scroll',
    'price', 'userTag', 'bookmarks', 'groups']) {
    eq(census[k], false, `textless single card: ${k} absent`);
  }
}

{
  const census = NliSelect.signalCensus([
    plainCard(1, 'A', 'https://a.com', 'x', []),
    { ...plainCard(2, 'B', 'https://b.com', 'x', []), openedAt: 1700000000000, lastAccessed: 1700000001000 }
  ]);
  eq(census.timestamps, true, 'epoch timestamps detected');
  eq(census.visitCount, false, 'visitCount still absent');

  const c2 = NliSelect.signalCensus([
    plainCard(1, 'A', 'https://a.com', 'x', []),
    { ...plainCard(2, 'B', 'https://b.com', 'x', []), lastAccessed: '2026-01-01T00:00:00Z' }
  ]);
  eq(c2.timestamps, true, 'ISO timestamps detected');

  const c3 = NliSelect.signalCensus([
    { ...plainCard(1, 'A', 'https://a.com', 'x', []), visitCount: 0 }
  ]);
  eq(c3.visitCount, true, 'visitCount 0 counts as signal (finite)');

  const c4 = NliSelect.signalCensus([
    { ...plainCard(1, 'A', 'https://a.com', 'x', []), mainText: '   ' },
    { ...plainCard(2, 'B', 'https://b.com', 'x', []), mainText: '' }
  ]);
  eq(c4.mainText, false, 'whitespace-only mainText is zero signal');

  const c5 = NliSelect.signalCensus([
    { ...plainCard(1, 'A', 'https://a.com', 'x', []), userTag: null },
    { ...plainCard(2, 'B', 'https://b.com', 'x', []), userTag: 'temp' }
  ]);
  eq(c5.userTag, true, 'userTag detected');

  const c6 = NliSelect.signalCensus([
    { ...plainCard(1, 'A', 'https://a.com', 'x', []), bookmarked: false },
    { ...plainCard(2, 'B', 'https://b.com', 'x', []), bookmarkFolder: 'research' }
  ]);
  eq(c6.bookmarks, true, 'bookmarkFolder counts as bookmark signal');

  const c7 = NliSelect.signalCensus([
    { ...plainCard(1, 'A', 'https://a.com', 'x', []), bookmarked: true }
  ]);
  eq(c7.bookmarks, true, 'bookmarked=true counts as signal');
}

// ---- 2. REQUIRES CUE EMISSION ---------------------------------------------

console.log('\n--- 2. requires cues ---');

{
  const cases = [
    // [command, expected dims (order-insensitive)]
    ['close tabs i have visited only once', ['visitCount']],
    ['pin my most frequently visited tabs', ['visitCount']],
    ['group tabs opened from google search results', ['opener']],
    ['close tabs automatically opened by websites', ['opener']],
    ['close tabs opened in the last hour', ['timestamps']],
    ['group tabs opened this week', ['timestamps']],
    ['close the oldest tabs', ['timestamps']],
    ['close the ten most recently used tabs', ['timestamps']],
    ['close articles i have finished reading', ['scroll']],
    ['group unread articles into a reading list', ['scroll']],
    ['close open tabs that are already bookmarked', ['bookmarks']],
    ['group tabs bookmarked under research', ['bookmarks']],
    ['group products priced in inr', ['price']],
    ['close product tabs under 5000 rupees', ['price']],
    ['close tabs tagged temp', ['userTag']],
    ['bookmark all tabs tagged onboarding', ['userTag']],
    ['close pages containing code blocks', ['mainText']],
    ['close pages mentioning refresh tokens', ['mainText']],
    ['close pages containing an email address', ['mainText']],
    ['group tabs similar to my rag gemini chat', ['mainText']],
    ['group documentation pages', ['mainText']],
    // Title/url-scoped "contains" clauses bind identity fields with real
    // signal -- never a mainText claim.
    ['close tabs whose url contains utm_source', []],
    ['group tabs whose title contains oauth', []],
    ['close tabs containing 404 or page not found in the title', []],
    // No dimension claim in these shapes.
    ['close my cricket tabs', []],
    ['group tabs in window 2', []],
    ['close duplicate tabs', []],
    ['close everything except my shopping tabs', []]
  ];
  for (const [cmd, want] of cases) {
    const dims = LlmQuery.requiresFromCommand(cmd).map(r => r.dim).sort();
    eq(dims, want.slice().sort(), `cue: "${cmd}"`);
  }
}

{
  // Closed-enum validation: unknown dims and bad claims die alone.
  eq(LlmQuery.validateRequires([{ dim: 'opener', claim: 'rank' }, { dim: 'nonsense' }, 'x']),
    [{ dim: 'opener', claim: 'rank' }], 'validateRequires drops unknown dim + non-object');
  eq(LlmQuery.validateRequires([{ dim: 'price', claim: 'bogus' }]),
    [{ dim: 'price', claim: 'filter' }], 'validateRequires coerces bad claim to filter');
  eq(LlmQuery.validateRequires(null), [], 'validateRequires(null) = []');
}

{
  // reconcile() attaches requires[] to a parse (cue fill for absent key).
  const parsed = LlmQuery.reconcile('close tabs i have visited only once',
    { intent: 'close_tabs', concepts: ['visited'], combine: 'union', expansions: {},
      domains: [], confidence: 0.9, source: 'llm' });
  ok(Array.isArray(parsed.requires) && parsed.requires.some(r => r.dim === 'visitCount'),
    'reconcile attaches requires[] to a parse lacking it');
  // Model/cue value never overwritten.
  const parsed2 = LlmQuery.reconcile('close tabs i have visited only once',
    { intent: 'close_tabs', concepts: [], combine: 'union', expansions: {},
      domains: [], confidence: 0.9, source: 'llm', requires: [{ dim: 'opener', claim: 'filter' }] });
  eq(parsed2.requires, [{ dim: 'opener', claim: 'filter' }],
    'reconcile keeps an existing requires[] intact');
}

// ---- 3. ABSTAIN RULE -------------------------------------------------------

console.log('\n--- 3. abstain rule (zero signal + semantic fallback) ---');

// Deterministic parser path (no query object): select() falls back to its own
// cue extraction, which now includes the requires[] self-check.
async function runSelect(cmd, candidates, opts) {
  return NliSelect.select(cmd, candidates, opts || {});
}

(async () => {
  // 3a. visitCount claim on a text-less pool -> unanswerable_no_signal.
  {
    const pool = [
      plainCard(1, 'Cricket scores live', 'https://cricbuzz.com/cricket', 'sports', ['cricket']),
      plainCard(2, 'News today', 'https://news.com', 'news', ['news'])
    ];
    const res = await runSelect('close tabs i have visited only once', pool);
    eq(res.mode, 'unanswerable_no_signal', 'visitCount claim, zero signal -> unanswerable_no_signal');
    eq(res.matches, [], 'unanswerable abstain returns empty matches');
    eq(res.unanswerableDims, ['visitCount'], 'unanswerableDims names the dead dimension');
  }

  // 3b. opener claim on a pool without opener data.
  {
    const pool = [
      plainCard(1, 'Google search results', 'https://google.com/search?q=x', 'search', []),
      plainCard(2, 'Docs page', 'https://docs.example.com/intro', 'docs', [])
    ];
    const res = await runSelect('group tabs opened from google search results', pool);
    eq(res.mode, 'unanswerable_no_signal', 'opener claim, zero signal -> unanswerable_no_signal');
  }

  // 3c. mainText claim ("containing") on a title-only pool.
  {
    const pool = [
      plainCard(1, 'Email tips', 'https://a.com/email', 'productivity', []),
      plainCard(2, 'Code blocks guide', 'https://b.com/code', 'dev', [])
    ];
    const res = await runSelect('close pages containing an email address', pool);
    eq(res.mode, 'unanswerable_no_signal', 'mainText claim, zero signal -> unanswerable_no_signal');
  }

  // 3d. price claim on a pool with no price fields.
  {
    const pool = [
      plainCard(1, 'Product listing', 'https://shop.com/item', 'shopping', []),
      plainCard(2, 'Reviews', 'https://shop.com/reviews', 'shopping', [])
    ];
    const res = await runSelect('group products priced in inr', pool);
    eq(res.mode, 'unanswerable_no_signal', 'price claim, zero signal -> unanswerable_no_signal');
  }

  // 3e. NON-REGRESSION: pool HAS the dimension -> normal scoring, never vetoed.
  {
    const pool = [
      plainCard(1, 'Cricket scores live', 'https://cricbuzz.com', 'sports', ['cricket']),
      plainCard(2, 'News today', 'https://news.com', 'news', ['news']),
      { ...plainCard(3, 'Old cricinfo post', 'https://cricinfo.com/old', 'sports', ['cricket']),
        openedAt: 1000000000000, lastAccessed: 1000000005000 }
    ];
    const res = await runSelect('close tabs opened in the last hour', pool);
    ok(res.mode !== 'unanswerable_no_signal',
      `timestamps exist -> no veto (mode=${res.mode})`);
  }
  {
    const pool = [
      plainCard(1, 'Email tips', 'https://a.com/email', 'productivity', []),
      { ...plainCard(2, 'Thread archive', 'https://b.com/thread', 'dev', []), mainText: 'someone@example.com wrote here' }
    ];
    const res = await runSelect('close pages containing an email address', pool);
    ok(res.mode !== 'unanswerable_no_signal',
      `mainText exists (1 of 2) -> no veto (mode=${res.mode})`);
  }

  // 3f. Structural-gate results are NEVER vetoed even with zero signal:
  // the literal title gate answers before scoring; host/category gates too.
  // (The title-literal gate needs a distinctive token -- one hit out of 4
  // cards = 25% share -- so the pool is sized to keep the gate armed.)
  {
    const pool = [
      plainCard(1, 'OAuth setup guide', 'https://a.com/oauth', 'dev', []),
      plainCard(2, 'News', 'https://news.com', 'news', []),
      plainCard(3, 'Weather', 'https://weather.com', 'weather', []),
      plainCard(4, 'Docs home', 'https://docs.example.com', 'docs', [])
    ];
    const res = await runSelect('group tabs whose title contains oauth', pool);
    ok(res.mode === 'Title contains: oauth' && res.matches.length === 1,
      `title-literal gate unaffected (mode=${res.mode})`);
  }
  {
    const pool = [
      plainCard(1, 'Docs', 'https://docs.example.com', 'docs', []),
      plainCard(2, 'News', 'https://news.com', 'news', [])
    ];
    const res = await runSelect('close docs.example.com tabs', pool);
    ok(res.mode !== 'unanswerable_no_signal' && res.matches.length === 1,
      `host literal gate unaffected (mode=${res.mode})`);
  }

  // 3g. Empty-pool edge: census of nothing is zero signal everywhere; a
  // claim command abstains instead of scoring, a plain command abstains as before.
  {
    const res = await runSelect('close tabs i have visited only once', []);
    eq(res.mode, 'unanswerable_no_signal', 'empty pool + claim -> unanswerable_no_signal');
  }

  // 3h. Explicit query object path: requires[] rides the parse (LLM ceiling
  // parity with the deterministic floor).
  {
    const pool = [plainCard(1, 'A', 'https://a.com', 'x', [])];
    const res = await runSelect('group tabs bookmarked under research', pool, {
      query: { intent: 'group_tabs', concepts: ['research'], combine: 'union',
        expansions: {}, domains: [], confidence: 0.9, source: 'llm',
        requires: [{ dim: 'bookmarks', claim: 'filter' }] }
    });
    eq(res.mode, 'unanswerable_no_signal', 'explicit requires[] on query honored');
  }

  // 3i. Timestamps via ISO string in a production-shaped card.
  {
    const pool = [
      { ...plainCard(1, 'Today news', 'https://news.com', 'news', []),
        openedAt: '2026-09-06T08:00:00Z', lastAccessed: '2026-09-06T08:05:00Z' },
      plainCard(2, 'Old cricinfo post', 'https://cricinfo.com/old', 'sports', ['cricket'])
    ];
    const res = await runSelect('close tabs opened in the last hour', pool);
    ok(res.mode !== 'unanswerable_no_signal',
      `ISO timestamps count as signal -> no veto (mode=${res.mode})`);
  }

  console.log(`\n==========================================`);
  console.log(`ABSTAIN SUITE: ${pass} pass, ${fail} fail`);
  console.log(`==========================================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
