// agent-planner.js
// LAYER 1 of the bounded tool-calling agent: compile a COMPLEX command into a
// "Filter Plan" -- a small, validated DSL the executor turns into primitive
// calls. This is the only place a model is used on the complex path, and it is
// used for exactly the three things a model is good at and a parser is not:
// reading typos, supplying world knowledge, and stripping filler from a topic
// (the same argument llm-query.js makes for the simple path).
//
// STRUCTURAL ANTI-HALLUCINATION. The planner sees ONLY the user's typed command,
// never a tab title, url, or body. It emits FILTERS, never tab ids -- the
// executor resolves ids from live chrome.tabs. A model that never sees a tab
// cannot invent one, and a plan that carries no ids cannot smuggle one in. This
// is why the injection-safety property holds without a "treat content as data"
// incantation in the prompt.
//
// FAILURE CHAIN (user instruction): Gemini -> Ollama -> regex. On ANY Gemini
// failure (network, rate-limit, malformed JSON, or a plan that fails validate())
// the planner immediately retries on local Ollama, then degrades to a
// deterministic regex planner. Ollama is a *functional* fallback: it still
// produces a real plan offline, so precision degrades but capability does not.
// The regex tier is the floor -- it always returns a usable plan.

(() => {
  const CACHE_KEY = 'agentPlanCache';
  const CACHE_MAX = 300;
  const TIMEOUT_MS = 45000;

  // recall-tabs owns the single source of truth for what time expressions exist,
  // so validate() rejects anything it can't resolve rather than guessing.
  let isKnownTimeExpr;
  try { ({ isKnownTimeExpr } = require('./recall-tabs.js')); }
  catch { isKnownTimeExpr = (typeof self !== 'undefined' && self.isKnownTimeExpr) || (() => true); }

  const INTENTS = new Set([
    'close_tabs', 'group_tabs', 'bookmark_tabs', 'pin_tabs', 'unpin_tabs',
    'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs', 'retrieve_open'
  ]);
  const DESTRUCTIVE = new Set(['close_tabs']);

  // Same normalization as llm-query.js so the two caches partition cleanly and a
  // command hits whichever cache its complexity routed it to, punctuation-stable.
  function normalizeCommand(cmd) {
    return String(cmd || '').toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const SYSTEM = `You convert a browser-tab command into a JSON "filter plan". You NEVER see the tabs, only the user's typed command. Return ONLY the JSON object, no prose.

Shape:
{"intent":"<intent>","filters":[<filter>,...],"combine":"all","action_params":{},"confidence":0.0-1.0}

intent is exactly one of: close_tabs, group_tabs, bookmark_tabs, pin_tabs, unpin_tabs, mute_tabs, unmute_tabs, reload_tabs, sort_tabs, retrieve_open

Each filter is exactly one of:
{"type":"topic","op":"is"|"is_not","value":"<what the tab is ABOUT>"}
{"type":"time","op":"within"|"older_than","value":"<range>","basis":"opened"|"accessed"}
{"type":"domain","op":"equals","value":"<host like youtube.com>"}
{"type":"state","op":"is"|"is_not","value":"pinned"|"audible"|"muted"}
{"type":"duplicates","op":"is","value":true}
{"type":"rank","op":"keep_newest"|"keep_oldest","value":<positive int>,"scope":"within_set"|"per_dup_group"}

Rules:
- topic: the SUBJECT only, verbs and filler stripped. Fix typos.
- op meaning: topic/state "is" keeps matches, "is_not" EXCLUDES matches (the "except" clause). time "within" = inside the range, "older_than" = before the range.
- time.value MUST be one of: today, yesterday, this_week, last_week, this_month, last_hour, or "N_days"/"N_hours"/"N_weeks" (e.g. "3_days"). NEVER invent another range.
- time.basis: "opened" when the user says opened/from/created ("tabs from yesterday", "opened this week"); "accessed" when they say looked at/used/viewed/active/touched ("haven't looked at in an hour"). If unsure, "accessed".
- rank: "keep the 5 newest" -> keep_newest 5 scope within_set. "keep the one I used most recently" over duplicates -> keep_newest 1 scope per_dup_group.
- action_params keys (include ONLY when implied): groupName, color, folderName, closeAfterBookmark (true for "bookmark then close"), sortBy, order, topK ("the most relevant"/"open it" -> 1).
- retrieve_open: for "find the tab where ... and open it" / "reopen". Put what to find as a topic filter.
- At most 5 filters. NEVER output tab ids. confidence = how sure you are.

Examples:
"Close all shopping tabs from yesterday except the ones with gardening equipment" -> {"intent":"close_tabs","filters":[{"type":"topic","op":"is","value":"shopping"},{"type":"time","op":"within","value":"yesterday","basis":"opened"},{"type":"topic","op":"is_not","value":"gardening equipment"}],"combine":"all","action_params":{},"confidence":0.9}
"Close every YouTube tab I haven't looked at in the last hour" -> {"intent":"close_tabs","filters":[{"type":"domain","op":"equals","value":"youtube.com"},{"type":"time","op":"older_than","value":"last_hour","basis":"accessed"}],"combine":"all","action_params":{},"confidence":0.9}
"Keep only my 5 most recently used research tabs, close the rest" -> {"intent":"close_tabs","filters":[{"type":"topic","op":"is","value":"research"},{"type":"rank","op":"keep_newest","value":5,"scope":"within_set"}],"combine":"all","action_params":{},"confidence":0.85}
"Close duplicate tabs but keep the one I used most recently" -> {"intent":"close_tabs","filters":[{"type":"duplicates","op":"is","value":true},{"type":"rank","op":"keep_newest","value":1,"scope":"per_dup_group"}],"combine":"all","action_params":{},"confidence":0.9}
"Mute every tab playing sound except my music tab" -> {"intent":"mute_tabs","filters":[{"type":"state","op":"is","value":"audible"},{"type":"topic","op":"is_not","value":"music"}],"combine":"all","action_params":{},"confidence":0.9}
"Close everything older than 3 days except pinned tabs" -> {"intent":"close_tabs","filters":[{"type":"time","op":"older_than","value":"3_days","basis":"accessed"},{"type":"state","op":"is_not","value":"pinned"}],"combine":"all","action_params":{},"confidence":0.9}
"Bookmark the recipe tabs I opened this week, then close them" -> {"intent":"bookmark_tabs","filters":[{"type":"topic","op":"is","value":"recipe"},{"type":"time","op":"within","value":"this_week","basis":"opened"}],"combine":"all","action_params":{"closeAfterBookmark":true},"confidence":0.9}
"Group the news articles I opened this morning" -> {"intent":"group_tabs","filters":[{"type":"topic","op":"is","value":"news"},{"type":"time","op":"within","value":"today","basis":"opened"}],"combine":"all","action_params":{"groupName":"News"},"confidence":0.85}
"Find the tab where I was comparing noise-cancelling headphones and open it" -> {"intent":"retrieve_open","filters":[{"type":"topic","op":"is","value":"noise cancelling headphones comparison"}],"combine":"all","action_params":{"topK":1},"confidence":0.85}
"Find my laptop-research tabs from last week and reopen the most relevant" -> {"intent":"retrieve_open","filters":[{"type":"topic","op":"is","value":"laptop research"},{"type":"time","op":"within","value":"last_week","basis":"opened"}],"combine":"all","action_params":{"topK":1},"confidence":0.8}`;

  // -------- validation (mirror llm-query.js:77-109; any violation -> null) --------
  // A half-parsed plan is worse than falling through to the next tier, so this is
  // strict on the load-bearing fields (intent, filter type/op, time resolvability,
  // positive rank) and forgiving-with-defaults on the rest.
  function validateFilter(f) {
    if (!f || typeof f !== 'object') return null;
    switch (f.type) {
      case 'topic': {
        const v = typeof f.value === 'string' ? f.value.trim().toLowerCase() : '';
        if (!v) return null;
        return { type: 'topic', op: f.op === 'is_not' ? 'is_not' : 'is', value: v };
      }
      case 'time': {
        const v = typeof f.value === 'string' ? f.value.trim().toLowerCase() : '';
        if (!isKnownTimeExpr(v)) return null; // never guess an unparseable range
        return {
          type: 'time',
          op: f.op === 'older_than' ? 'older_than' : 'within',
          value: v,
          basis: f.basis === 'opened' ? 'opened' : 'accessed',
        };
      }
      case 'domain': {
        const v = typeof f.value === 'string' ? f.value.trim().toLowerCase() : '';
        if (!/\w\.\w/.test(v)) return null;
        return { type: 'domain', op: 'equals', value: v };
      }
      case 'state': {
        if (!['pinned', 'audible', 'muted'].includes(f.value)) return null;
        return { type: 'state', op: f.op === 'is_not' ? 'is_not' : 'is', value: f.value };
      }
      case 'duplicates':
        return { type: 'duplicates', op: 'is', value: true };
      case 'rank': {
        const n = Number(f.value);
        if (!Number.isInteger(n) || n < 1) return null;
        return {
          type: 'rank',
          op: f.op === 'keep_oldest' ? 'keep_oldest' : 'keep_newest',
          value: n,
          scope: f.scope === 'per_dup_group' ? 'per_dup_group' : 'within_set',
        };
      }
      default:
        return null;
    }
  }

  function validateActionParams(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.groupName === 'string') out.groupName = raw.groupName.slice(0, 40);
    if (typeof raw.color === 'string') out.color = raw.color.toLowerCase();
    if (typeof raw.folderName === 'string') out.folderName = raw.folderName.slice(0, 60);
    if (raw.closeAfterBookmark === true) out.closeAfterBookmark = true;
    if (typeof raw.sortBy === 'string') out.sortBy = raw.sortBy;
    if (typeof raw.order === 'string') out.order = raw.order;
    const topK = Number(raw.topK);
    if (Number.isInteger(topK) && topK >= 1) out.topK = Math.min(topK, 10);
    return out;
  }

  function validate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!INTENTS.has(raw.intent)) return null;

    const rawFilters = Array.isArray(raw.filters) ? raw.filters.slice(0, 5) : [];
    const filters = [];
    for (const f of rawFilters) {
      const v = validateFilter(f);
      if (!v) return null; // one bad filter invalidates the plan -> next tier
      filters.push(v);
    }

    const conf = Number(raw.confidence);
    return {
      intent: raw.intent,
      filters,
      combine: 'all', // only supported mode; positives intersect, exclusions subtract
      action_params: validateActionParams(raw.action_params),
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.7,
      destructive: DESTRUCTIVE.has(raw.intent),
    };
  }

  // -------- cache (reuse chrome.storage.local, distinct key from llm-query) ------
  async function readCache() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return {};
      return await new Promise(r => chrome.storage.local.get({ [CACHE_KEY]: {} }, i => r(i[CACHE_KEY] || {})));
    } catch { return {}; }
  }
  async function writeCache(cache) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        const sorted = keys.sort((a, b) => (cache[a]._t || 0) - (cache[b]._t || 0));
        for (const k of sorted.slice(0, Math.floor(keys.length / 2))) delete cache[k];
      }
      await new Promise(r => chrome.storage.local.set({ [CACHE_KEY]: cache }, r));
    } catch { /* cache is an optimisation, never a requirement */ }
  }

  // -------- model call + failure detection --------
  // A uniform contract: callModel(system, prompt, timeout) -> string. The wiring
  // layer adapts callGemini (returns text | "Error: ..." string) and callOllama
  // ({text} | throws) into this shape. Returns a VALIDATED plan or null so the
  // chain can advance; a validate() failure is treated exactly like a call
  // failure -- both mean "this tier did not give us a usable plan".
  async function tryModel(fn, prompt) {
    if (typeof fn !== 'function') return null;
    let text;
    try { text = await fn(SYSTEM, prompt, TIMEOUT_MS); }
    catch (e) { console.warn('[AgentPlanner] model call threw:', e && e.message); return null; }
    if (!text || typeof text !== 'string') return null;
    if (/^\s*error\s*:/i.test(text)) return null; // callGemini stringifies errors
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch { return null; }
    return validate(obj);
  }

  /**
   * Build a Filter Plan for a complex command.
   *
   * opts.callGemini  async (system, prompt, timeout) -> string   (tier 1, injected)
   * opts.callOllama  async (system, prompt, timeout) -> string   (tier 2, injected)
   * opts.signals     string[] from AgentRouter (primes the regex floor)
   * opts.noCache     skip the cache (bench/tests)
   *
   * Always resolves to a validated plan with `.source` in
   * {gemini, ollama, regex, cache}. Never rejects, never returns null.
   */
  async function buildFilterPlan(cmd, opts = {}) {
    const signals = Array.isArray(opts.signals) ? opts.signals : [];
    const key = normalizeCommand(cmd);
    // On a self-correction pass the executor tells us what went wrong (e.g. a
    // topic matched 0 tabs); we append it so the model can broaden. A correction
    // pass also bypasses the cache so it can actually produce a different plan.
    const hint = typeof opts.correctionHint === 'string' && opts.correctionHint.trim()
      ? `\nThe previous attempt failed: ${opts.correctionHint.trim()}. Adjust the plan (broaden topics or drop an over-narrow filter).`
      : '';
    const prompt = `Command: "${cmd}"${hint}`;
    const skipCache = opts.noCache || !!hint;

    let cache = null;
    if (!skipCache && key) {
      cache = await readCache();
      if (cache[key]) return { ...cache[key].p, source: 'cache' };
    }

    let plan = await tryModel(opts.callGemini, prompt);
    let source = 'gemini';
    if (!plan) { plan = await tryModel(opts.callOllama, prompt); source = 'ollama'; }
    if (!plan) { plan = buildRegexPlan(cmd, signals); source = 'regex'; }

    plan.source = source;

    // Only persist model-derived plans: caching a regex plan would prevent a
    // later online run from upgrading it, and the regex tier is cheap to redo.
    if (!skipCache && cache && (source === 'gemini' || source === 'ollama')) {
      cache[key] = { p: plan, _t: Date.now() };
      await writeCache(cache);
    }
    return plan;
  }

  // ================= DETERMINISTIC REGEX FLOOR =================
  // The last-resort tier: Gemini and Ollama both unavailable. Its job is to
  // return *a usable* plan, not a perfect one -- topic precision is exactly the
  // thing the model tiers add, so a crude topic here is expected and documented.
  function detectIntent(s, signals) {
    if (signals.includes('find_open') || /\bre-?open\b/.test(s)) return 'retrieve_open';
    if (/\bunpin\b/.test(s)) return 'unpin_tabs';
    if (/\bpin\b/.test(s)) return 'pin_tabs';
    if (/\bunmute\b/.test(s)) return 'unmute_tabs';
    if (/\bmute\b/.test(s)) return 'mute_tabs';
    if (/\b(bookmark|save)\b/.test(s)) return 'bookmark_tabs';
    if (/\b(group|cluster|organi[sz]e)\b/.test(s)) return 'group_tabs';
    if (/\b(reload|refresh)\b/.test(s)) return 'reload_tabs';
    if (/\bsort\b/.test(s)) return 'sort_tabs';
    if (/\b(close|remove|clear|kill|delete|get rid of)\b/.test(s)) return 'close_tabs';
    return 'group_tabs'; // safest default: non-destructive, always previews
  }

  const BRAND_HOSTS = {
    youtube: 'youtube.com', twitter: 'twitter.com', reddit: 'reddit.com',
    amazon: 'amazon.com', github: 'github.com', netflix: 'netflix.com',
    facebook: 'facebook.com', instagram: 'instagram.com', linkedin: 'linkedin.com',
  };
  function detectDomain(s) {
    const explicit = s.match(/\b([a-z0-9-]+\.(?:com|net|org|io|co|tv|gov|edu|dev))\b/);
    if (explicit) return explicit[1];
    for (const [brand, host] of Object.entries(BRAND_HOSTS)) {
      if (new RegExp(`\\b${brand}\\b`).test(s)) return host;
    }
    return null;
  }

  function extractTimeValue(s) {
    const m = s.match(/(\d+)\s*[_ ]?(minute|min|hour|hr|day|week)s?/);
    if (m) {
      const u = { minute: 'minutes', min: 'minutes', hour: 'hours', hr: 'hours', day: 'days', week: 'weeks' }[m[2]];
      return `${m[1]}_${u}`;
    }
    if (/\b(last|past) hour\b/.test(s)) return 'last_hour';
    if (/\byesterday\b|\blast night\b/.test(s)) return 'yesterday';
    if (/\b(this morning|this afternoon|this evening|tonight|today|earlier today)\b/.test(s)) return 'today';
    if (/\bthis week\b/.test(s)) return 'this_week';
    if (/\blast week\b/.test(s)) return 'last_week';
    if (/\bthis month\b/.test(s)) return 'this_month';
    if (/\blast month\b/.test(s)) return 'last_month';
    return null;
  }

  function detectTimeFilter(s) {
    const value = extractTimeValue(s);
    if (!value) return null;
    const olderThan =
      /\bolder than\b/.test(s) ||
      /\bhaven'?t\b[\s\S]*\bin (?:the )?(?:last|past)\b/.test(s) ||
      /\bnot (?:looked|touched|used|opened|visited)[\s\S]*\bin (?:the )?(?:last|past)\b/.test(s);
    const opened = /\b(opened|from|created)\b/.test(s) && !/\b(looked at|used|viewed|active|touched)\b/.test(s);
    return { type: 'time', op: olderThan ? 'older_than' : 'within', value, basis: opened ? 'opened' : 'accessed' };
  }

  function detectStates(seg) {
    const out = [];
    if (/\bplaying (?:sound|audio|music)\b/.test(seg) || /\bmaking (?:noise|sound)\b/.test(seg) || /\baudible\b/.test(seg)) out.push('audible');
    if (/\bmuted\b/.test(seg)) out.push('muted');
    if (/\bpinned\b/.test(seg)) out.push('pinned');
    return out;
  }

  function detectRankFilter(s) {
    let m = s.match(/\b(\d+)\s+(?:most\s+recent(?:ly)?(?:\s+used)?|newest|latest|most\s+used)\b/);
    if (m) return { type: 'rank', op: 'keep_newest', value: parseInt(m[1], 10), scope: 'within_set' };
    m = s.match(/\b(\d+)\s+oldest\b/);
    if (m) return { type: 'rank', op: 'keep_oldest', value: parseInt(m[1], 10), scope: 'within_set' };
    m = s.match(/\bkeep\s+(?:only\s+)?(?:my\s+)?(?:the\s+)?(\d+)\b/);
    if (m) return { type: 'rank', op: 'keep_newest', value: parseInt(m[1], 10), scope: 'within_set' };
    return null;
  }

  // Filler/structural words removed before whatever remains is treated as topic.
  // Note: audio/state words (playing, sound, noise, ...) are deliberately NOT here
  // -- detectStates() already blocks state segments from producing a topic, and
  // stripping "noise" would corrupt real topics like "noise-cancelling headphones".
  const TOPIC_STRIP = /\b(close|remove|clear|kill|delete|group|cluster|organi[sz]e|bookmark|save|pin|unpin|mute|unmute|reload|refresh|sort|open|re-?open|find|locate|switch|keep|only|my|the|a|an|all|every|everything|else|rest|tab|tabs|page|pages|article|articles|from|of|with|about|than|that|which|where|when|i|me|was|were|am|been|being|have|has|had|do|did|then|them|it|and|but|or|to|in|on|for|no|not|dont|please|show|opened|looked|at|used|viewed|active|touched|seen|recent|recently|most|least|relevant|new|newest|old|older|oldest|duplicate|duplicates|dupes?|pinned|muted|audible|hour|hours|day|days|week|weeks|minute|minutes|month|months|ago|yesterday|today|tonight|this|last|past|night|morning|afternoon|evening|ones?)\b/g;

  function extractTopic(seg) {
    const t = String(seg || '')
      .replace(TOPIC_STRIP, ' ')
      .replace(/\d+/g, ' ')
      .replace(/[^a-z0-9\s.-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length >= 2 ? t : null;
  }

  const EXCEPTION_SPLIT = /\b(?:except(?:\s+for)?|excluding|other than|apart from|aside from|but not|but keep|besides)\b/;

  function buildRegexPlan(cmd, signals = []) {
    const s = String(cmd || '').toLowerCase();
    const intent = detectIntent(s, signals);
    const filters = [];
    const action_params = {};

    // Split head (inclusion) from an "except ..." tail (exclusion).
    const parts = s.split(EXCEPTION_SPLIT);
    const head = parts[0];
    const tail = parts.length > 1 ? parts.slice(1).join(' ') : '';

    if (intent === 'retrieve_open') action_params.topK = 1;
    if (/\b(bookmark|save)\b/.test(s) && /\b(then|and)\b[\s\S]*\bclose\b/.test(s)) action_params.closeAfterBookmark = true;

    // TIME (may live in head or tail; direction/basis inferred from full string).
    const t = detectTimeFilter(s);
    if (t) filters.push(t);

    // DOMAIN (inclusion side only).
    const dom = detectDomain(head);
    if (dom) filters.push({ type: 'domain', op: 'equals', value: dom });

    // DUPLICATES.
    if (/\bduplicates?\b|\bdupes?\b/.test(s)) {
      filters.push({ type: 'duplicates', op: 'is', value: true });
      if (/\bkeep\b[\s\S]*\b(one|most recent|recently)\b/.test(s)) {
        filters.push({ type: 'rank', op: 'keep_newest', value: 1, scope: 'per_dup_group' });
      }
    }

    // STATE (inclusion in head, exclusion in tail).
    for (const st of detectStates(head)) filters.push({ type: 'state', op: 'is', value: st });
    for (const st of detectStates(tail)) filters.push({ type: 'state', op: 'is_not', value: st });

    // RANK (unless already added as a per-dup-group keep).
    if (!filters.some(f => f.type === 'rank')) {
      const rk = detectRankFilter(s);
      if (rk) filters.push(rk);
    }

    // TOPIC last: whatever remains after structural words are stripped. Skip a
    // segment that only described state (e.g. "playing sound") to avoid a bogus
    // topic filter competing with the state filter we already added.
    if (!dom && !detectStates(head).length) {
      const topic = extractTopic(head);
      if (topic) filters.push({ type: 'topic', op: 'is', value: topic });
    }
    if (tail && !detectStates(tail).length) {
      const extopic = extractTopic(tail);
      if (extopic) filters.push({ type: 'topic', op: 'is_not', value: extopic });
    }

    return {
      intent,
      filters: filters.slice(0, 5),
      combine: 'all',
      action_params: validateActionParams(action_params),
      confidence: 0.4, // deliberately low: the floor tier is a safety net, not a peer
      destructive: DESTRUCTIVE.has(intent),
    };
  }

  async function parseMultiGroupCommand(cleanCommand, { callGemini, callOllama } = {}) {
    const system = `You extract multi-group target definitions and optional domain/search restrictions from a browser tab command.
Return ONLY a valid JSON object:
{
  "restrict": "optional domain or filter keyword, e.g. youtube.com or github.com (or null)",
  "buckets": [
    { "name": "Group Name", "characteristic": "short description of tabs belonging in this group" }
  ]
}
No markdown, no prose.`;

    const prompt = `Command: "${cleanCommand}"`;

    let text = null;
    if (typeof callGemini === 'function') {
      try {
        const res = await callGemini(system, prompt);
        text = (typeof res === 'string') ? res : (res && res.text);
      } catch (e) {}
    }
    if (!text && typeof callOllama === 'function') {
      try {
        const res = await callOllama(system, prompt);
        text = (typeof res === 'string') ? res : (res && res.text);
      } catch (e) {}
    }

    if (text) {
      try {
        let clean = text.trim();
        const m = clean.match(/\{[\s\S]*\}/);
        if (m) clean = m[0];
        const parsed = JSON.parse(clean);
        if (parsed && Array.isArray(parsed.buckets) && parsed.buckets.length > 0) {
          return {
            restrict: parsed.restrict || null,
            buckets: parsed.buckets.map(b => ({
              name: String(b.name || 'Group').trim(),
              characteristic: String(b.characteristic || b.name || '').trim()
            }))
          };
        }
      } catch (e) {}
    }

    // Regex fallback
    let restrict = null;
    if (/\byoutube\b/i.test(cleanCommand)) restrict = 'youtube.com';
    else if (/\bgithub\b/i.test(cleanCommand)) restrict = 'github.com';
    else if (/\brecipes?\b/i.test(cleanCommand)) restrict = 'recipe';

    const groupMatch = cleanCommand.match(/groups?\s*[:-]\s*(.+)$/i) || cleanCommand.match(/into\s+(.+)$/i);
    if (groupMatch) {
      const raw = groupMatch[1].replace(/\b(based\s+on.*|other\s+based.*|videos?|tabs?)\b/gi, '').trim();
      const parts = raw.split(/[,;&]|\s+and\s+|\s+/i)
        .map(p => p.trim())
        .filter(p => p.length > 1 && !['the', 'all', 'main', 'my', 'and', 'in', 'of', 'for'].includes(p.toLowerCase()));
      if (parts.length > 0) {
        return {
          restrict,
          buckets: parts.map(p => ({
            name: p[0].toUpperCase() + p.slice(1),
            characteristic: p
          }))
        };
      }
    }

    return null;
  }

  const AgentPlanner = {
    buildFilterPlan, validate, buildRegexPlan, parseMultiGroupCommand, normalizeCommand, SYSTEM, INTENTS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentPlanner;
  if (typeof self !== 'undefined') self.AgentPlanner = AgentPlanner;
})();
