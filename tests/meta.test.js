// tests/meta.test.js
// GA-3 (metadata attributes): meta slot schema + cue paraphrases + validation
// + interpreter leg predicates + abstain interaction.
//
//   1. Cue table: broad paraphrase shapes -> slots.meta entries.
//   2. Validation: closed enums, typed values, field-dies-alone.
//   3. Interpreter leg via select(): predicates, topic scoping, window scope,
//      group intent, 30% cap on large pools.
//   4. Abstain interaction: zero-signal dim -> unanswerable_no_signal;
//      requires[] arms the census on the meta's own dims.
//
//   node tests/meta.test.js

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

// Production-shaped card factory (textless pool by default).
function card(id, title, url, extra) {
  return Object.assign({
    tabId: id, title, url, domain: 'x.com',
    lastAccessed: null, openedAt: null,
    pinned: false, muted: false, audible: false, duplicateOf: null,
    windowId: 1, index: id - 1,
    enrichment: { category: 'misc', tags: [] }
  }, extra || {});
}
const metaOf = cmd => {
  const s = LlmQuery.validateSlots(LlmQuery.slotsFromCommand(cmd));
  return s.meta || null;
};

// ---- 1. CUE PARAPHRASES -----------------------------------------------------

console.log('\n--- 1. cue paraphrases ---');
{
  const cases = [
    // [command, expected meta array (order-insensitive on price+currency)]
    ['close open tabs that are already bookmarked', [{ field: 'bookmarked', op: 'is', value: true }]],
    ['close my saved tabs', [{ field: 'bookmarked', op: 'is', value: true }]],
    ['group the starred pages', [{ field: 'bookmarked', op: 'is', value: true }]],
    ['close tabs that are not bookmarked', [{ field: 'bookmarked', op: 'isNot', value: true }]],
    ['close the unsaved ones', [{ field: 'bookmarked', op: 'isNot', value: true }]],
    ['group tabs bookmarked under research', [
      { field: 'bookmarked', op: 'is', value: true },
      { field: 'bookmarkFolder', op: 'has', value: 'research' }]],
    ['group open tabs saved under the research folder', [
      { field: 'bookmarked', op: 'is', value: true },
      { field: 'bookmarkFolder', op: 'has', value: 'research' }]],
    ['group tabs tagged research', [{ field: 'userTag', op: 'is', value: 'research' }]],
    ['close tabs marked as temp', [{ field: 'userTag', op: 'is', value: 'temp' }]],
    ['group tabs labelled onboarding', [{ field: 'userTag', op: 'is', value: 'onboarding' }]],
    ['close the temporary tabs', [{ field: 'userTag', op: 'is', value: 'temp' }]],
    ['group high priority tabs', [{ field: 'priority', op: 'is', value: 'high' }]],
    ['close the urgent ones', [{ field: 'priority', op: 'is', value: 'high' }]],
    ['group low priority tabs', [{ field: 'priority', op: 'is', value: 'low' }]],
    ['close tabs due this week', [{ field: 'deadlineDays', op: 'lte', value: 7 }]],
    ['close tabs due in 3 days', [{ field: 'deadlineDays', op: 'lte', value: 3 }]],
    ['group pages priced in inr', [{ field: 'currency', op: 'is', value: 'INR' }]],
    ['group pages priced in euros', [{ field: 'currency', op: 'is', value: 'EUR' }]],
    ['close laptop tabs above 80000 rupees', [
      { field: 'price', op: 'gt', value: 80000 },
      { field: 'currency', op: 'is', value: 'INR' }]],
    ['close tabs costing more than 200 dollars', [
      { field: 'price', op: 'gt', value: 200 },
      { field: 'currency', op: 'is', value: 'USD' }]],
    ['close product tabs under 5000 rupees', [
      { field: 'price', op: 'lt', value: 5000 },
      { field: 'currency', op: 'is', value: 'INR' }]],
    ['close tabs cheaper than 300 euros', [
      { field: 'price', op: 'lt', value: 300 },
      { field: 'currency', op: 'is', value: 'EUR' }]],
    ['group in-stock laptops', [{ field: 'inStock', op: 'is', value: true }]],
    ['close the out of stock product tabs', [{ field: 'inStock', op: 'is', value: false }]],
    ['close product tabs that do not ship to india', [{ field: 'shipsToIndia', op: 'isNot', value: true }]],
    ['group products that ship to india', [{ field: 'shipsToIndia', op: 'is', value: true }]],
    ['group products with rating above 4', [{ field: 'rating', op: 'gte', value: 4 }]],
    ['close items rated under 3 stars', [{ field: 'rating', op: 'lt', value: 3 }]],
    ['group german tabs', [{ field: 'lang', op: 'is', value: 'de' }]],
    ['close pages in spanish', [{ field: 'lang', op: 'is', value: 'es' }]],
    ['close tabs visited only once', [{ field: 'visitCount', op: 'is', value: 1 }]],
    ['group tabs visited twice', [{ field: 'visitCount', op: 'is', value: 2 }]]
  ];
  const sameSet = (got, want) => {
    if (!got || got.length !== want.length) return false;
    const key = m => JSON.stringify([m.field, m.op, m.value]);
    const gs = [...got].map(key).sort(), ws = want.map(key).sort();
    return gs.every((g, i) => g === ws[i]);
  };
  for (const [cmd, want] of cases) {
    ok(sameSet(metaOf(cmd), want), `cue: "${cmd}" -> ${JSON.stringify(metaOf(cmd))}`);
  }
  // No false meta on unrelated commands. "bookmark these tabs" is the ACTION,
  // never the bookmarked-state filter; topic commands carry nothing.
  for (const cmd of ['close my cricket tabs', 'bookmark these tabs', 'save all open pages',
    'group everything', 'mute tabs playing audio', 'close youtube tabs']) {
    eq(metaOf(cmd), null, `no meta cue: "${cmd}"`);
  }
  // Action-verb immunity: "bookmark ..." must never emit bookmarked is:true.
  eq(metaOf('bookmark all open tabs'), null, 'bookmark action verb stays filter-free');
}

