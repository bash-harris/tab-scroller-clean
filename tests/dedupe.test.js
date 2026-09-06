// tests/dedupe.test.js
// GA-2 (duplicates): canonical clustering + retention direction + paraphrases.
//
//   1. dupClustersOf tiers: exact URL, canonical URL (tracking/fragment/m.),
//      duplicateOf links, topic-anchored identical-title (path-equal).
//   2. dupKeeperSplit direction: keep-rule + link precedence.
//   3. Census end-to-end via select(): keep semantics, scope composition,
//      group intent, near-dup abstain, otherWindows.
//   4. Paraphrase cues fill slots.dedupe; requires[] immunity (GA-1 must not
//      eat dedupe commands).
//
//   node tests/dedupe.test.js

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

// ---- 1. CLUSTER TIERS -------------------------------------------------------

console.log('\n--- 1. cluster tiers ---');
{
  // Tier access: dupClustersOf/dupKeeperSplit are internal; test through the
  // exported census behavior instead (see section 3). Here: canonical URL
  // normalization helpers via select() with an explicit dedupe slot.
}

// ---- 2. PARAPHRASE CUES -----------------------------------------------------

console.log('\n--- 2. paraphrase cues ---');
{
  const cases = [
    // [command, expected dedupe slot subset]
    ['close duplicate tabs', { keep: 'first' }],
    ['close the copies of my notes', { keep: 'first' }],
    ['close tabs that are doubled up', { keep: 'first' }],
    ['close the page i opened twice', { keep: 'first' }],
    ['close repeated weather checks', { keep: 'first' }],
    ['close two of the same recipe tabs', { keep: 'first' }],
    ['close duplicate tabs and keep the oldest', { keep: 'oldest' }],
    ['close duplicate tabs keeping the first', { keep: 'first' }],
    ['close the duplicate amazon interview experience tabs keeping the first', { keep: 'first' }],
    ['close duplicate tabs keeping the newest', { keep: 'newest' }],
    ['close duplicate tabs keeping originals', { keep: 'original' }],
    ['close duplicate product pages even if their tracking parameters differ', { canonical: true, keep: 'first' }],
    ['close near-duplicate articles that cover the same story', { near: true }],
    ['group my duplicate leetcode problem tabs', { group: true, keep: 'first' }],
    ['close duplicates in other windows', { otherWindows: true }],
    ['close duplicate news tabs', { keep: 'first' }],
    ['close duplicated mdn tabs', { keep: 'first' }]
  ];
  for (const [cmd, want] of cases) {
    const d = LlmQuery.validateSlots(LlmQuery.slotsFromCommand(cmd)).dedupe || {};
    let good = true;
    for (const [k, v] of Object.entries(want)) if (d[k] !== v) good = false;
    ok(good, `cue: "${cmd}" -> ${JSON.stringify(d)}`);
  }
  // No false dedupe on unrelated commands.
  for (const cmd of ['close my cricket tabs', 'group tabs in window 2', 'close everything']) {
    const d = LlmQuery.validateSlots(LlmQuery.slotsFromCommand(cmd)).dedupe;
    eq(d, undefined, `no dedupe cue: "${cmd}"`);
  }
  // validateSlots drops unknown keep values.
  eq(LlmQuery.validateSlots({ dedupe: { keep: 'random' } }), {},
    'validateSlots drops unknown keep enum');
}

// ---- 3. CENSUS VIA SELECT ---------------------------------------------------

console.log('\n--- 3. census via select() ---');
async function run(cmd, pool, opts) {
  return NliSelect.select(cmd, pool, opts || {});
}

