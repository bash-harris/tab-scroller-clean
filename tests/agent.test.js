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

const { buildFilterPlan, validate, parseMultiGroupCommand, buildRegexPlan, validateActionParams, detectTimeFilter } = require('../agent-planner.js');
const { executePlan, executeSteps, extractRetrieval } = require('../agent-executor.js');
const { isComplexCommand } = require('../agent-router.js');
const { parseTimeRange, parseTimeWindow } = require('../recall-tabs.js');
const { assignToBuckets } = require('../multi-group-assign.js');

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
    dsl: {intent:'close_tabs',include:[{field:'topic',op:'about',value:'shopping'},{field:'time',op:'within',value:'yesterday',opts:{basis:'opened'}}],exclude:[{field:'topic',op:'about',value:'gardening equipment'}],action_params:{},confidence:0.9},
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
    dsl: {intent:'close_tabs',include:[{field:'domain',op:'equals',value:'youtube.com'},{field:'time',op:'older_than',value:'last_hour',opts:{basis:'accessed'}}],exclude:[],action_params:{},confidence:0.9},
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
    dsl: {intent:'close_tabs',include:[{field:'topic',op:'about',value:'research'},{field:'rank',op:'keep_newest',value:5,scope:'within_set'}],exclude:[],action_params:{},confidence:0.85},
    tabs: [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: 300 + i, title: `research paper ${i}`, accessedAgo: i * HOUR })),
    expect: [306, 307], // 5 newest kept (301-305), 2 oldest closed
  },
  {
    n: 4, cmd: 'Close duplicate tabs but keep the one I used most recently',
    dsl: {intent:'close_tabs',include:[{field:'duplicate',op:'is',value:true},{field:'rank',op:'keep_newest',value:1,scope:'per_dup_group'}],exclude:[],action_params:{},confidence:0.9},
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
    dsl: {intent:'mute_tabs',include:[{field:'state',op:'is',value:'audible'}],exclude:[{field:'topic',op:'about',value:'music'}],action_params:{},confidence:0.9},
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
    dsl: {intent:'close_tabs',include:[{field:'time',op:'older_than',value:'3_days',opts:{basis:'accessed'}}],exclude:[{field:'state',op:'is',value:'pinned'}],action_params:{},confidence:0.9},
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
    dsl: {intent:'bookmark_tabs',include:[{field:'topic',op:'about',value:'recipe'},{field:'time',op:'within',value:'this_week',opts:{basis:'opened'}}],exclude:[],action_params:{closeAfterBookmark:true},confidence:0.9},
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
    dsl: {intent:'group_tabs',include:[{field:'topic',op:'about',value:'news'},{field:'time',op:'within',value:'this morning',opts:{basis:'opened'}}],exclude:[],action_params:{},confidence:0.85},
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
    dsl: {intent:'retrieve_open',include:[{field:'topic',op:'about',value:'noise cancelling headphones'}],exclude:[],action_params:{topK:1},confidence:0.8},
    tabs: [],
    retrieval: (r) => r.query.includes('headphones') && r.timeRange === 'anytime' && r.topK === 1,
  },
  {
    n: 10, cmd: 'Find my laptop-research tabs from last week and reopen the most relevant',
    dsl: {intent:'retrieve_open',include:[{field:'topic',op:'about',value:'laptop research'},{field:'time',op:'within',value:'last_week',opts:{basis:'opened'}}],exclude:[],action_params:{topK:1},confidence:0.8},
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
  const okOllama = async () => JSON.stringify({ intent: 'group_tabs', include: [{ field: 'topic', op: 'about', value: 'news' }], exclude: [], confidence: 0.8 });

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
  const badTime = async () => JSON.stringify({ intent: 'close_tabs', include: [{ field: 'time', op: 'within', value: 'last friday' }], exclude: [], confidence: 0.9 });
  p = await buildFilterPlan('close tabs from last friday', { callGemini: badTime, callOllama: throwFn, signals: ['temporal'], noCache: true });
  ok('unparseable time rejected -> falls through to regex', p.source === 'regex', `source=${p.source}`);
  let threw = false;
  try {
    validate({ intent: 'close_tabs', include: [{ field: 'time', op: 'within', value: 'last friday' }], exclude: [], confidence: 0.9 }, ['temporal']);
  } catch (e) {
    threw = true;
  }
  ok('rejected-time DSL never validates', threw);

  console.log('\n--- SELF-CORRECTION: 0-match topic -> re-plan resolves ---');
  {
    // First plan targets a topic no tab matches -> needsCorrection.
    const deps = mkDeps([
      { id: 91, title: 'quarterly budget spreadsheet', accessedAgo: 1 * HOUR },
      { id: 92, title: 'budget planning doc', accessedAgo: 2 * HOUR },
    ]);
    const bad = await buildFilterPlan('close my finance tabs', { callGemini: recorded({ intent: 'close_tabs', include: [{ field: 'topic', op: 'about', value: 'cryptocurrency' }], exclude: [], action_params: {}, confidence: 0.9 }), noCache: true });
    const exec1 = await executePlan(bad, deps.candidates, deps);
    ok('0-match topic raises needsCorrection', exec1.needsCorrection && exec1.tabIds.length === 0, `tabIds=${exec1.tabIds.length} nc=${exec1.needsCorrection}`);

    // Correction re-plans (hint bypasses cache) with a topic that DOES match.
    const good = await buildFilterPlan('close my finance tabs', {
      callGemini: recorded({ intent: 'close_tabs', include: [{ field: 'topic', op: 'about', value: 'budget' }], exclude: [], action_params: {}, confidence: 0.9 }),
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
      v: 2,
      intent: 'group_tabs',
      where: {
        all: [{ field: 'domain', op: 'equals', value: 'youtube.com' }],
        none: [{ field: 'topic', op: 'about', value: 'programming' }]
      },
      params: {},
      confidence: 0.9
    };

    const exec = await executePlan(plan, candidates, deps);
    // id 101 (high programming) and id 102 (borderline programming) are BOTH excluded.
    // id 104 is not youtube, so only id 103 (lo-fi music on youtube) survives!
    const cmp = setEq(exec.tabIds, [103]);
    ok('exclusion recall: borderline programming tab (0.4) is excluded from kept group', cmp.equal, `got [${cmp.got}] want [${cmp.want}]`);

    // Inclusion precision: group programming tabs without exclusion
    const incPlan = {
      v: 2,
      intent: 'group_tabs',
      where: {
        all: [{ field: 'topic', op: 'about', value: 'programming' }]
      },
      params: {},
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

  console.log('\n--- OPEN / FOCUS TABS (intent: open_tabs) ---');
  {
    // Router: a focus verb + PLURAL "tabs" trips focus_open; a time phrase also
    // trips temporal. It must NOT be mistaken for find_open (content recall).
    const r1 = isComplexCommand('Open the programming tabs from the last hour');
    ok('router: "open ... tabs from last hour" is complex', r1.complex);
    ok('router: emits focus_open signal', r1.signals.includes('focus_open'));
    ok('router: also emits temporal (time before NLI)', r1.signals.includes('temporal'));
    ok('router: does NOT emit find_open (not a content recall)', !r1.signals.includes('find_open'));

    // No time word: focus_open alone still routes it to the planner.
    const r2 = isComplexCommand('show me my youtube tabs');
    ok('router: "show me my youtube tabs" complex via focus_open',
      r2.complex && r2.signals.includes('focus_open') && !r2.signals.includes('temporal'));

    // Singular "the tab where ..." stays find_open, never focus_open.
    const r3 = isComplexCommand('open the tab where I read about cricket');
    ok('router: singular "the tab where" -> find_open, not focus_open',
      r3.signals.includes('find_open') && !r3.signals.includes('focus_open'));

    // Bare navigation with no "tabs" noun must not trip focus_open.
    const r4 = isComplexCommand('open youtube.com');
    ok('router: "open youtube.com" (navigation) does not trip focus_open',
      !r4.signals.includes('focus_open'));

    // Planner validate(): an open_tabs DSL is accepted and, being non-destructive
    // and fully covered, keeps its intent (never downgraded to clarify).
    const vplan = validate({
      intent: 'open_tabs',
      include: [{ field: 'topic', op: 'about', value: 'programming' },
                { field: 'time', op: 'within', value: 'last_hour', opts: { basis: 'accessed' } }],
      exclude: [], confidence: 0.85
    }, ['temporal', 'focus_open']);
    ok('planner validate() keeps intent open_tabs', vplan && vplan.intent === 'open_tabs', JSON.stringify(vplan && vplan.intent));
    ok('planner marks open_tabs non-destructive', vplan && vplan.destructive === false);

    // End-to-end (recorded Gemini): the executor applies the time window so the
    // resolved set that handleFocusTabs would focus is ALREADY time-scoped --
    // only the recent programming tab, not the 2-hour-old one nor the recipe.
    const dsl = {
      intent: 'open_tabs',
      include: [{ field: 'topic', op: 'about', value: 'programming' },
                { field: 'time', op: 'within', value: 'last_hour', opts: { basis: 'accessed' } }],
      exclude: [], confidence: 0.85
    };
    const plan = await buildFilterPlan('open the programming tabs from the last hour',
      { callGemini: recorded(dsl), signals: ['temporal', 'focus_open'], noCache: true });
    ok('planner accepts open_tabs golden DSL (source=gemini)', plan.source === 'gemini' && plan.intent === 'open_tabs', `source=${plan.source} intent=${plan.intent}`);
    const deps = mkDeps([
      { id: 10, title: 'programming rust async', accessedAgo: 10 * MIN },
      { id: 11, title: 'programming python tutorial', accessedAgo: 120 * MIN },
      { id: 12, title: 'cooking pasta recipe', accessedAgo: 5 * MIN },
    ]);
    const exec = await executePlan(plan, deps.candidates, deps);
    const cmp = setEq(exec.tabIds, [10]);
    ok('open_tabs resolves the time-scoped set (recent programming only)', cmp.equal, `got [${cmp.got}] want [${cmp.want}]`);
    ok('open_tabs plan is non-destructive at executor', exec.destructive === false);

    // Regex fallback: with both providers unavailable, the focus_open signal +
    // verb still lands on open_tabs offline, carrying topic + time predicates.
    const rp = buildRegexPlan('open the programming tabs from the last hour', ['temporal', 'focus_open']);
    ok('buildRegexPlan -> intent open_tabs', rp.intent === 'open_tabs', rp.intent);
    const rpTopic = (rp.where.all || []).find(f => f.field === 'topic');
    const rpTime = (rp.where.all || []).find(f => f.field === 'time');
    ok('buildRegexPlan open_tabs carries topic=programming', !!rpTopic && /programming/.test(rpTopic.value), JSON.stringify(rpTopic));
    ok('buildRegexPlan open_tabs carries time within last_hour', !!rpTime && rpTime.op === 'within' && rpTime.value === 'last_hour', JSON.stringify(rpTime));
  }

  console.log('\n--- TWO-SIDED TIME WINDOW (op: between) ---');
  {
    // Unit: parseTimeWindow resolves both bounds. The LARGER number is the older
    // (earlier) `since`; the SMALLER is the more recent `until`.
    const w1 = parseTimeWindow('1_to_3_hours', NOW);
    ok('parseTimeWindow canonical "1_to_3_hours"', w1.since === NOW - 3 * HOUR && w1.until === NOW - 1 * HOUR, JSON.stringify(w1));
    const w2 = parseTimeWindow('between 2 and 5 days ago', NOW);
    ok('parseTimeWindow prose "between 2 and 5 days ago"', w2.since === NOW - 5 * DAY && w2.until === NOW - 2 * DAY, JSON.stringify(w2));
    const w3 = parseTimeWindow('1-3 hours', NOW);
    ok('parseTimeWindow dashed "1-3 hours"', w3.since === NOW - 3 * HOUR && w3.until === NOW - 1 * HOUR, JSON.stringify(w3));
    // Single-sided phrase must still yield until=now (no upper bound invented).
    const w4 = parseTimeWindow('3 hours', NOW);
    ok('parseTimeWindow single-sided "3 hours" -> until=now', w4.since === NOW - 3 * HOUR && w4.until === NOW, JSON.stringify(w4));

    // Executor: op:'between' keeps only tabs whose ts is inside [since, until).
    const tabs = [
      { id: 201, title: 'too recent', accessedAgo: 0.5 * HOUR }, // newer than until
      { id: 202, title: 'inside window', accessedAgo: 2 * HOUR }, // 1h..3h -> kept
      { id: 203, title: 'too old', accessedAgo: 4 * HOUR }, // older than since
      { id: 204, title: 'undated' }, // no ts -> never matches a time filter
    ];
    const deps = { ...mkDeps(tabs), parseTimeWindow };
    const plan = {
      v: 2, intent: 'group_tabs',
      where: { all: [{ field: 'time', op: 'between', value: '1_to_3_hours', opts: { basis: 'accessed' } }] },
      params: {}, confidence: 0.9,
    };
    const exec = await executePlan(plan, deps.candidates, deps);
    const cmp = setEq(exec.tabIds, [202]);
    ok('executor between keeps only the in-window tab', cmp.equal, `got [${cmp.got}] want [${cmp.want}]`);

    // Planner validate(): op:'between' survives instead of collapsing to 'within'.
    const vplan = validate({ intent: 'group_tabs', include: [{ field: 'time', op: 'between', value: '1_to_3_hours', opts: { basis: 'accessed' } }], exclude: [], confidence: 0.9 }, ['temporal']);
    const vtime = vplan && vplan.where && vplan.where.all && vplan.where.all.find(f => f.field === 'time');
    ok('validate() preserves op:between', !!vtime && vtime.op === 'between' && vtime.value === '1_to_3_hours', JSON.stringify(vtime));

    // Regex fallback: a two-sided phrase emits op:'between', not a silent 'within'.
    const rp = buildRegexPlan('group my tabs from 1 to 3 hours ago', ['temporal']);
    const rtime = rp && rp.where && rp.where.all && rp.where.all.find(f => f.field === 'time');
    ok('buildRegexPlan emits op:between for two-sided phrase', !!rtime && rtime.op === 'between', JSON.stringify(rtime));
  }

  console.log('\n--- MULTI-GROUP ASSIGN (cosine argmax + NLI tie-break) ---');
  {
    const buckets = [
      { name: 'Coding', characteristic: 'programming' },
      { name: 'Music', characteristic: 'songs' },
      { name: 'Gardening', characteristic: 'plants' },
    ];
    // Bucket labels are "Coding: programming" / "Music: songs" / "Gardening: plants"
    // at input indices 0 / 1 / 2. Fake embedder puts each on its own axis.
    const fakeEmbed = async (label) => {
      if (label.includes('programming')) return new Float32Array([1, 0, 0]);
      if (label.includes('songs')) return new Float32Array([0, 1, 0]);
      if (label.includes('plants')) return new Float32Array([0, 0, 1]);
      return new Float32Array([0, 0, 0]);
    };
    // Fake NLI: return { labels, scores } SORTED BY SCORE DESCENDING with the
    // winner FIRST -- exactly what transformers.js does, and exactly the order
    // that breaks an index-based (scores[i] == bucket i) reader.
    let inferCount = 0;
    const fakeInfer = async (premise, lbls) => {
      inferCount++;
      const p = String(premise).toLowerCase();
      let winner;
      if (p.includes('garden') || p.includes('rose')) winner = 'Gardening: plants';
      else if (p.includes('spotify') || p.includes('music') || p.includes('song')) winner = 'Music: songs';
      else winner = 'Coding: programming';
      const rest = lbls.filter(l => l !== winner);
      return { labels: [winner, ...rest], scores: [0.7, 0.2, 0.1] };
    };

    const cards = [
      { tabId: 1, title: 'python tutorial', url: 'https://x.com/1', embedding: new Float32Array([1, 0, 0]) }, // cosine -> Coding
      { tabId: 2, title: 'growing roses in the garden', url: 'https://x.com/2' }, // no embedding -> NLI -> Gardening (idx 2)
      { tabId: 3, title: 'spotify playlist', url: 'https://x.com/3' }, // no embedding -> NLI -> Music (idx 1)
    ];

    const res = await assignToBuckets({ buckets, cards }, { embedFn: fakeEmbed, inferZeroShot: fakeInfer, marginThreshold: 0.06 });

    ok('cosine fast path: tab 1 -> Coding (bucket 0), no NLI', res.buckets[0].tabIds.includes(1) && res.perCard.find(p => p.tabId === 1).via === 'cosine');
    // THE TRAP: winner label "Gardening: plants" is output[0] but input index 2.
    // An index-based reader would file tab 2 into bucket 0 (Coding). Correct is 2.
    ok('label-reorder trap: tab 2 -> Gardening (bucket 2), NOT bucket 0', res.buckets[2].tabIds.includes(2) && !res.buckets[0].tabIds.includes(2), JSON.stringify(res.perCard.find(p => p.tabId === 2)));
    ok('NLI tie-break: tab 3 -> Music (bucket 1)', res.buckets[1].tabIds.includes(3));
    ok('NLI spent only on the 2 ambiguous tabs (tab 1 free)', inferCount === 2 && res.stats.nliCalls === 2, `inferCount=${inferCount} nliCalls=${res.stats.nliCalls}`);
    ok('every tab placed, none unassigned', res.unassigned.length === 0);

    // Degradation: no NLI available + a tab with no embedding -> unassigned, not a
    // fabricated bucket. (A tab WITH an embedding still resolves by cosine.)
    const res2 = await assignToBuckets(
      { buckets, cards: [{ tabId: 5, title: 'coding', url: 'https://x.com/5', embedding: new Float32Array([1, 0, 0]) }, { tabId: 6, title: 'mystery', url: 'https://x.com/6' }] },
      { embedFn: fakeEmbed /* no inferZeroShot */ }
    );
    ok('no-NLI: embedded tab resolves by cosine, un-embeddable tab -> unassigned', res2.buckets[0].tabIds.includes(5) && res2.unassigned.includes(6), JSON.stringify({ b: res2.buckets.map(b => b.tabIds), u: res2.unassigned }));

    // Single-bucket arity: everything lands in it, no model calls.
    const res3 = await assignToBuckets({ buckets: [{ name: 'All', characteristic: 'stuff' }], cards }, { embedFn: fakeEmbed, inferZeroShot: fakeInfer });
    ok('single bucket: all tabs assigned, 0 NLI calls', res3.buckets[0].tabIds.length === 3 && res3.stats.nliCalls === 0);
  }

  console.log('\n--- ACTION PARAMS SANITIZATION (validateActionParams) ---');
  {
    // Bucket arity is capped at 8 even when the model returns more.
    const many = validateActionParams({ buckets: Array.from({ length: 12 }, (_, i) => ({ name: `G${i}`, characteristic: `c${i}` })) });
    ok('buckets capped at 8', many.buckets.length === 8, `got ${many.buckets.length}`);

    // Names/characteristics are whitespace-collapsed and length-capped (40 / 120).
    const capped = validateActionParams({ buckets: [
      { name: '  Coding   dev  ', characteristic: 'a  b' },
      { name: 'x'.repeat(60), characteristic: 'y'.repeat(200) },
    ] });
    ok('bucket name whitespace-collapsed', capped.buckets[0].name === 'Coding dev', JSON.stringify(capped.buckets[0]));
    ok('bucket characteristic whitespace-collapsed', capped.buckets[0].characteristic === 'a b');
    ok('bucket name capped at 40', capped.buckets[1].name.length === 40);
    ok('bucket characteristic capped at 120', capped.buckets[1].characteristic.length === 120);

    // Empty rows drop; a missing name falls back to the characteristic; junk skipped.
    const fb = validateActionParams({ buckets: [
      { characteristic: 'just a characteristic' },
      { name: '', characteristic: '' },
      null, 'nope',
      { name: 'Real' },
    ] });
    ok('empty + non-object bucket rows dropped', fb.buckets.length === 2, JSON.stringify(fb.buckets));
    ok('bucket name falls back to characteristic', fb.buckets[0].name === 'just a characteristic');
    ok('name-only bucket mirrors name into characteristic', fb.buckets[1].name === 'Real' && fb.buckets[1].characteristic === 'Real');

    // restrict is trimmed/collapsed/capped; a blank restrict is dropped entirely.
    ok('restrict whitespace-collapsed + trimmed', validateActionParams({ restrict: '  you tube . com  ' }).restrict === 'you tube . com');
    ok('restrict capped at 60', validateActionParams({ restrict: 'z'.repeat(90) }).restrict.length === 60);
    ok('blank restrict dropped', !('restrict' in validateActionParams({ restrict: '   ' })));

    // Scalars: color lowercased, groupName capped, no buckets key when none supplied.
    const scal = validateActionParams({ color: 'BLUE', groupName: 'g'.repeat(60) });
    ok('color lowercased', scal.color === 'blue');
    ok('groupName capped at 40', scal.groupName.length === 40);
    ok('no buckets key when none given', !('buckets' in scal));
    // Non-object input yields an empty object, never throws.
    ok('non-object action_params -> {}', JSON.stringify(validateActionParams(null)) === '{}' && JSON.stringify(validateActionParams('x')) === '{}');
  }

  console.log('\n--- detectTimeFilter (direct: op + basis) ---');
  {
    // Two-sided phrase -> op:between; "from" (with no viewed/used verb) picks basis:opened.
    const between = detectTimeFilter('group my tabs from 1 to 3 hours ago');
    ok('detectTimeFilter two-sided -> op:between, basis:opened', between && between.op === 'between' && between.opts.basis === 'opened' && !!between.value, JSON.stringify(between));

    // Single-sided "opened in the last hour" -> op:within, value last_hour, basis:opened.
    const within = detectTimeFilter('tabs opened in the last hour');
    ok('detectTimeFilter single -> op:within basis:opened value:last_hour', within && within.op === 'within' && within.value === 'last_hour' && within.opts.basis === 'opened', JSON.stringify(within));

    // A viewing verb ("looked at") flips basis to accessed, still op:within.
    const accessed = detectTimeFilter('tabs i looked at in the last hour');
    ok('detectTimeFilter "looked at" -> basis:accessed', accessed && accessed.op === 'within' && accessed.opts.basis === 'accessed', JSON.stringify(accessed));

    // "haven't ... in the last week" is a staleness phrase -> op:older_than, basis:accessed.
    const older = detectTimeFilter("tabs i haven't looked at in the last week");
    ok('detectTimeFilter staleness -> op:older_than, basis:accessed', older && older.op === 'older_than' && older.opts.basis === 'accessed', JSON.stringify(older));

    // No temporal phrase -> null (a plain topic command carries no time filter).
    ok('detectTimeFilter no time phrase -> null', detectTimeFilter('close my cricket tabs') === null);
  }

  console.log('\n--- TOOL-CALL SCHEMA V3: CHAINED COMMANDS (steps[]) ---');
  {
    // (1) PLANNER EMITS 2 STEPS: a chained model output validates into a v3
    // plan with 2 steps; a single-intent steps array is accepted too
    // (backward compat), and a bad intent in one step dies alone.
    const chained = validate({
      steps: [
        { intent: 'bookmark_tabs', include: [{ field: 'topic', op: 'about', value: 'recipe' }], exclude: [], confidence: 0.9 },
        { intent: 'close_tabs', include: [], exclude: [], carry: true, confidence: 0.9 },
      ],
      confidence: 0.9,
    }, []);
    ok('planner emits 2 steps (v3 plan)',
      chained && chained.v === 3 && Array.isArray(chained.steps) && chained.steps.length === 2,
      JSON.stringify(chained && { v: chained.v, n: chained.steps && chained.steps.length }));
    ok('chained plan destructive = any step destructive', chained.destructive === true);
    ok('carry flag survives validation', chained.steps[1].carry === true && chained.steps[0].carry === false);

    const single = validate({
      steps: [{ intent: 'mute_tabs', include: [{ field: 'state', op: 'is', value: 'audible' }], exclude: [], confidence: 0.9 }],
      confidence: 0.9,
    }, []);
    ok('single-step array accepted (backward compat)', single && single.v === 3 && single.steps.length === 1,
      JSON.stringify(single && single.v));

    const badIntent = validate({
      steps: [
        { intent: 'bookmark_tabs', include: [], exclude: [], confidence: 0.9 },
        { intent: 'nuke_tabs', include: [], exclude: [], confidence: 0.9 },
      ],
      confidence: 0.9,
    }, []);
    ok('bad step intent drops, valid step survives', badIntent && badIntent.v === 3 && badIntent.steps.length === 1,
      JSON.stringify(badIntent && badIntent.steps && badIntent.steps.length));

    // Closed-enum per-step dimensions: relationship/position/groupScope land
    // in the step's where tree as include[] predicates.
    const v3slots = validate({
      steps: [{ intent: 'group_tabs', include: [], exclude: [],
        slots: { relationship: { openerOf: 'fastmcp docs', chain: true }, position: { from: 'end', n: 3 }, groupScope: { color: 'grey' } },
        confidence: 0.9 }],
      confidence: 0.9,
    }, []);
    const v3fields = v3slots.steps[0].where.all.map(f => f.field);
    ok('step slots compile to relationship+position+groupScope predicates',
      v3fields.includes('relationship') && v3fields.includes('position') && v3fields.includes('groupScope'),
      JSON.stringify(v3fields));
    ok('groupScope color enum closes bad colors',
      validate({ steps: [{ intent: 'group_tabs', include: [], exclude: [], slots: { groupScope: { color: 'chartreuse' } }, confidence: 0.9 }] }, [])
        .steps[0].where.all === undefined);

    // (2) EXECUTOR ORDER: steps run sequentially, union carries both steps'
    // selections.
    const NOW2 = 1_000_000_000_000, DAY2 = 86400000;
    const tabs2 = [
      { id: 1, title: 'pasta recipe', url: 'https://x.com/1', lastAccessed: NOW2 - 2 * DAY2, active: false },
      { id: 2, title: 'recipe archive', url: 'https://x.com/2', lastAccessed: NOW2 - 10 * DAY2, active: false },
      { id: 3, title: 'news roundup', url: 'https://x.com/3', lastAccessed: NOW2 - 1 * DAY2, active: false },
    ];
    const deps2 = mkDeps(tabs2);
    const s1 = { intent: 'bookmark_tabs', where: { all: [{ field: 'topic', op: 'about', value: 'recipe' }] }, params: {}, carry: false, destructive: false };
    const s2 = { intent: 'mute_tabs', where: { all: [{ field: 'state', op: 'is', value: 'audible' }] }, params: {}, carry: true, destructive: false };
    const live2 = tabs2.map(t => ({ ...t, audible: t.id === 1 || t.id === 3 }));
    const res2 = await executeSteps([s1, s2], deps2.candidates, { ...deps2, liveTabs: live2 });
    ok('executor order: step1 selects recipes', JSON.stringify(res2.steps[0].tabIds) === '[1,2]', JSON.stringify(res2.steps[0].tabIds));
    ok('executor order: step2 (carry) restricted to step1 selection', JSON.stringify(res2.steps[1].tabIds) === '[1]', JSON.stringify(res2.steps[1].tabIds));
    ok('composite tabIds = union of steps', setEq(res2.tabIds, [1, 2]).equal, JSON.stringify(res2.tabIds));
    ok('chain not failed', res2.failed === false);

    // (3) CARRY FLAG: step 2 without carry scans the WHOLE universe, with
    // carry only the inherited set.
    const s2NoCarry = { intent: 'mute_tabs', where: { all: [{ field: 'state', op: 'is', value: 'audible' }] }, params: {}, carry: false, destructive: false };
    const resNoCarry = await executeSteps([s1, s2NoCarry], deps2.candidates, { ...deps2, liveTabs: live2 });
    ok('no carry: step2 scans whole universe', JSON.stringify(resNoCarry.steps[1].tabIds) === '[1,3]', JSON.stringify(resNoCarry.steps[1].tabIds));

    // (4) FAILURE ABORTS CHAIN: step 1 matches 0 tabs -> step 2 never runs.
    const s1Empty = { intent: 'bookmark_tabs', where: { all: [{ field: 'topic', op: 'about', value: 'quantum' }] }, params: {}, carry: false, destructive: false };
    let ran = 0;
    const depsCounted = {
      ...mkDeps(tabs2),
      findByTopic: async (v, cands) => {
        if (String(v).includes('quantum')) return [];
        ran++;
        return (cands || deps2.candidates).filter(c => c.title.includes('recipe')).map(c => c.tabId);
      },
    };
    const resFail = await executeSteps([s1Empty, s2], depsCounted.candidates, { ...depsCounted, liveTabs: tabs2 });
    ok('failure aborts chain: failed=true, failedAtStep=0', resFail.failed === true && resFail.failedAtStep === 0, JSON.stringify({ f: resFail.failed, at: resFail.failedAtStep }));
    ok('failure aborts chain: step2 never executed', resFail.steps.length === 1 && resFail.steps[0].tabIds.length === 0,
      JSON.stringify(resFail.steps.map(s => s.tabIds)));

    // (5) COMPOSITE UND RECORDED ONCE: the composite transaction descriptor
    // carries ONE record with every step's op + the union tabIds (mirrors the
    // multi-group single-record precedent).
    const CA = require('../command-agent.js');
    const compositePlan = CA.composeChainedPlan(
      { steps: [s1, s2].map(st => ({ intent: st.intent, carry: st.carry })), source: 'gemini' },
      res2,
    );
    const tx = CA.buildCompositeTransaction(
      { steps: [s1, s2].map(st => ({ intent: st.intent, carry: st.carry })) },
      res2,
    );
    ok('composite tx is ONE record, action=chain', tx.action === 'chain' && tx.steps.length === 2, JSON.stringify(tx));
    ok('composite tx records per-step intents + union tabIds',
      tx.steps[0].intent === 'bookmark_tabs' && tx.steps[1].intent === 'mute_tabs' &&
      tx.steps[1].carry === true && setEq(tx.tabIds, [1, 2]).equal, JSON.stringify(tx));
    ok('chained plan preview = per-step labels',
      /1\. Bookmark 2 tab/.test(compositePlan.reason) && /2\. Mute 1 tab/.test(compositePlan.reason),
      JSON.stringify(compositePlan.reason));
    ok('chained plan marks chained + union selection',
      compositePlan.chained === true && setEq(compositePlan.tabIds, [1, 2]).equal &&
      compositePlan.destructive === false, JSON.stringify({ c: compositePlan.chained, t: compositePlan.tabIds }));

    // (6) PARSER END-TO-END: "bookmark X and then close them" -> LlmQuery
    // emits steps[] with carry on step 2, deterministically (no model).
    global.self.LlmQuery = require('../llm-query.js');
    const q = global.self.LlmQuery;
    const st = q.stepsFromCommand('bookmark the recipe tabs and then close them');
    ok('parser: chained command -> 2 steps',
      st && st.length === 2 && st[0].intent === 'bookmark_tabs' && st[1].intent === 'close_tabs',
      JSON.stringify(st));
    ok('parser: "them" sets carry on step 2', st && st[1].carry === true);
    ok('parser: topic list does NOT split ("cricket and football")',
      q.stepsFromCommand('group my cricket and football tabs') === null);
    ok('parser: plain command -> no steps',
      q.stepsFromCommand('close all shopping tabs from yesterday except gardening') === null);
    ok('parser: max 3 steps ("A then B then C")',
      (q.stepsFromCommand('bookmark the react docs and then close them and then group the rest') || []).length === 3);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  agent golden set + fallback + self-correction + exclusion recall + multi-group  (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})();
