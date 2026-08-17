// tests/agent.test.js
// Phase 0 gate for the bounded tool-calling agent (Layers 1-2).
//
// What this proves, offline, with no chrome / no Gemini / no NLI model:
//   1. GOLDEN SET -- for all 10 showcase commands, a RECORDED Gemini DSL flows
//      through AgentPlanner.validate() and AgentExecutor set-algebra to the
//      EXACT tab-id set (or, for retrieve-and-open, the exact search payload).
//      This evaluates the *consequence* (which tabs), not just that JSON parsed.
//   2. FALLBACK CHAIN -- Gemini failure -> Ollama -> regex actually fires, and
//      an unparseable time is rejected by validate() rather than silently
//      becoming match-all.
//   3. SELF-CORRECTION -- a plan whose topic matches 0 tabs raises
//      needsCorrection, and a corrected re-plan resolves to the right set.
//
//   node tests/agent.test.js
//
// The one thing it does NOT cover is runAgentPipeline itself (command-agent.js),
// which needs the live SW environment (chrome.tabs, Embed, NliSelect); that is
// the manual E2E step in the plan. Everything deterministic is gated here.

global.self = global; // recall-tabs.js self-fallback guard; harmless in node

const { buildFilterPlan, validate, parseMultiGroupCommand } = require('../agent-planner.js');
const { executePlan, extractRetrieval } = require('../agent-executor.js');
const { isComplexCommand } = require('../agent-router.js');
const { parseTimeRange } = require('../recall-tabs.js');

const NOW = 1_000_000_000_000;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <' + extra + '>' : '')); }
}
const setEq = (got, want) => {
  const a = [...got].map(Number).sort((x, y) => x - y).join(',');
  const b = [...want].map(Number).sort((x, y) => x - y).join(',');
  return { equal: a === b, got: a, want: b };
};

// Build the injected dependencies for a per-command fixture world. Each command
// gets its own small universe so no command's whole-universe filter (e.g. #6's
// "older than 3 days", which has no topic) is polluted by another's tabs.
//   tabs:  [{ id, title, url, accessedAgo, pinned, audible, active }]
//   opened:{ id: openedAgo }   (ms-ago -> SessionMemory openedAt)
function mkDeps(tabs, opened = {}) {
  const liveTabs = tabs.map(t => ({
    id: t.id,
    title: t.title || '',
    url: t.url || `https://example.com/${t.id}`,
    pinned: !!t.pinned,
    audible: !!t.audible,
    muted: !!t.muted,
    active: !!t.active,
    lastAccessed: t.accessedAgo == null ? undefined : NOW - t.accessedAgo,
  }));
  const candidates = liveTabs.map(t => ({ tabId: t.id, title: t.title }));
  // Fake NliSelect: a tab matches a topic if its title contains ANY word of the
  // topic value. Deterministic stand-in for cosine+entailment.
  const findByTopic = async (value, cands) => {
    const words = String(value).toLowerCase().split(/\s+/).filter(Boolean);
    return (cands && cands.length ? cands : candidates)
      .filter(c => words.some(w => c.title.toLowerCase().includes(w)))
      .map(c => c.tabId);
  };
  const getOpenedAt = (id) => (opened[id] == null ? null : NOW - opened[id]);
  return { liveTabs, candidates, findByTopic, getOpenedAt, parseTimeRange, now: NOW };
}

// A recorded-Gemini adapter: ignore (system, prompt) and return the golden DSL.
const recorded = (dsl) => async () => JSON.stringify(dsl);