(async () => {
  // 3a. Bare "close duplicate tabs": exact URL tier only; keep lowest index.
  {
    const pool = [
      card(1, 'WhatsApp', 'https://web.whatsapp.com/'),
      card(2, '(2) WhatsApp', 'https://web.whatsapp.com/'),
      card(3, 'Docs', 'https://docs.example.com/intro')
    ];
    const r = await run('close duplicate tabs', pool);
    eq(r.matches.map(m => m.tabId), [2], 'bare dedupe closes the higher-index copy only');
  }

  // 3b. Retention direction: "keeping the first" closes the LATER copy.
  {
    const pool = [
      card(1, 'Article A', 'https://a.com/article', { openedAt: 2000 }),
      card(2, 'Article A', 'https://a.com/article', { openedAt: 1000 })
    ];
    const r = await run('close the duplicate article tabs keeping the first', pool);
    eq(r.matches.map(m => m.tabId), [2], 'keep the first (lower index), close the later copy');
  }

  // 3c. "keep the oldest" closes the newer duplicate (open time decides).
  {
    const pool = [
      card(1, 'Guide', 'https://g.com/x', { openedAt: 5000, index: 0 }),
      card(2, 'Guide', 'https://g.com/x', { openedAt: 1000, index: 1 })
    ];
    const r = await run('close duplicate guide tabs and keep the oldest', pool);
    eq(r.matches.map(m => m.tabId), [1], 'keep oldest-opened, close the newer copy');
  }

  // 3d. "keeping the newest" closes the older copy.
  {
    const pool = [
      card(1, 'Guide', 'https://g.com/x', { openedAt: 5000 }),
      card(2, 'Guide', 'https://g.com/x', { openedAt: 1000 })
    ];
    const r = await run('close duplicate guide tabs keeping the newest', pool);
    eq(r.matches.map(m => m.tabId), [2], 'keep newest-opened, close the older copy');
  }

  // 3e. duplicateOf link outranks the clock: flagged copy closed, original kept.
  {
    const pool = [
      card(1, 'Original', 'https://o.com/page', { openedAt: 5000, index: 0 }),
      card(2, 'Copy', 'https://o.com/page2', { openedAt: 1000, index: 1, duplicateOf: 1 })
    ];
    const r = await run('close duplicate tabs and keep the oldest', pool);
    eq(r.matches.map(m => m.tabId), [2],
      'flagged copy closed even though it opened earlier (link outranks clock)');
  }

  // 3f. Canonical tier: tolerance marker merges tracking/fragment/m. variants.
  {
    const pool = [
      card(1, 'Laptop', 'https://www.amazon.com/dp/B08N5WRWNW'),
      card(2, 'Laptop', 'https://m.amazon.com/dp/B08N5WRWNW?ref_=mobile'),
      card(3, 'Other', 'https://other.com/x')
    ];
    const rTol = await run('close duplicate product pages even if their tracking parameters differ', pool);
    eq(rTol.matches.map(m => m.tabId).sort((a, b) => a - b), [2],
      'tolerance marker: canonical variants cluster, mobile copy closed');
    // Without the marker: exact-URL tier only -> nothing to close (yield).
    const rBare = await run('close duplicate product pages', pool);
    ok(rBare.matches.length === 0, 'bare dedupe leaves tracking variants alone');
  }

  // 3g. Identity params survive canonicalization: t=... stripped on youtube,
  // v= kept. Two tabs same video id cluster under tolerance; different videos
  // never do.
  {
    const pool = [
      card(1, 'Video V', 'https://www.youtube.com/watch?v=abc123'),
      card(2, 'Video V', 'https://www.youtube.com/watch?v=abc123&t=1s'),
      card(3, 'Video W', 'https://www.youtube.com/watch?v=zzz999')
    ];
    const r = await run('close duplicate video tabs even if the timestamps differ', pool);
    eq(r.matches.map(m => m.tabId), [2], 'same video (t= variant) clusters; other video untouched');
  }

  // 3h. Scope composition: topic tokens narrow the universe before clustering.
  {
    const pool = [
      card(1, 'Election Live', 'https://news.com/election'),
      card(2, 'Election Live', 'https://news.com/election'),
      card(3, 'WhatsApp', 'https://web.whatsapp.com/'),
      card(4, '(2) WhatsApp', 'https://web.whatsapp.com/')
    ];
    const r = await run('close duplicate news tabs', pool);
    eq(r.matches.map(m => m.tabId), [2], 'news scope: only the news pair is touched');
  }

  // 3i. Topic scope reaches cross-host carriers of the topic ("amazon
  // interview experience" lives on reddit).
  {
    const pool = [
      card(1, 'Amazon SDE 1 Interview Experience', 'https://www.reddit.com/r/amazonsdeprep/comments/1l7ofuq/usa_amazon_sde_1_interview_experience/'),
      card(2, 'Amazon SDE 1 Interview Experience', 'https://www.reddit.com/r/amazonsdeprep/comments/1l7ofuq/usa_amazon_sde_1_interview_experience/'),
      card(3, 'Cookware', 'https://www.amazon.in/b?node=1'),
      card(4, 'Cookware', 'https://www.amazon.in/b?node=1')
    ];
    const q = {
      intent: 'close_tabs', concepts: ['duplicate amazon interview experience keeping first'],
      combine: 'union', expansions: {}, domains: [], selectAll: false, exclude: [],
      time: null, state: [], confidence: 0.5, isSelectAll: false, source: 'fallback',
      urlShape: { site: 'amazon' }, dedupe: { canonical: true, keep: 'first' }
    };
    const r = await run('close the duplicate amazon interview experience tabs keeping the first', pool, { query: q });
    eq(r.matches.map(m => m.tabId), [2],
      'topic-scoped census finds the reddit-hosted pair despite the amazon site guess');
  }

  // 3j. Identical-title tier: topic-anchored, path-equal, query-only drift.
  {
    const pool = [
      card(1, 'Jump Game IV - LeetCode', 'https://leetcode.com/problems/jump-game-iv/description/'),
      card(2, 'Jump Game IV - LeetCode', 'https://leetcode.com/problems/jump-game-iv/description/?envType=daily-question&envId=2026-05-18'),
      card(3, 'Meeting Rooms III - LeetCode', 'https://leetcode.com/problems/meeting-rooms-iii/description/'),
      card(4, 'Meeting Rooms III - LeetCode', 'https://leetcode.com/problems/meeting-rooms-iii/description/?envType=daily-question&envId=2025-12-27'),
      // Pool-wide title collisions that must NOT cluster:
      card(5, 'Google Gemini', 'https://gemini.google.com/app/aaaa'),
      card(6, 'Google Gemini', 'https://gemini.google.com/app/bbbb')
    ];
    const r = await run('group my duplicate leetcode problem tabs', pool);
    eq(r.matches.map(m => m.tabId).sort((a, b) => a - b), [1, 2, 3, 4],
      'title tier: query-only variants cluster; generic Gemini frames do not');
  }

  // 3k. Title tier refuses path siblings (same title, different page).
  {
    const pool = [
      card(1, 'Path Queries II - LeetCode', 'https://leetcode.com/problems/path-existence-queries-in-a-graph-ii/'),
      card(2, 'Path Queries II - LeetCode', 'https://leetcode.com/problems/path-existence-queries-in-a-graph-ii/description/')
    ];
    const r = await run('group my duplicate leetcode problem tabs', pool);
    ok(r.matches.length === 0, 'listing vs description page (same title) never clusters');
  }

  // 3l. near-duplicate demand on a textless pool abstains.
  {
    const pool = [
      card(1, 'Rate pause - Bloomberg', 'https://bloomberg.com/x'),
      card(2, 'Rate pause - CNBC', 'https://cnbc.com/y')
    ];
    const r = await run('close near-duplicate articles that cover the same story', pool);
    eq(r.matches, [], 'near-dup demand on textless pool abstains');
    ok(/abstain/i.test(r.mode), `abstain mode named (${r.mode})`);
  }

  // 3m. GA-1 immunity: dedupe commands never trip the abstain census.
  {
    const pool = [
      card(1, 'WhatsApp', 'https://web.whatsapp.com/'),
      card(2, '(2) WhatsApp', 'https://web.whatsapp.com/'),
      card(3, 'Docs', 'https://docs.example.com/intro')
    ];
    // "keep the oldest" would read as a timestamps rank claim on a
    // timestamp-less pool; the dup demand makes the command structural.
    const r = await run('close duplicate tabs and keep the oldest', pool);
    ok(r.mode !== 'unanswerable_no_signal', `dedupe immune to abstain veto (mode=${r.mode})`);
    eq(r.matches.map(m => m.tabId), [2], 'and still closes the right half (keep-rule fallback by index)');
  }

  // 3n. otherWindows: closes only copies living outside the current window.
  {
    const pool = [
      card(1, 'Election', 'https://news.com/election', { windowId: 1 }),
      card(2, 'Election', 'https://news.com/election', { windowId: 2, duplicateOf: 1 }),
      card(3, 'Rust', 'https://blog.com/rust', { windowId: 1 }),
      card(4, 'Rust', 'https://blog.com/rust', { windowId: 2, duplicateOf: 3 })
    ];
    const q = {
      intent: 'close_tabs', concepts: ['duplicates windows'],
      combine: 'union', expansions: {}, domains: [], selectAll: false, exclude: [],
      time: null, state: [], confidence: 0.5, isSelectAll: false, source: 'fallback',
      dedupe: { keep: 'first', otherWindows: true }
    };
    const r = await run('close duplicates in other windows', pool, { query: q, meta: { currentWindowId: 1 } });
    eq(r.matches.map(m => m.tabId).sort((a, b) => a - b), [2, 4],
      'window-scoped dedupe closes only the out-of-window copies');
  }

  // 3o. Group intent groups the WHOLE clusters, closes nothing.
  {
    const pool = [
      card(1, 'Jump Game IV - LeetCode', 'https://leetcode.com/problems/jump-game-iv/description/'),
      card(2, 'Jump Game IV - LeetCode', 'https://leetcode.com/problems/jump-game-iv/description/?envType=daily'),
      card(3, 'Docs', 'https://docs.example.com/intro')
    ];
    const r = await run('group my duplicate leetcode problem tabs', pool);
    eq(r.matches.map(m => m.tabId).sort((a, b) => a - b), [1, 2],
      'group intent selects both cluster members');
  }

  // 3p. 30% cap: a LARGE pool where >= 30% of tabs are duplicates yields to
  // legacy (a misparse must not swallow the browser). Tiny pools are exempt:
  // two tabs in a two-tab pool are 100% and that is the command's answer.
  {
    const pool = [];
    const mk = (id, title, url) => card(id, title, url);
    // 7 duplicate pairs -> 7 closes out of 20 tabs = 35% share >= 30% cap.
    for (let i = 0; i < 7; i++) {
      pool.push(mk(2 * i + 1, 'Same' + i, 'https://s.com/' + i));
      pool.push(mk(2 * i + 2, 'Same' + i, 'https://s.com/' + i));
    }
    for (let i = 0; i < 6; i++) pool.push(mk(15 + i, 'U' + i, 'https://u.com/' + i));
    const r = await run('close duplicate tabs', pool);
    ok(!/dedupe/.test(r.mode), '30% share in a large pool yields (cap)');
  }

  console.log(`\n==========================================`);
  console.log(`DEDUPE SUITE: ${pass} pass, ${fail} fail`);
  console.log(`==========================================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
