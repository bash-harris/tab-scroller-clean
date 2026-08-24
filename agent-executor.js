// agent-executor.js

(() => {
  let parseTimeRangeDefault, parseTimeWindowDefault;
  try { ({ parseTimeRange: parseTimeRangeDefault, parseTimeWindow: parseTimeWindowDefault } = require('./recall-tabs.js')); }
  catch {
    parseTimeRangeDefault = (typeof self !== 'undefined' && self.parseTimeRange) || (() => 0);
    parseTimeWindowDefault = (typeof self !== 'undefined' && self.parseTimeWindow) || ((raw, now) => ({ since: parseTimeRangeDefault(raw, now), until: now }));
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
  }

  const DESTRUCTIVE = new Set(['close_tabs']);

  const intersect = (a, b) => new Set([...a].filter(x => b.has(x)));
  const subtract = (a, b) => new Set([...a].filter(x => !b.has(x)));

  function describePlan(dsl) {
    const parts = [];
    const all = dsl.where && dsl.where.all ? dsl.where.all : [];
    const none = dsl.where && dsl.where.none ? dsl.where.none : [];
    
    for (const f of all) {
      if (f.field === 'topic') parts.push(f.value);
      else if (f.field === 'time') {
        const label = f.op === 'older_than' ? 'older than ' : f.op === 'between' ? 'between ' : 'within ';
        parts.push(label + String(f.value).replace(/_/g, ' ') + ' (' + (f.opts && f.opts.basis) + ')');
      }
      else if (f.field === 'domain') parts.push(f.value);
      else if (f.field === 'state') parts.push(f.value);
      else parts.push(`${f.field} ${f.op} ${f.value}`);
    }
    for (const f of none) {
      if (f.field === 'topic') parts.push('not ' + f.value);
      else if (f.field === 'state') parts.push('not ' + f.value);
      else parts.push(`not ${f.field} ${f.op} ${f.value}`);
    }
    if (dsl.dedupe) parts.push('dedupe');
    if (dsl.limit) parts.push(`limit ${dsl.limit}`);
    
    return parts.filter(Boolean).join(' · ');
  }

  async function executePlan(dsl, candidates = [], opts = {}) {
    const notes = [];
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const parseTime = opts.parseTimeRange || parseTimeRangeDefault;
    const parseWindow = opts.parseTimeWindow || parseTimeWindowDefault;
    const findByTopic = opts.findByTopic || (async () => []);
    const getOpenedAt = opts.getOpenedAt || (() => null);
    const getExtractedAt = opts.getExtractedAt || (() => null);

    const liveTabs = Array.isArray(opts.liveTabs) ? opts.liveTabs : [];
    const tabById = new Map(liveTabs.map(t => [t.id, t]));
    const universe = new Set(liveTabs.map(t => t.id));

    const tsForBasis = (id, basis) => {
      const tab = tabById.get(id);
      const accessed = tab && Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null;
      const opened = Number.isFinite(getOpenedAt(id)) ? getOpenedAt(id) : null;
      const extracted = Number.isFinite(getExtractedAt(id)) ? getExtractedAt(id) : null;
      const chain = basis === 'opened' ? [opened, accessed, extracted] : [accessed, opened, extracted];
      for (const v of chain) if (v != null) return v;
      return null;
    };
    
    const recencyOf = (id) => {
      const t = tsForBasis(id, 'accessed');
      return t == null ? 0 : t;
    };

    const tStart = Date.now();
    let topicMatchedZero = false;

    // V2 Boolean Tree Parse
    const allNodes = (dsl.where && Array.isArray(dsl.where.all)) ? dsl.where.all : [];
    const noneNodes = (dsl.where && Array.isArray(dsl.where.none)) ? dsl.where.none : [];

    const cheapIncNodes = allNodes.filter(n => n.field !== 'topic');
    const semanticIncNodes = allNodes.filter(n => n.field === 'topic');
    const cheapExcNodes = noneNodes.filter(n => n.field !== 'topic');
    const semanticExcNodes = noneNodes.filter(n => n.field === 'topic');
    
    const evaluateLeaf = (f) => {
      const set = new Set();
      const val = String(f.value || '').toLowerCase();
      for (const id of universe) {
        const t = tabById.get(id);
        if (!t) continue;
        if (f.field === 'time') {
          const basis = f.opts && f.opts.basis ? f.opts.basis : 'accessed';
          const ts = tsForBasis(id, basis);
          if (ts == null) continue; // an undated tab never matches a time filter
          if (f.op === 'between') {
            const { since, until } = parseWindow(f.value, now);
            if (ts >= since && ts < until) set.add(id);
          } else {
            const boundary = parseTime(f.value, now);
            if (f.op === 'older_than' ? ts < boundary : ts >= boundary) set.add(id);
          }
        } else if (f.field === 'domain') {
          const d = hostOf(t.url);
          if (f.op === 'contains' && d.includes(val)) set.add(id);
          if (f.op === 'equals' && d === val) set.add(id);
        } else if (f.field === 'title') {
           if ((t.title || '').toLowerCase().includes(val)) set.add(id);
        } else if (f.field === 'url') {
           if ((t.url || '').toLowerCase().includes(val)) set.add(id);
        } else if (f.field === 'any_text' || f.field === 'content') {
           const c = candidates.find(cand => cand.tabId === id);
           const text = [t.title, t.url, (c ? c.mainText : '')].join(' ').toLowerCase();
           if (text.includes(val)) set.add(id);
        } else if (f.field === 'state') {
          if (f.value === 'pinned' && !!t.pinned) set.add(id);
          if (f.value === 'audible' && !!t.audible) set.add(id);
          if (f.value === 'muted' && !!t.muted) set.add(id);
        } else if (f.field === 'duplicate') {
          // not handled as leaf in v2, but just in case
        }
      }
      return set;
    };

    const tPhaseA = Date.now();
    let working = new Set(universe);
    let hasNarrowing = false;

    // 1. include, cheap
    for (const f of cheapIncNodes) {
      hasNarrowing = true;
      working = intersect(working, evaluateLeaf(f));
    }
    const durPhaseA = Date.now() - tPhaseA;

    // 2. include, semantic
    const tPhaseB = Date.now();
    let topicNliPassesSaved = 0;
    
    for (const f of semanticIncNodes) {
      hasNarrowing = true;
      if (working.size === 0) {
        topicMatchedZero = true;
        break;
      }
      const scopedCands = candidates.filter(c => working.has(c.tabId));
      topicNliPassesSaved += (universe.size - scopedCands.length);
      const ids = new Set((await findByTopic(f.value, scopedCands, { exclude: false })) || []);
      working = intersect(working, ids);
      if (working.size === 0) topicMatchedZero = true;
    }

    // 3. exclude, cheap
    for (const f of cheapExcNodes) {
      hasNarrowing = true;
      if (working.size === 0) break;
      working = subtract(working, evaluateLeaf(f));
    }

    // 4. exclude, semantic (runs unconditionally over remaining set)
    for (const f of semanticExcNodes) {
      hasNarrowing = true;
      if (working.size === 0) break;
      const scopedCands = candidates.filter(c => working.has(c.tabId));
      topicNliPassesSaved += (universe.size - scopedCands.length);
      const ids = new Set((await findByTopic(f.value, scopedCands, { exclude: true })) || []);
      working = subtract(working, ids);
    }
    const durPhaseB = Date.now() - tPhaseB;

    // Phase C: Dedupe -> order_by -> limit
    const tPhaseC = Date.now();
    
    if (dsl.dedupe) {
       hasNarrowing = true;
       // Let's mirror v1 logic for duplicates:
       // In v1: duplicates filter added ONLY tabs with count > 1. Then rank protected the N kept.
       // So working = only tabs that are duplicates.
       const dupGroups = new Map();
       for (const t of liveTabs) if (t.url) dupGroups.set(t.url, (dupGroups.get(t.url) || 0) + 1);
       const allDupes = new Set(liveTabs.filter(t => t.url && dupGroups.get(t.url) > 1).map(t => t.id));
       working = intersect(working, allDupes);
       
       const urlById = new Map(liveTabs.map(t => [t.id, t.url]));
       
       // Now keep one per group and ACT on the rest
       const acted = new Set();
       const grouped = new Map();
       for (const id of working) {
         const u = urlById.get(id);
         if (!grouped.has(u)) grouped.set(u, []);
         grouped.get(u).push(id);
       }
       const keepNewestRank = dsl.dedupe.keep !== 'oldest';
       const limit = dsl.limit || 1;
       for (const ids of grouped.values()) {
         const sorted = ids.sort((a, b) => keepNewestRank ? recencyOf(b) - recencyOf(a) : recencyOf(a) - recencyOf(b));
         for (const id of sorted.slice(limit)) acted.add(id); // act on everything past the limit
       }
       working = acted;
    } else if (dsl.order_by && dsl.order_by.length > 0 && dsl.limit != null) {
       hasNarrowing = true;
       const limit = dsl.limit;
       const keepNewest = dsl.order_by[0].dir !== 'asc'; // 'desc' means newest first
       const sorted = [...working].sort((a, b) => keepNewest ? recencyOf(b) - recencyOf(a) : recencyOf(a) - recencyOf(b));
       
       // Protect the top `limit` items, ACT on the rest
       working = new Set(sorted.slice(limit));
    } else if (dsl.limit != null) {
        // Just limit the result set for positive actions (like retrieve_open)
        // Wait, if DESTRUCTIVE we act on the remainder? 
        // If it's a positive action (e.g. open/group), limit restricts the matched set.
        hasNarrowing = true;
        if (!DESTRUCTIVE.has(dsl.intent)) {
            const sorted = [...working].sort((a, b) => recencyOf(b) - recencyOf(a));
            working = new Set(sorted.slice(0, dsl.limit));
        } else {
            const sorted = [...working].sort((a, b) => recencyOf(b) - recencyOf(a));
            working = new Set(sorted.slice(dsl.limit));
        }
    }

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

    const selectedAllDestructive = DESTRUCTIVE.has(dsl.intent) && !hasNarrowing;
    const needsCorrection = topicMatchedZero || selectedAllDestructive;
    if (selectedAllDestructive) notes.push('destructive plan had no narrowing filter (would match all tabs)');

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
      action_params: dsl.params || {},
      destructive: DESTRUCTIVE.has(dsl.intent),
      reason,
      timings: {
        phaseA_cheap_ms: durPhaseA,
        phaseB_topics_ms: durPhaseB,
        phaseC_ms: durPhaseC,
        passesSaved: topicNliPassesSaved,
      },
    };
  }

  function extractRetrieval(dsl) {
    const topic = ((dsl.where && dsl.where.all) || []).find(f => f.field === 'topic');
    const time = ((dsl.where && dsl.where.all) || []).find(f => f.field === 'time');
    return {
      query: topic ? topic.value : '',
      timeRange: time ? time.value : 'anytime',
      // Pass op + basis through instead of dropping them (an older_than/between
      // retrieval was previously flattened into a plain "within").
      timeOp: time ? (time.op || 'within') : 'within',
      timeBasis: time && time.opts ? time.opts.basis : undefined,
      topK: (dsl.params && dsl.params.topK) || 3,
    };
  }

  const AgentExecutor = { executePlan, extractRetrieval, describePlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentExecutor;
  if (typeof self !== 'undefined') self.AgentExecutor = AgentExecutor;
})();