// ---------------------------------------------------------------------------
// GOLDEN SET: the 10 showcase commands.
// ---------------------------------------------------------------------------
const CASES = [
  {
    n: 1, cmd: 'Close all shopping tabs from yesterday except the ones with gardening equipment',
    dsl: { intent: 'close_tabs', filters: [
      { type: 'topic', op: 'is', value: 'shopping' },
      { type: 'time', op: 'within', value: 'yesterday', basis: 'opened' },
      { type: 'topic', op: 'is_not', value: 'gardening equipment' },
    ], action_params: {}, confidence: 0.9 },
    tabs: [
      { id: 1, title: 'amazon shopping cart', accessedAgo: 1.5 * DAY },
      { id: 2, title: 'gardening shopping supplies', accessedAgo: 1.5 * DAY },
      { id: 3, title: 'shopping list archive', accessedAgo: 5 * DAY },
    ],
    opened: { 1: 1.5 * DAY, 2: 1.5 * DAY, 3: 5 * DAY },
    expect: [1],
  },
  {
    n: 2, cmd: "Close every YouTube tab I haven't looked at in the last hour",
    dsl: { intent: 'close_tabs', filters: [
      { type: 'domain', op: 'equals', value: 'youtube.com' },
      { type: 'time', op: 'older_than', value: 'last_hour', basis: 'accessed' },
    ], action_params: {}, confidence: 0.9 },
    tabs: [
      { id: 1, title: 'yt a', url: 'https://youtube.com/a', accessedAgo: 2 * HOUR },
      { id: 2, title: 'yt b', url: 'https://youtube.com/b', accessedAgo: 10 * MIN },
      { id: 3, title: 'yt c', url: 'https://www.youtube.com/c', accessedAgo: 3 * HOUR },
      { id: 4, title: 'other', url: 'https://x.com/z', accessedAgo: 5 * HOUR },
    ],
    expect: [1, 3],
  },
  {
    n: 3, cmd: 'Keep only my 5 most recently used research tabs, close the rest',
    dsl: { intent: 'close_tabs', filters: [
      { type: 'topic', op: 'is', value: 'research' },
      { type: 'rank', op: 'keep_newest', value: 5, scope: 'within_set' },
    ], action_params: {}, confidence: 0.85 },
    tabs: [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: 300 + i, title: `research paper ${i}`, accessedAgo: i * HOUR })),
    expect: [306, 307], // 5 newest kept (301-305), 2 oldest closed
  },
  {
    n: 4, cmd: 'Close duplicate tabs but keep the one I used most recently',
    dsl: { intent: 'close_tabs', filters: [
      { type: 'duplicates', op: 'is', value: true },
      { type: 'rank', op: 'keep_newest', value: 1, scope: 'per_dup_group' },
    ], action_params: {}, confidence: 0.9 },
    tabs: [
      { id: 41, title: 'dup 1', url: 'https://dup.com/x', accessedAgo: 1 * HOUR },
      { id: 42, title: 'dup 2', url: 'https://dup.com/x', accessedAgo: 2 * HOUR },
      { id: 43, title: 'dup 3', url: 'https://dup.com/x', accessedAgo: 3 * HOUR },
      { id: 44, title: 'unique', url: 'https://uniq.com/y', accessedAgo: 1 * HOUR },
    ],
    expect: [42, 43],
  },
  {
    n: 5, cmd: 'Mute every tab playing sound except my music tab',
    dsl: { intent: 'mute_tabs', filters: [
      { type: 'state', op: 'is', value: 'audible' },
      { type: 'topic', op: 'is_not', value: 'music' },
    ], action_params: {}, confidence: 0.9 },
    tabs: [
      { id: 51, title: 'spotify music', url: 'https://spotify.com', audible: true },
      { id: 52, title: 'youtube video', url: 'https://youtube.com/v', audible: true },
      { id: 53, title: 'podcast show', url: 'https://pod.com', audible: true },
      { id: 54, title: 'silent docs', url: 'https://docs.com', audible: false },
    ],
    expect: [52, 53],
  },
  {
    n: 6, cmd: 'Close everything older than 3 days except pinned tabs',
    dsl: { intent: 'close_tabs', filters: [
      { type: 'time', op: 'older_than', value: '3_days', basis: 'accessed' },
      { type: 'state', op: 'is_not', value: 'pinned' },
    ], action_params: {}, confidence: 0.9 },
    tabs: [
      { id: 61, title: 'old unpinned', accessedAgo: 5 * DAY },
      { id: 62, title: 'old pinned', accessedAgo: 6 * DAY, pinned: true },
      { id: 63, title: 'recent', accessedAgo: 1 * HOUR },
      { id: 64, title: 'undated' }, // no lastAccessed -> never matched by time
    ],
    expect: [61],
  },
  {
    n: 7, cmd: 'Bookmark the recipe tabs I opened this week, then close them',
    dsl: { intent: 'bookmark_tabs', filters: [
      { type: 'topic', op: 'is', value: 'recipe' },
      { type: 'time', op: 'within', value: 'this_week', basis: 'opened' },
    ], action_params: { closeAfterBookmark: true }, confidence: 0.9 },
    tabs: [
      { id: 71, title: 'pasta recipe', accessedAgo: 2 * DAY },
      { id: 72, title: 'recipe archive', accessedAgo: 10 * DAY },
      { id: 73, title: 'news roundup', accessedAgo: 1 * DAY },
    ],
    opened: { 71: 2 * DAY, 72: 10 * DAY, 73: 1 * DAY },
    expect: [71],
    expectParams: (ap) => ap.closeAfterBookmark === true,
  },
  {
    n: 8, cmd: 'Group the news articles I opened this morning',
    dsl: { intent: 'group_tabs', filters: [
      { type: 'topic', op: 'is', value: 'news' },
      { type: 'time', op: 'within', value: 'this morning', basis: 'opened' },
    ], action_params: {}, confidence: 0.85 },
    tabs: [
      { id: 81, title: 'news cnn', accessedAgo: 3 * HOUR },
      { id: 82, title: 'news bbc', accessedAgo: 4 * HOUR },
      { id: 83, title: 'news archive', accessedAgo: 2 * DAY },
      { id: 84, title: 'sports scores', accessedAgo: 1 * HOUR },
    ],
    opened: { 81: 3 * HOUR, 82: 4 * HOUR, 83: 2 * DAY, 84: 1 * HOUR },
    expect: [81, 82],
  },
  {
    n: 9, cmd: 'Find the tab where I was comparing noise-cancelling headphones and open it',
    dsl: { intent: 'retrieve_open', filters: [
      { type: 'topic', op: 'is', value: 'noise cancelling headphones' },
    ], action_params: { topK: 1 }, confidence: 0.8 },
    tabs: [],
    retrieval: (r) => r.query.includes('headphones') && r.timeRange === 'anytime' && r.topK === 1,
  },
  {
    n: 10, cmd: 'Find my laptop-research tabs from last week and reopen the most relevant',
    dsl: { intent: 'retrieve_open', filters: [
      { type: 'topic', op: 'is', value: 'laptop research' },
      { type: 'time', op: 'within', value: 'last_week', basis: 'opened' },
    ], action_params: { topK: 1 }, confidence: 0.8 },
    tabs: [],
    retrieval: (r) => r.query.includes('laptop') && r.timeRange === 'last_week' && r.topK === 1,
  },
];