// ---- 2. VALIDATION ----------------------------------------------------------

console.log('\n--- 2. validation ---');
{
  // Model-emitted meta validates through validate() and validateSlots().
  eq((LlmQuery.validate({
    intent: 'group_tabs', concepts: [], combine: 'union', expansions: {},
    domains: [], selectAll: false, exclude: [], time: null, state: [],
    meta: [{ field: 'currency', op: 'is', value: 'INR' }], confidence: 0.9
  })).meta, [{ field: 'currency', op: 'is', value: 'INR' }],
  'validate() keeps a well-formed model meta');

  eq(LlmQuery.validateSlots({ meta: [{ field: 'bogus', op: 'is', value: 1 }] }).meta, undefined,
    'unknown field dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'price', op: 'within', value: 5 }] }).meta, undefined,
    'unknown op dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'price', op: 'is', value: 'cheap' }] }).meta, undefined,
    'number field with non-numeric value dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'bookmarked', op: 'is', value: 'true' }] }).meta, undefined,
    'boolean field with string value dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'currency', op: 'is', value: 'BTC' }] }).meta, undefined,
    'off-enum currency dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'lang', op: 'is', value: 'klingon' }] }).meta, undefined,
    'off-enum lang dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'priority', op: 'is', value: 'maximum' }] }).meta, undefined,
    'off-enum priority dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'userTag', op: 'is', value: '' }] }).meta, undefined,
    'empty text value dies');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'rating', op: 'gte', value: 4.2 }, { field: 'price', op: 'gt', value: 'oops' }] }).meta,
    [{ field: 'rating', op: 'gte', value: 4.2 }],
    'one bad entry dies alone, siblings survive');
  eq(LlmQuery.validateSlots({ meta: [{ field: 'price', op: 'gt', value: '80000' }] }).meta,
    [{ field: 'price', op: 'gt', value: 80000 }],
    'numeric strings coerce to numbers');
  // requires[] integration: a meta slot arms the census on its own dims and
  // suppresses cue dims that mis-map (priority -> userTag is correct here).
  const rq = LlmQuery.validateRequires(LlmQuery.requiresFromCommand('group high priority tabs'));
  eq(rq, [{ dim: 'userTag', claim: 'filter' }], 'meta dims flow into requires[]');
}

