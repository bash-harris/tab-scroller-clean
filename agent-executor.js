// agent-executor.js
// LAYER 2 of the bounded tool-calling agent: the deterministic "tools". Takes a
// validated Filter Plan (Layer 1) and turns it into an exact set of tab ids by
// composing primitive filters with set algebra. ZERO model calls happen here.
//
// WHY THE EXECUTOR IS PURE OVER AN INJECTED SNAPSHOT
// Everything the executor needs is passed in: the live tab snapshot (`liveTabs`,
// the mapTab shape the rest of the app already uses), a topic matcher
// (`findByTopic`, backed by NliSelect), and the timing lookups. That is a
// deliberate design choice, not incidental -- it means the whole set-algebra core
// runs in node against fixtures with no chrome, no NLI model, and no wall clock,
// so the eval can assert SET-EXACT tab selection (the consequence), not just that
// some JSON was produced. The state/domain/duplicate predicates mirror
// resolveTabsFromFilters (background.js:2144) exactly, applied once to the
// already-fetched snapshot instead of re-querying chrome per filter.
//
// TWO RECENCY BASES (from the session-tracker steer).
//   basis "opened"   -> SessionMemoryEngine.openedAt (when the tab was OPENED)
//   basis "accessed" -> tab.lastAccessed             (when it was last FOCUSED)
// Each degrades gracefully to the other and finally to the tab card's
// extractedAt. A tab we cannot date AT ALL is NEVER matched by a time filter --
// we do not destructively act on unknown time (the "stale memory" LCFE class).
//
// SET ALGEBRA (combine: "all"):
//   inclusive filters (topic is, time, domain, state is, duplicates) -> intersect
//   exclusion filters (topic is_not, state is_not)                   -> subtract
//   rank (keep_newest/oldest)  -> PROTECT the kept tabs, act on the remainder
// "older_than" is an INCLUSIVE selection of old tabs ("close everything older
// than 3 days" selects the old ones), not an exclusion.