(async () => {
  console.log('--- GOLDEN SET: recorded Gemini DSL -> validate -> set-exact execution ---');
  for (const c of CASES) {
    const plan = await buildFilterPlan(c.cmd, { callGemini: recorded(c.dsl), noCache: true });
    ok(`#${c.n} planner accepts golden DSL (source=gemini, intent=${c.dsl.intent})`,
      plan.source === 'gemini' && plan.intent === c.dsl.intent, `source=${plan.source} intent=${plan.intent}`);

    if (c.retrieval) {
      const r = extractRetrieval(plan);
      ok(`#${c.n} retrieval payload correct`, c.retrieval(r), JSON.stringify(r));
      continue;
    }

    const deps = mkDeps(c.tabs, c.opened);
    const exec = await executePlan(plan, deps.candidates, deps);
    const cmp = setEq(exec.tabIds, c.expect);
    ok(`#${c.n} set-exact tabIds`, cmp.equal, `got [${cmp.got}] want [${cmp.want}]`);
    if (c.expectParams) ok(`#${c.n} action_params passthrough`, c.expectParams(exec.action_params), JSON.stringify(exec.action_params));
  }

  console.log('\n--- FALLBACK CHAIN: Gemini -> Ollama -> regex ---');
  const throwFn = async () => { throw new Error('rate limited'); };
  const okOllama = async () => JSON.stringify({ intent: 'group_tabs', filters: [{ type: 'topic', op: 'is', value: 'news' }], confidence: 0.8 });

  let p = await buildFilterPlan('group news', { callGemini: throwFn, callOllama: okOllama, noCache: true });
  ok('gemini throw -> ollama tier', p.source === 'ollama' && p.intent === 'group_tabs', `source=${p.source}`);

  p = await buildFilterPlan('group news', { callGemini: async () => 'Error: network down', callOllama: okOllama, noCache: true });
  ok('gemini "Error:" string -> ollama tier', p.source === 'ollama', `source=${p.source}`);

  p = await buildFilterPlan('Close everything older than 3 days except pinned tabs', { callGemini: throwFn, callOllama: throwFn, signals: ['temporal', 'state'], noCache: true });
  ok('both providers fail -> regex tier', p.source === 'regex', `source=${p.source}`);
  // ...and the regex plan still resolves to the correct set (works fully offline).
  {
    const deps = mkDeps(CASES[5].tabs, CASES[5].opened);
    const exec = await executePlan(p, deps.candidates, deps);
    const cmp = setEq(exec.tabIds, [61]);
    ok('regex-tier plan executes to correct set (#6 offline)', cmp.equal, `got [${cmp.got}] want [${cmp.want}]`);
  }

  // validate() must reject an unparseable time rather than let it match-all.
  const badTime = async () => JSON.stringify({ intent: 'close_tabs', filters: [{ type: 'time', op: 'within', value: 'last friday' }], confidence: 0.9 });
  p = await buildFilterPlan('close tabs from last friday', { callGemini: badTime, callOllama: throwFn, noCache: true });
  ok('unparseable time rejected -> falls through to regex', p.source === 'regex', `source=${p.source}`);
  ok('rejected-time DSL never validates', validate({ intent: 'close_tabs', filters: [{ type: 'time', op: 'within', value: 'last friday' }], confidence: 0.9 }) === null);

  console.log('\n--- SELF-CORRECTION: 0-match topic -> re-plan resolves ---');
  {
    // First plan targets a topic no tab matches -> needsCorrection.
    const deps = mkDeps([
      { id: 91, title: 'quarterly budget spreadsheet', accessedAgo: 1 * HOUR },
      { id: 92, title: 'budget planning doc', accessedAgo: 2 * HOUR },
    ]);
    const bad = await buildFilterPlan('close my finance tabs', { callGemini: recorded({ intent: 'close_tabs', filters: [{ type: 'topic', op: 'is', value: 'cryptocurrency' }], action_params: {}, confidence: 0.9 }), noCache: true });
    const exec1 = await executePlan(bad, deps.candidates, deps);
    ok('0-match topic raises needsCorrection', exec1.needsCorrection && exec1.tabIds.length === 0, `tabIds=${exec1.tabIds.length} nc=${exec1.needsCorrection}`);

    // Correction re-plans (hint bypasses cache) with a topic that DOES match.
    const good = await buildFilterPlan('close my finance tabs', {
      callGemini: recorded({ intent: 'close_tabs', filters: [{ type: 'topic', op: 'is', value: 'budget' }], action_params: {}, confidence: 0.9 }),
      correctionHint: 'topic "cryptocurrency" matched 0 tabs', noCache: true,
    });
    const exec2 = await executePlan(good, deps.candidates, deps);
    const cmp = setEq(exec2.tabIds, [91, 92]);
    ok('corrected plan resolves to correct set, no further correction', cmp.equal && !exec2.needsCorrection, `got [${cmp.got}] want [${cmp.want}] nc=${exec2.needsCorrection}`);
  }

  console.log('\n--- EXCLUSION RECALL & REORDER INVARIANCE ---');
  {
    // Band-modeling fake: "programming" matches id 101 with high confidence (0.8),
    // id 102 with borderline confidence (0.4), and id 103 not at all (0.1).
    const tabs = [
      { id: 101, title: 'python deep learning tutorial', url: 'https://youtube.com/watch?v=1' },
      { id: 102, title: 'computer science discussion podcast', url: 'https://youtube.com/watch?v=2' }, // borderline
      { id: 103, title: 'lo-fi chill music mix', url: 'https://youtube.com/watch?v=3' },
      { id: 104, title: 'python reference documentation', url: 'https://docs.python.org/' }, // non-youtube
    ];
    const liveTabs = tabs.map(t => ({ ...t, pinned: false, audible: false, muted: false, active: false }));
    const candidates = liveTabs.map(t => ({ tabId: t.id, title: t.title }));

    const bandFindByTopic = async (topic, cands, opts = {}) => {
      const scores = { 101: 0.8, 102: 0.4, 103: 0.1, 104: 0.9 };
      const floor = opts.exclude ? 0.35 : 0.55;
      return (cands && cands.length ? cands : candidates)
        .filter(c => (scores[c.tabId] || 0) >= floor)
        .map(c => c.tabId);
    };

    const deps = { liveTabs, candidates, findByTopic: bandFindByTopic, parseTimeRange, now: NOW };

    // Plan: group youtube tabs except programming
    const plan = {
      intent: 'group_tabs',
      filters: [
        { type: 'domain', op: 'equals', value: 'youtube.com' },
        { type: 'topic', op: 'is_not', value: 'programming' }
      ],
      action_params: {},
      confidence: 0.9
    };

    const exec = await executePlan(plan, candidates, deps);
    // id 101 (high programming) and id 102 (borderline programming) are BOTH excluded.
    // id 104 is not youtube, so only id 103 (lo-fi music on youtube) survives!
    const cmp = setEq(exec.tabIds, [103]);
    ok('exclusion recall: borderline programming tab (0.4) is excluded from kept group', cmp.equal, `got [${cmp.got}] want [${cmp.want}]`);

    // Inclusion precision: group programming tabs without exclusion
    const incPlan = {
      intent: 'group_tabs',
      filters: [
        { type: 'topic', op: 'is', value: 'programming' }
      ],
      action_params: {},
      confidence: 0.9
    };
    const incExec = await executePlan(incPlan, candidates, deps);
    // Inclusion uses precision floor 0.55: only 101 and 104 match (102 is omitted from inclusion)
    const incCmp = setEq(incExec.tabIds, [101, 104]);
    ok('inclusion precision: only high-confidence programming tabs (>= 0.55) are included', incCmp.equal, `got [${incCmp.got}] want [${incCmp.want}]`);
  }

  console.log('\n--- MULTI-GROUP ROUTER & PLANNER ---');
  {
    const mgCmd = 'Make a group of all youtube tabs in 3 main groups - entertainment programming and other based on the content of the youtube video';
    const routed = isComplexCommand(mgCmd);
    ok('router flags multi-group command as complex', routed.complex);
    ok('router includes multi_group signal', routed.signals.includes('multi_group'));

    // Test offline regex extraction
    const parsedRegex = await parseMultiGroupCommand(mgCmd, {});
    ok('planner parses multi-group restrict', parsedRegex.restrict === 'youtube.com');
    ok('planner extracts bucket names', parsedRegex.buckets.length >= 2);

    // Test model-based extraction
    const mockModel = async () => JSON.stringify({
      restrict: 'youtube.com',
      buckets: [
        { name: 'Entertainment', characteristic: 'entertainment, music, movies' },
        { name: 'Programming', characteristic: 'coding tutorials and dev videos' },
        { name: 'Other', characteristic: 'miscellaneous youtube videos' }
      ]
    });
    const parsedModel = await parseMultiGroupCommand(mgCmd, { callGemini: mockModel });
    ok('model-based parse returns exact 3 buckets', parsedModel.buckets.length === 3 && parsedModel.buckets[0].name === 'Entertainment');
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  agent golden set + fallback + self-correction + exclusion recall + multi-group  (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})();