// ---- 3. INTERPRETER LEG VIA SELECT ------------------------------------------

console.log('\n--- 3. interpreter leg via select() ---');
(async () => {
  const run = (cmd, pool, opts) => NliSelect.select(cmd, pool, opts || {});

  // 3a. Bookmarked flag: positive, negative, saved paraphrase.
  {
    const pool = [
      card(1, 'A', 'https://a.com/1', { bookmarked: true }),
      card(2, 'B', 'https://b.com/2', { bookmarked: false }),
      card(3, 'C', 'https://c.com/3', { bookmarked: true })
    ];
    eq((await run('close open tabs that are already bookmarked', pool)).matches.map(m => m.tabId),
      [1, 3], 'bookmarked is:true elects flagged tabs');
    eq((await run('close my saved tabs', pool)).matches.map(m => m.tabId),
      [1, 3], '"saved" paraphrase resolves to the bookmarked flag');
    eq((await run('close tabs that are not bookmarked', pool)).matches.map(m => m.tabId),
      [2], 'bookmarked isNot:true elects unflagged tabs');
  }

  // 3a2. Tri-state bookmarked: isNot matches only MEASURED false; field-absent
  // tabs are unmeasured and must never be elected by the negative predicate
  // (close-command data destruction risk if absence read as the negative fact).
  {
    const pool = [
      card(1, 'B1', 'https://b.com/1', { bookmarked: true }),
      card(2, 'B2', 'https://b.com/2', { bookmarked: true }),
      card(3, 'U1', 'https://u.com/3', { bookmarked: false }),
      card(4, 'U2', 'https://u.com/4', { bookmarked: false }),
      card(5, 'U3', 'https://u.com/5', { bookmarked: false }),
      card(6, 'A1', 'https://a.com/6'),
      card(7, 'A2', 'https://a.com/7'),
      card(8, 'A3', 'https://a.com/8'),
      card(9, 'A4', 'https://a.com/9')
    ];
    eq((await run('close tabs that are not bookmarked', pool)).matches.map(m => m.tabId),
      [3, 4, 5], 'bookmarked isNot:true elects exactly the 3 measured-false, never the 4 absent');
    eq((await run('close open tabs that are already bookmarked', pool)).matches.map(m => m.tabId),
      [1, 2], 'bookmarked is:true elects exactly the 2 flagged tabs');
  }

  // 3b. Bookmark folder has: exact + word-hit matching.
  {
    const pool = [
      card(1, 'Notes', 'https://r.com/x', { bookmarked: true, bookmarkFolder: 'Research' }),
      card(2, 'Paper', 'https://r.com/y', { bookmarked: true, bookmarkFolder: 'Work' }),
      card(3, 'Plain', 'https://x.com/3', { bookmarked: false })
    ];
    eq((await run('group tabs bookmarked under research', pool)).matches.map(m => m.tabId),
      [1], 'folder has:research elects only the Research-folder tab');
  }

  // 3c. User tag + priority + deadline.
  {
    const pool = [
      card(1, 'Notes', 'https://r.com/x', { userTag: 'research' }),
      card(2, 'Paper', 'https://r.com/y', { userTag: 'research' }),
      card(3, 'Plain', 'https://x.com/3'),
      card(4, 'Onboarding', 'https://o.com/4', { userTag: 'onboarding' }),
      card(5, 'Jira', 'https://jira.acme.com/browse/XC-142', { priority: 'high', deadlineDays: 2 }),
      card(6, 'Prep', 'https://leetcode.com/x', { priority: 'high', deadlineDays: 5 })
    ];
    eq((await run('group tabs tagged research', pool)).matches.map(m => m.tabId),
      [1, 2], 'tagged research elects the tagged pair');
    eq((await run('bookmark all tabs tagged onboarding', pool)).matches.map(m => m.tabId),
      [4], 'tagged onboarding elects the onboarding tab');
    eq((await run('group high priority tabs', pool)).matches.map(m => m.tabId),
      [5, 6], 'high priority elects the priority:high pair');
    eq((await run('close tabs due this week', pool)).matches.map(m => m.tabId),
      [5, 6], 'due this week elects deadlineDays <= 7');
    eq((await run('close the urgent ones', pool)).matches.map(m => m.tabId),
      [5, 6], '"urgent" maps to priority high');
  }

  // 3d. Commerce predicates: currency, price threshold with currency,
  // stock, shipping, rating. Topic scoping composes ("in-stock laptops").
  {
    const pool = [
      card(1, 'ASUS ROG Gaming Laptop', 'https://amzn.com/1',
        { price: 95000, inStock: true, rating: 4.5, currency: 'INR', shipsToIndia: true }),
      card(2, 'ASUS Vivobook 15', 'https://flip.com/2',
        { price: 79999, inStock: true, rating: 4.2, currency: 'INR', shipsToIndia: true }),
      card(3, 'Sony Headphones', 'https://amzn.com/3',
        { price: 15000, inStock: false, rating: 3.8, currency: 'INR', shipsToIndia: false }),
      card(4, 'News', 'https://news.com/4')
    ];
    eq((await run('group pages priced in inr', pool)).matches.map(m => m.tabId),
      [1, 2, 3], 'priced in INR elects the INR products');
    eq((await run('close laptop tabs above 80000 rupees', pool)).matches.map(m => m.tabId),
      [1], 'price > 80000 INR + laptop scope elects only the ROG');
    eq((await run('group in-stock laptops', pool)).matches.map(m => m.tabId),
      [1, 2], 'in-stock + laptop scope elects the stock laptops');
    eq((await run('close the out of stock product tabs', pool)).matches.map(m => m.tabId),
      [3], 'out of stock elects the measured-false tab');
    eq((await run('close product tabs that do not ship to india', pool)).matches.map(m => m.tabId),
      [3], 'does not ship to india elects shipsToIndia:false');
    eq((await run('group products that ship to india', pool)).matches.map(m => m.tabId),
      [1, 2], 'ships to india elects shipsToIndia:true');
    eq((await run('group products with rating above 4', pool)).matches.map(m => m.tabId),
      [1, 2], 'rating >= 4 elects the well-rated pair');
    // Boolean isNot must never elect an UNMEASURED tab.
    const r = await run('close product tabs that do not ship to india', [
      card(1, 'P', 'https://p.com/1', { shipsToIndia: false, currency: 'INR' }),
      card(2, 'No data', 'https://x.com/2', { currency: 'USD' })
    ]);
    eq(r.matches.map(m => m.tabId), [1],
      'isNot on a boolean skips unmeasured tabs (absence != negative fact)');
  }

  // 3e. Language + visit count.
  {
    const pool = [
      card(1, 'Spiegel', 'https://spiegel.de/1', { lang: 'de' }),
      card(2, 'Le Monde', 'https://lemonde.fr/2', { lang: 'fr' }),
      card(3, 'News', 'https://news.com/3'),
      card(4, 'Rare page', 'https://rare.com/4', { visitCount: 1 })
    ];
    eq((await run('group german tabs', pool)).matches.map(m => m.tabId),
      [1], 'lang is:de elects the German page');
    eq((await run('close pages in french', pool)).matches.map(m => m.tabId),
      [2], 'lang is:fr elects the French page');
    eq((await run('close tabs visited only once', pool)).matches.map(m => m.tabId),
      [4], 'visitCount is:1 elects the once-visited tab');
  }

  // 3f. Window scope composes with meta.
  {
    const pool = [
      card(1, 'A', 'https://a.com/1', { bookmarked: true, windowId: 1 }),
      card(2, 'B', 'https://b.com/2', { bookmarked: true, windowId: 2 }),
      card(3, 'C', 'https://c.com/3', { bookmarked: false, windowId: 1 })
    ];
    const q = { intent: 'close_tabs', concepts: [], combine: 'union', expansions: {},
      domains: [], selectAll: false, exclude: [], time: null, state: [],
      confidence: 0.9, source: 'llm' };
    const r = await run('close bookmarked tabs in window 2', pool, { query: q });
    eq(r.matches.map(m => m.tabId), [2], 'window scope narrows the meta set');
  }

  // 3g. 30% cap on a LARGE pool: a misparse must not swallow the browser.
  {
    const pool = [];
    for (let i = 0; i < 40; i++) pool.push(card(i + 1, 'T' + i, 'https://t.com/' + i, { bookmarked: true }));
    for (let i = 0; i < 60; i++) pool.push(card(41 + i, 'U' + i, 'https://u.com/' + i));
    const r = await run('close open tabs that are already bookmarked', pool);
    ok(!/slot meta/.test(r.mode), `40% share in a large pool yields (mode=${r.mode})`);
  }

  // 3h. Empty meta set on a signal-bearing pool yields (never an empty
  // assertion) -- the semantic path keeps the command.
  {
    const pool = [
      card(1, 'P', 'https://p.com/1', { userTag: 'alpha' }),
      card(2, 'Q', 'https://x.com/2')
    ];
    const r = await run('group tabs tagged research', pool);
    ok(r.mode !== 'slot meta' && r.matches.length === 0,
      `no matching tag -> not a meta election (mode=${r.mode})`);
  }

  // 3i. Abstain interaction: zero-signal dim refuses with the census mode.
  {
    const pool = [
      card(1, 'P', 'https://p.com/1', { price: 100, currency: 'INR' }),
      card(2, 'Q', 'https://x.com/2')
    ];
    const r = await run('group high priority tabs', pool);
    eq(r.mode, 'unanswerable_no_signal', 'priority demand on a price-only pool refuses');
    eq(r.unanswerableDims, ['userTag'], 'unanswerableDims names the dead dim');
  }

  // 3j. Structural immunity: a meta election is never semantic-vetoed even
  // though the command carries requires[]-mapped vocabulary.
  {
    const pool = [
      card(1, 'A', 'https://a.com/1', { bookmarked: true }),
      card(2, 'B', 'https://b.com/2', { bookmarked: false })
    ];
    const q = { intent: 'close_tabs', concepts: [], combine: 'union', expansions: {},
      domains: [], selectAll: false, exclude: [], time: null, state: [],
      confidence: 0.9, source: 'llm',
      requires: [{ dim: 'bookmarks', claim: 'filter' }] };
    const r = await run('close open tabs that are already bookmarked', pool, { query: q });
    eq(r.mode, 'slot meta bookmarkedistrue', 'meta leg answers despite requires[] claim');
    eq(r.matches.map(m => m.tabId), [1], 'and elects the right half');
  }

  // 3k. Carve-out yields: "except" clauses belong to the complement path.
  {
    const pool = [
      card(1, 'A', 'https://a.com/1', { bookmarked: true }),
      card(2, 'B', 'https://b.com/2', { bookmarked: true })
    ];
    const r = await run('close bookmarked tabs except the a.com one', pool);
    ok(!/slot meta/.test(r.mode), `carve-out yields the meta leg (mode=${r.mode})`);
  }

  console.log(`\n==========================================`);
  console.log(`META SUITE: ${pass} pass, ${fail} fail`);
  console.log(`==========================================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