(() => {
  let parseTimeRangeDefault;
  try { ({ parseTimeRange: parseTimeRangeDefault } = require('./recall-tabs.js')); }
  catch { parseTimeRangeDefault = (typeof self !== 'undefined' && self.parseTimeRange) || (() => 0); }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
  }

  const DESTRUCTIVE = new Set(['close_tabs']);

  // ---- set helpers ----
  const intersect = (a, b) => new Set([...a].filter(x => b.has(x)));
  const subtract = (a, b) => new Set([...a].filter(x => !b.has(x)));

  function describePlan(dsl) {
    return (dsl.filters || []).map(f => {
      switch (f.type) {
        case 'topic': return (f.op === 'is_not' ? 'not ' : '') + f.value;
        case 'time': return (f.op === 'older_than' ? 'older than ' : 'within ') + f.value + ' (' + f.basis + ')';
        case 'domain': return f.value;
        case 'state': return (f.op === 'is_not' ? 'not ' : '') + f.value;
        case 'duplicates': return 'duplicate';
        case 'rank': return (f.op === 'keep_oldest' ? 'keep ' + f.value + ' oldest' : 'keep ' + f.value + ' newest') + (f.scope === 'per_dup_group' ? '/dup' : '');
        default: return '';
      }
    }).filter(Boolean).join(' · ');
  }

  /**
   * Execute a Filter Plan into an exact acted-on set.
   *
   * @param {object} dsl        validated plan from AgentPlanner
   * @param {Array}  candidates enriched open-tab cards ({tabId, embedding, ...})
   * @param {object} opts
   *   opts.liveTabs     [{id,url,title,pinned,audible,muted,active,lastAccessed}] universe (mapTab shape)
   *   opts.findByTopic  async (topicValue, candidates) -> Iterable<tabId>  (NliSelect-backed)
   *   opts.getOpenedAt  (tabId) -> number|null   (SessionMemoryEngine openedAt)
   *   opts.getExtractedAt (tabId) -> number|null (final timing fallback; optional)
   *   opts.now          number (default Date.now())
   *   opts.parseTimeRange (value, now) -> boundary ms (default from recall-tabs)
   *
   * @returns {Promise<{tabIds:number[], perTabReasons:object, confidence:number,
   *   uncertain:number[], needsCorrection:boolean, notes:string[], intent:string,
   *   action_params:object, destructive:boolean}>}
   */
  async function executePlan(dsl, candidates = [], opts = {}) {
    const notes = [];
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const parseTime = opts.parseTimeRange || parseTimeRangeDefault;
    const findByTopic = opts.findByTopic || (async () => []);
    const getOpenedAt = opts.getOpenedAt || (() => null);
    const getExtractedAt = opts.getExtractedAt || (() => null);

    const liveTabs = Array.isArray(opts.liveTabs) ? opts.liveTabs : [];
    const tabById = new Map(liveTabs.map(t => [t.id, t]));
    const universe = new Set(liveTabs.map(t => t.id));
    const cardById = new Map((candidates || []).map(c => [c.tabId, c]));

    // Timestamp resolution honouring the requested basis, with graceful fallback.
    // Returns null when the tab cannot be dated at all -> excluded from time math.
    const tsForBasis = (id, basis) => {
      const tab = tabById.get(id);
      const accessed = tab && Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null;
      const opened = Number.isFinite(getOpenedAt(id)) ? getOpenedAt(id) : null;
      const extracted = Number.isFinite(getExtractedAt(id)) ? getExtractedAt(id) : null;
      const chain = basis === 'opened' ? [opened, accessed, extracted] : [accessed, opened, extracted];
      for (const v of chain) if (v != null) return v;
      return null;
    };
    // Recency used purely for ranking; unlike time filters this never excludes a
    // tab, so an undated tab sorts oldest (0) rather than dropping out.
    const recencyOf = (id) => {
      const t = tsForBasis(id, 'accessed');
      return t == null ? 0 : t;
    };

    const tStart = Date.now();
    const cheapInclusive = []; // Array<Set<tabId>>
    const cheapExclusions = []; // Array<Set<tabId>>
    const topicFilters = [];
    const rankFilters = [];
    let dupGroupsSource = null; // Set of dup tabIds, for per_dup_group ranking
    let topicMatchedZero = false;

    // Phase A: Evaluate all cheap non-topic filters first (O(n) set operations, zero model calls)
    const tPhaseA = Date.now();
    for (const f of (dsl.filters || [])) {
      if (f.type === 'topic') {
        topicFilters.push(f);
      } else if (f.type === 'time') {
        const boundary = parseTime(f.value, now);
        const set = new Set();
        let undated = 0;
        for (const id of universe) {
          const ts = tsForBasis(id, f.basis);
          if (ts == null) { undated++; continue; } // never act on unknown time
          if (f.op === 'older_than' ? ts < boundary : ts >= boundary) set.add(id);
        }
        if (undated) notes.push(`${undated} tab(s) had no ${f.basis} time and were left out of the time filter`);
        cheapInclusive.push(set);
      } else if (f.type === 'domain') {
        const d = f.value.toLowerCase();
        cheapInclusive.push(new Set(liveTabs.filter(t => hostOf(t.url).includes(d)).map(t => t.id)));
      } else if (f.type === 'state') {
        const set = new Set(liveTabs.filter(t => {
          if (f.value === 'pinned') return !!t.pinned;
          if (f.value === 'audible') return !!t.audible;
          if (f.value === 'muted') return !!t.muted;
          return false;
        }).map(t => t.id));
        if (f.op === 'is_not') cheapExclusions.push(set); else cheapInclusive.push(set);
      } else if (f.type === 'duplicates') {
        const urlCounts = new Map();
        for (const t of liveTabs) if (t.url) urlCounts.set(t.url, (urlCounts.get(t.url) || 0) + 1);
        const set = new Set(liveTabs.filter(t => t.url && urlCounts.get(t.url) > 1).map(t => t.id));
        dupGroupsSource = set;
        cheapInclusive.push(set);
      } else if (f.type === 'rank') {
        rankFilters.push(f);
      }
    }

    // Compute cheap scope: intersect all cheap inclusive sets and subtract cheap exclusions
    let working = cheapInclusive.length
      ? cheapInclusive.reduce((acc, s) => intersect(acc, s))
      : new Set(universe);
    for (const ex of cheapExclusions) working = subtract(working, ex);
    const durPhaseA = Date.now() - tPhaseA;

    // Phase B: Evaluate expensive topic filters ONLY over the pre-narrowed working scope
    const tPhaseB = Date.now();
    const inclusiveTopics = topicFilters.filter(f => f.op !== 'is_not');
    const exclusionTopics = topicFilters.filter(f => f.op === 'is_not');
    let topicNliPassesSaved = 0;

    // 1. Inclusive topics progressively narrow working set
    for (const f of inclusiveTopics) {
      if (working.size === 0) {
        topicMatchedZero = true;
        notes.push(`topic "${f.value}" matched 0 tabs`);
        break;
      }
      const scopedCands = (candidates || []).filter(c => working.has(c.tabId));
      topicNliPassesSaved += (universe.size - scopedCands.length);
      const ids = new Set((await findByTopic(f.value, scopedCands, { exclude: false })) || []);
      const scoped = intersect(ids, working);
      if (scoped.size === 0) {
        topicMatchedZero = true;
        notes.push(`topic "${f.value}" matched 0 tabs`);
      }
      working = scoped;
    }

    // 2. Exclusion topics run last over the surviving narrowed set (recall-biased)
    for (const f of exclusionTopics) {
      if (working.size === 0) break;
      const scopedCands = (candidates || []).filter(c => working.has(c.tabId));
      topicNliPassesSaved += (universe.size - scopedCands.length);
      const ids = new Set((await findByTopic(f.value, scopedCands, { exclude: true })) || []);
      const scoped = intersect(ids, working);
      working = subtract(working, scoped);
    }
    const durPhaseB = Date.now() - tPhaseB;

    // Phase C: Rank & Destructive protection
    const tPhaseC = Date.now();
    // Rank: keep the N newest/oldest (protect them), act on the remainder.
    for (const rf of rankFilters) working = applyRank(working, rf, { liveTabs, recencyOf, dupGroupsSource });

    // Destructive ops never touch the active tab implicitly (matches the existing
    // resolveTabsFromFilters convention). Non-destructive ops may include it.
    if (DESTRUCTIVE.has(dsl.intent)) {
      const active = liveTabs.find(t => t.active);
      if (active) working.delete(active.id);
    }
    const durPhaseC = Date.now() - tPhaseC;
    const durTotal = Date.now() - tStart;

    const tabIds = [...working];
    const reason = describePlan(dsl) || dsl.intent;
    const perTabReasons = {};
    for (const id of tabIds) perTabReasons[id] = reason;

    // Correction triggers (the ONE self-correction upstream keys on this):
    //  - a positive topic filter matched nothing, OR
    //  - a DESTRUCTIVE plan selected the entire universe (looks like match-all).
    const hasNarrowingFilter =
      cheapInclusive.length > 0 ||
      cheapExclusions.length > 0 ||
      inclusiveTopics.length > 0 ||
      exclusionTopics.length > 0 ||
      rankFilters.length > 0;
    const selectedAllDestructive = DESTRUCTIVE.has(dsl.intent) && !hasNarrowingFilter;
    const needsCorrection = topicMatchedZero || selectedAllDestructive;
    if (selectedAllDestructive) notes.push('destructive plan had no narrowing filter (would match all tabs)');

    const timings = {
      phaseA_cheap_ms: durPhaseA,
      phaseB_topics_ms: durPhaseB,
      phaseC_rank_ms: durPhaseC,
      total_ms: durTotal,
      passesSaved: topicNliPassesSaved
    };

    if (typeof console !== 'undefined' && console.log) {
      console.log(
        `[AgentExecutor] Plan executed in ${durTotal}ms (cheap: ${durPhaseA}ms, topics: ${durPhaseB}ms, rank: ${durPhaseC}ms). ` +
        `Narrowed ${universe.size} -> ${tabIds.length} tabs. Passes saved: ${topicNliPassesSaved}`
      );
    }

    // Confidence: start from the planner's, penalise empty/uncertain outcomes.
    let confidence = Number.isFinite(dsl.confidence) ? dsl.confidence : 0.6;
    if (topicMatchedZero || tabIds.length === 0) confidence = Math.min(confidence, 0.3);

    return {
      intent: dsl.intent,
      tabIds,
      perTabReasons,
      uncertain: [],
      confidence,
      needsCorrection,
      notes,
      action_params: dsl.action_params || {},
      destructive: DESTRUCTIVE.has(dsl.intent),
      reason,
    };
  }

  function applyRank(working, rf, { liveTabs, recencyOf, dupGroupsSource }) {
    const keepNewest = rf.op !== 'keep_oldest';
    const n = rf.value;

    if (rf.scope === 'per_dup_group') {
      // Group the working set by exact url; within each group keep N by recency,
      // act on the rest. Mirrors resolveTabsFromFilters' exact-url dup grouping.
      const urlById = new Map(liveTabs.map(t => [t.id, t.url]));
      const groups = new Map();
      for (const id of working) {
        const u = urlById.get(id) || String(id);
        if (!groups.has(u)) groups.set(u, []);
        groups.get(u).push(id);
      }
      const acted = new Set();
      for (const ids of groups.values()) {
        const sorted = ids.sort((a, b) => keepNewest ? recencyOf(b) - recencyOf(a) : recencyOf(a) - recencyOf(b));
        for (const id of sorted.slice(n)) acted.add(id); // everything past the kept N
      }
      return acted;
    }

    // within_set: keep the N newest/oldest of the whole working set, act on rest.
    const sorted = [...working].sort((a, b) => keepNewest ? recencyOf(b) - recencyOf(a) : recencyOf(a) - recencyOf(b));
    return new Set(sorted.slice(n));
  }

  // For retrieve_open: pull the search query + timeRange + topK straight out of
  // the DSL so the wiring can call RecallTabs/handleRecallTabs without re-parsing.
  function extractRetrieval(dsl) {
    const topic = (dsl.filters || []).find(f => f.type === 'topic' && f.op === 'is');
    const time = (dsl.filters || []).find(f => f.type === 'time');
    return {
      query: topic ? topic.value : '',
      timeRange: time ? time.value : 'anytime',
      topK: (dsl.action_params && dsl.action_params.topK) || 3,
    };
  }

  const AgentExecutor = { executePlan, extractRetrieval, describePlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentExecutor;
  if (typeof self !== 'undefined') self.AgentExecutor = AgentExecutor;
})();
