// agent-planner.js
// LAYER 1 of the bounded tool-calling agent: compile a COMPLEX command into a
// "Filter Plan" -- a small, validated DSL the executor turns into primitive
// calls.

(() => {
  // Bumped to _v2 when the plan shape moved from a flat {filters:[{type,op,value}]}
  // array to the V2 boolean tree {where:{all,none}} that executePlan reads. Old
  // entries persist in chrome.storage.local across upgrades; reading a flat plan
  // through the V2 executor finds no narrowing nodes and selects the ENTIRE window
  // (e.g. "group amazon except cooking" grouped all 508 tabs). Namespacing the key
  // abandons the stale blob wholesale; the shape guard in buildFilterPlan is the
  // per-entry backstop.
  const CACHE_KEY = 'agentPlanCache_v2';
  const CACHE_MAX = 300;
  const TIMEOUT_MS = 45000;

  let isKnownTimeExpr;
  try { ({ isKnownTimeExpr } = require('./recall-tabs.js')); }
  catch { isKnownTimeExpr = (typeof self !== 'undefined' && self.isKnownTimeExpr) || (() => true); }

  const INTENTS = new Set([
    'close_tabs', 'group_tabs', 'group_multi', 'bookmark_tabs', 'pin_tabs', 'unpin_tabs',
    'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs', 'retrieve_open', 'open_tabs',
    'clarify'
  ]);
  const DESTRUCTIVE = new Set(['close_tabs']);

  const EXCEPT_RE = /\b(except(?:\s+for)?|excluding|other than|apart from|aside from|but not|not including|besides|minus|without|unless|save for|leaving out|skip(?:ping)?|ignore|don'?t\s+(?:include|touch))\b/i;

  // ---- TOOL-CALL SCHEMA V3 (multi-step) -------------------------------------
  // A plan may carry up to MAX_STEPS sequential steps. Single-intent commands
  // compile to steps:[{...}] while the flat V2 fields (intent/where/params)
  // stay on the plan for backward compatibility: every existing reader of the
  // flat shape keeps working, and executeSteps treats a 1-step array exactly
  // like executePlan treats the flat plan.
  const MAX_STEPS = 3;

  // Per-step selection dimensions beyond include/exclude: relationship
  // (opener-chain), position (window/pool positional), groupScope (tab group).
  // Closed enums per field; a bad value drops the whole predicate, never half.
  function validateV3Predicate(f) {
    if (!f || typeof f !== 'object') return null;
    const opts = f.opts || {};
    switch (f.field) {
      case 'relationship': {
        const ref = String(f.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!ref) return null;
        return { field: 'relationship', op: 'opener_of', value: ref, opts: { chain: opts.chain === true } };
      }
      case 'position': {
        const n = Number(f.value);
        if (!Number.isInteger(n) || n < 1 || n > 100) return null;
        const from = opts.from === 'end' ? 'end' : 'start';
        return { field: 'position', op: 'from', value: n, opts: { from } };
      }
      case 'groupScope': {
        const kind = opts.kind === 'color' ? 'color' : 'name';
        const v = String(f.value || '').trim();
        if (!v || v.length > 40) return null;
        return { field: 'groupScope', op: 'is', value: v.toLowerCase(), opts: { kind } };
      }
      default:
        return validatePredicate(f);
    }
  }

  // Validate one model-emitted step: {intent, include[], exclude[], slots{},
  // carry}. Returns the executor-shaped step {intent, where, params, carry},
  // or null when the step is unusable. Unknown selection dimensions in
  // slots{} (relationship/position/groupScope) compile into include[]
  // predicates so the executor's set algebra sees one uniform tree.
  function validateStep(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!INTENTS.has(raw.intent)) return null;
    const include = (Array.isArray(raw.include) ? raw.include : []).map(validateV3Predicate).filter(Boolean);
    const exclude = (Array.isArray(raw.exclude) ? raw.exclude : []).map(validateV3Predicate).filter(Boolean);

    // slots{}: relationship/position/groupScope from the parser's step
    // schema, validated through the same closed-enum discipline.
    const slots = (raw.slots && typeof raw.slots === 'object') ? raw.slots : {};
    if (slots.relationship && typeof slots.relationship === 'object' && slots.relationship.openerOf != null) {
      const phrase = String(slots.relationship.openerOf).trim().replace(/\s+/g, ' ');
      if (phrase && phrase.length <= 60) {
        include.push({ field: 'relationship', op: 'opener_of', value: phrase, opts: { chain: slots.relationship.chain === true } });
      }
    }
    if (slots.position && typeof slots.position === 'object') {
      const n = Number(slots.position.n);
      const from = slots.position.from === 'end' ? 'end' : slots.position.from === 'start' ? 'start' : null;
      if (from && Number.isInteger(n) && n >= 1 && n <= 100) {
        include.push({ field: 'position', op: 'from', value: n, opts: { from } });
      }
    }
    if (slots.groupScope && typeof slots.groupScope === 'object') {
      const name = slots.groupScope.name != null ? String(slots.groupScope.name).trim() : null;
      const color = slots.groupScope.color != null ? String(slots.groupScope.color).trim().toLowerCase() : null;
      if (name && name.length <= 40) include.push({ field: 'groupScope', op: 'is', value: name.toLowerCase(), opts: { kind: 'name' } });
      else if (color && ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(color)) {
        include.push({ field: 'groupScope', op: 'is', value: color, opts: { kind: 'color' } });
      }
    }

    // Reuse the V2 compiler per step so dedupe/order_by/limit folding and
    // param sanitization stay identical to single-intent plans. _v3 keeps the
    // relationship/position/groupScope predicates from being stripped.
    const stepPlan = buildV2Schema({ _v3: true, intent: raw.intent, include, exclude, action_params: raw.action_params, confidence: raw.confidence });
    return {
      intent: stepPlan.intent,
      where: stepPlan.where,
      dedupe: stepPlan.dedupe,
      order_by: stepPlan.order_by,
      limit: stepPlan.limit,
      params: stepPlan.params,
      carry: raw.carry === true,
      destructive: DESTRUCTIVE.has(raw.intent),
    };
  }

  // Compile a raw model output into plan.steps. Accepts:
  //   raw.steps: [{intent, include[], exclude[], slots{}, carry, action_params}]  (chained)
  // and compiles every validated step. Returns null when no step survives.
  function validateSteps(raw) {
    if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) return null;
    const steps = raw.steps.slice(0, MAX_STEPS).map(validateStep).filter(Boolean);
    return steps.length ? steps : null;
  }

  function normalizeCommand(cmd) {
    return String(cmd || '').toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const SYSTEM = `You convert a browser-tab command into a JSON "filter plan". You NEVER see the tabs, only the user's typed command. Return ONLY the JSON object, no prose.

Shape:
{"intent":"<intent>","include":[<pred>,...],"exclude":[<pred>,...],"exception_span":"<verbatim exception string or null>","confidence":0.0-1.0}

intent is exactly one of: close_tabs, group_tabs, bookmark_tabs, pin_tabs, unpin_tabs, mute_tabs, unmute_tabs, reload_tabs, sort_tabs, retrieve_open, open_tabs, clarify

Each predicate (pred) is exactly one of:
{"field":"topic","op":"about","value":"<what the tab is ABOUT>"}
{"field":"time","op":"within"|"older_than"|"between","value":"<range>","opts":{"basis":"opened"|"accessed"}}
{"field":"domain","op":"contains"|"equals","value":"<host like youtube.com>"}
{"field":"title","op":"contains","value":"<text>"}
{"field":"state","op":"is","value":"pinned"|"audible"|"muted"}
{"field":"duplicate","op":"is","value":true}
{"field":"rank","op":"keep_newest"|"keep_oldest","value":<positive int>,"opts":{"scope":"within_set"|"per_dup_group"}}

Rules:
- topic: the SUBJECT only, verbs and filler stripped. Fix typos. "topic" is the ONLY semantic field. Use it for "about", "related to", "regarding".
- title/domain/content: Literal fields. Use them for "containing", "named", "titled", "in the URL".
- exception_span: MUST be the verbatim substring of the command that expressed the exclusion (e.g. "except gardening stuff"), or null if there is no exclusion.
- time.value MUST be one of: today, yesterday, this_week, last_week, this_month, last_hour, or "N_days"/"N_hours"/"N_weeks".
- op "between" is a two-sided window; its value MUST be "N_to_M_hours"/"N_to_M_days"/"N_to_M_weeks" (e.g. "1_to_3_hours" = the span from 3 hours ago up to 1 hour ago). Use it for "from 1 to 3 hours ago", "between 2 and 5 days ago".
- time opts.basis: "opened" for "opened/from/created"; "accessed" for "looked at/used/active".
- "none" node requirement: If the user says "except X", you MUST add an "exclude" predicate.
- rank: "keep the 5 newest" -> keep_newest 5 scope within_set. "keep the one I used most recently" over duplicates -> keep_newest 1 scope per_dup_group.
- retrieve_open: for "find the tab where ... and open it".
- open_tabs: for "open/focus/show me/bring up the <filter> tabs" -- the user wants to SEE tabs that are ALREADY open, picked by topic/domain/time/state (usually several). It only focuses/highlights them; it never closes, groups, moves, or reloads. Do NOT confuse with retrieve_open, which is a CONTENT search for one specific PAST tab ("the tab where I read about X"); open_tabs filters the currently-open tabs and takes normal include/exclude predicates (topic, time, domain, state).
- At most 5 include predicates, 5 exclude predicates.

Examples:
"Close all shopping tabs from yesterday except the ones with gardening equipment" -> {"intent":"close_tabs","include":[{"field":"topic","op":"about","value":"shopping"},{"field":"time","op":"within","value":"yesterday","opts":{"basis":"opened"}}],"exclude":[{"field":"topic","op":"about","value":"gardening equipment"}],"exception_span":"except the ones with gardening equipment","confidence":0.9}
"Close every YouTube tab I haven't looked at in the last hour" -> {"intent":"close_tabs","include":[{"field":"domain","op":"equals","value":"youtube.com"},{"field":"time","op":"older_than","value":"last_hour","opts":{"basis":"accessed"}}],"exclude":[],"exception_span":null,"confidence":0.9}
"Keep only my 5 most recently used research tabs, close the rest" -> {"intent":"close_tabs","include":[{"field":"topic","op":"about","value":"research"},{"field":"rank","op":"keep_newest","value":5,"opts":{"scope":"within_set"}}],"exclude":[],"exception_span":null,"confidence":0.85}
"Mute every tab playing sound except my music tab" -> {"intent":"mute_tabs","include":[{"field":"state","op":"is","value":"audible"}],"exclude":[{"field":"topic","op":"about","value":"music"}],"exception_span":"except my music tab","confidence":0.9}
"Group the shopping tabs I opened between 2 and 5 days ago" -> {"intent":"group_tabs","include":[{"field":"topic","op":"about","value":"shopping"},{"field":"time","op":"between","value":"2_to_5_days","opts":{"basis":"opened"}}],"exclude":[],"exception_span":null,"confidence":0.85}
"Open the programming tabs from the last hour" -> {"intent":"open_tabs","include":[{"field":"topic","op":"about","value":"programming"},{"field":"time","op":"within","value":"last_hour","opts":{"basis":"opened"}}],"exclude":[],"exception_span":null,"confidence":0.85}
"Show me my youtube tabs" -> {"intent":"open_tabs","include":[{"field":"domain","op":"equals","value":"youtube.com"}],"exclude":[],"exception_span":null,"confidence":0.85}

Multi-step (chained) commands: when the command contains SEQUENTIAL actions ("and then", "then", "after that", or "and <verb> them"), return a top-level steps[] array instead of the flat shape. steps[] has 1-3 entries; each entry is:
{"intent":"<intent>","include":[<pred>,...],"exclude":[<pred>,...],"slots":{},"carry":<bool>,"action_params":{}}
- step N's include/exclude/slots/action_params use exactly the same fields as the flat shape.
- carry: true on a step whose object is a PRONOUN referring to the previous step's selection ("them"/"those"/"the selection"); that step re-runs over exactly the previous step's tabs. Use carry:false when the step names its own selection.
- Steps execute in order; a step that matches nothing aborts the rest. If the chain cannot be expressed in 3 steps, emit only the flat single-intent shape for the dominant action instead.
Example: "bookmark the recipe tabs and then close them" -> {"steps":[{"intent":"bookmark_tabs","include":[{"field":"topic","op":"about","value":"recipe"}],"exclude":[],"slots":{},"carry":false,"action_params":{}},{"intent":"close_tabs","include":[],"exclude":[],"slots":{},"carry":true,"action_params":{}}],"confidence":0.9}
Single-intent commands MUST keep using the flat shape (intent/include/exclude), never a one-step steps[] wrapper that changes nothing.
`;

  const TIME_FIELDS = new Set(['time', 'opened_at', 'accessed_at']);
  
  function hasNode(tree, check) {
    if (!tree) return false;
    if (check(tree)) return true;
    for (const k of ['all', 'any', 'none']) {
      if (Array.isArray(tree[k])) {
        for (const child of tree[k]) {
          if (hasNode(child, check)) return true;
        }
      }
    }
    return false;
  }
  
  function hasLeaf(tree, check) {
    if (!tree) return false;
    if (tree.field) return check(tree);
    for (const k of ['all', 'any', 'none']) {
      if (Array.isArray(tree[k])) {
        for (const child of tree[k]) {
          if (hasLeaf(child, check)) return true;
        }
      }
    }
    return false;
  }

  const REQUIRED = {
    exception:  p => hasNode(p.where, n => Array.isArray(p.where.none) && p.where.none.length > 0),
    negation:   p => hasNode(p.where, n => Array.isArray(p.where.none) && p.where.none.length > 0),
    time:       p => hasLeaf(p.where, l => TIME_FIELDS.has(l.field)),
    temporal:   p => hasLeaf(p.where, l => TIME_FIELDS.has(l.field)),
    duplicates: p => !!p.dedupe,
    rank:       p => p.limit != null || (p.order_by && p.order_by.length > 0),
  };

  class PlanContractError extends Error {
    constructor(missing) {
      super('Missing required constraints: ' + missing.join(', '));
      this.missing = missing;
    }
  }

  function validatePredicate(f) {
    if (!f || typeof f !== 'object') return null;
    const opts = f.opts || {};
    switch (f.field) {
      case 'topic':
        return { field: 'topic', op: 'about', value: String(f.value || '').trim() };
      case 'time':
      case 'opened_at':
      case 'accessed_at': {
        const v = String(f.value || '').trim();
        if (!isKnownTimeExpr(v)) return null;
        const op = f.op === 'older_than' ? 'older_than' : f.op === 'between' ? 'between' : 'within';
        return { field: 'time', op, value: v, opts: { basis: opts.basis === 'opened' ? 'opened' : 'accessed' } };
      }
      case 'domain':
        return { field: 'domain', op: f.op === 'contains' ? 'contains' : 'equals', value: String(f.value || '').trim().toLowerCase() };
      case 'title':
      case 'url':
      case 'content':
      case 'any_text':
        return { field: f.field, op: 'contains', value: String(f.value || '').trim() };
      case 'state':
        if (!['pinned', 'audible', 'muted'].includes(f.value)) return null;
        return { field: 'state', op: 'is', value: f.value };
      case 'duplicate':
      case 'duplicates':
        return { field: 'duplicate', op: 'is', value: true };
      case 'rank': {
        const n = Number(f.value);
        if (!Number.isInteger(n) || n < 1) return null;
        return { field: 'rank', op: f.op === 'keep_oldest' ? 'keep_oldest' : 'keep_newest', value: n, opts: { scope: opts.scope === 'per_dup_group' ? 'per_dup_group' : 'within_set' } };
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
    // Multi-group bucket definitions (group_multi). The model returns the group
    // NAMES here after intent parsing; the on-device NLI later sorts tabs into
    // them. Sanitize hard: buckets are user/model text that will become Chrome
    // group titles and NLI labels, never executable. Cap arity and lengths.
    if (Array.isArray(raw.buckets)) {
      const buckets = [];
      for (const b of raw.buckets) {
        if (!b || typeof b !== 'object') continue;
        const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const characteristic = String(b.characteristic || b.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!name && !characteristic) continue;
        buckets.push({ name: name || characteristic, characteristic });
        if (buckets.length >= 8) break;
      }
      if (buckets.length > 0) out.buckets = buckets;
    }
    if (typeof raw.restrict === 'string' && raw.restrict.trim()) {
      out.restrict = raw.restrict.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    return out;
  }

  function buildV2Schema(raw) {
    // V3 step compiler path: predicates already validated through
    // validateV3Predicate keep their relationship/position/groupScope fields,
    // which plain validatePredicate would drop.
    const predOf = raw._v3 ? validateV3Predicate : validatePredicate;
    const include = (Array.isArray(raw.include) ? raw.include : []).map(predOf).filter(Boolean);
    const exclude = (Array.isArray(raw.exclude) ? raw.exclude : []).map(predOf).filter(Boolean);
    
    let dedupe = null;
    let order_by = [];
    let limit = null;
    
    const finalInclude = [];
    for (const inc of include) {
      if (inc.field === 'duplicate') dedupe = { key: 'url', keep: 'newest' };
      else if (inc.field === 'rank') {
        if (inc.opts.scope === 'per_dup_group') { dedupe = { key: 'url', keep: inc.op === 'keep_oldest' ? 'oldest' : 'newest' }; limit = inc.value; }
        else { order_by.push({ field: 'accessed_at', dir: inc.op === 'keep_oldest' ? 'asc' : 'desc' }); limit = inc.value; }
      } else {
        finalInclude.push(inc);
      }
    }

    const where = {};
    if (finalInclude.length > 0) where.all = finalInclude;
    if (exclude.length > 0) where.none = exclude;

    const conf = Number(raw.confidence);
    const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.7;

    return {
      v: 2,
      intent: raw.intent,
      source: 'open_tabs',
      scope: { window: 'current', include_pinned: false },
      where,
      dedupe,
      order_by,
      limit,
      params: validateActionParams(raw.action_params),
      confidence,
      destructive: DESTRUCTIVE.has(raw.intent)
    };
  }

  function validate(raw, signals = []) {
    if (!raw || typeof raw !== 'object') return null;

    // Multi-step (V3): a chained model output carries steps[]. When at least
    // one step validates, the plan is composite: flat intent fields are left
    // off and the executor runs the chain. Any single-step array is still
    // accepted (steps:[{...}] == the flat shape) so the formats interoperate.
    const steps = validateSteps(raw);
    if (steps) {
      const conf = Number(raw.confidence);
      return {
        v: 3,
        steps,
        source: 'open_tabs',
        params: steps[steps.length - 1].params || {},
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.7,
        destructive: steps.some(s => s.destructive),
      };
    }

    if (!INTENTS.has(raw.intent)) return null;
    const plan = buildV2Schema(raw);

    const missing = signals.filter(s => REQUIRED[s] && !REQUIRED[s](plan));
    if (missing.length > 0) {
      throw new PlanContractError(missing);
    }
    
    let expectedConstraints = signals.length;
    let metConstraints = signals.length - missing.length;
    let coverage = expectedConstraints === 0 ? 1.0 : (metConstraints / expectedConstraints);
    
    plan.confidence = plan.confidence * coverage;
    
    if (plan.confidence < 0.5 && plan.intent !== 'clarify') {
        plan.intent = 'clarify';
        plan.params = plan.params || {};
        plan.params.question = "I'm not confident I understood which tabs you meant. Could you rephrase?";
    }

    return plan;
  }

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
    } catch { }
  }

  async function tryModel(fn, prompt, signals) {
    if (typeof fn !== 'function') return null;
    let text;
    try { text = await fn(SYSTEM, prompt, TIMEOUT_MS); }
    catch (e) { return null; }
    if (!text || typeof text !== 'string') return null;
    if (/^\s*error\s*:/i.test(text)) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch { return null; }
    try {
      return validate(obj, signals);
    } catch (e) {
      if (e instanceof PlanContractError) {
        return e;
      }
      return null;
    }
  }

  async function buildFilterPlan(cmd, opts = {}) {
    const signals = Array.isArray(opts.signals) ? opts.signals : [];
    const key = normalizeCommand(cmd);
    
    const skipCache = opts.noCache;

    let cache = null;
    if (!skipCache && key) {
      cache = await readCache();
      // Shape guard: only trust an entry that is a current V2 plan. A stale flat-schema
      // plan (no `v`) would sail through the executor's where.all/none read as "no
      // filters" and select the whole window, so treat it as a miss and rebuild.
      const cached = cache[key] && cache[key].p;
      if (cached && cached.v === 2 && cached.where) return { ...cached, source: 'cache' };
    }

    let incStr = cmd;
    let excStr = '';
    const m = cmd.match(EXCEPT_RE);
    if (m) {
        incStr = cmd.substring(0, m.index).trim();
        excStr = cmd.substring(m.index).trim();
    }
    
    let prompt = `Command inclusion part: "${incStr}"`;
    if (excStr) {
        prompt += `\nCommand exclusion part: "${excStr}"`;
    }

    let plan = await tryModel(opts.callGemini, prompt, signals);
    
    if (plan instanceof PlanContractError) {
        let repairPrompt = prompt + `\n\nYour previous plan missed required constraints: ${plan.missing.join(', ')}. `;
        if (plan.missing.includes('exception')) {
            repairPrompt += `The command contains an EXCEPTION (e.g. "${excStr}") but your output had no "exclude" constraints. Re-emit the full plan with the exclusion included.`;
        }
        plan = await tryModel(opts.callGemini, repairPrompt, signals);
        if (plan instanceof PlanContractError) {
            plan = null;
        }
    }
    
    let source = 'gemini';
    if (!plan || plan instanceof PlanContractError) { 
        plan = await tryModel(opts.callOllama, prompt, signals); 
        source = 'ollama'; 
    }
    if (!plan || plan instanceof PlanContractError) { 
        plan = buildRegexPlan(cmd, signals); 
        source = 'regex'; 
    }

    plan.source = source;

    if (!skipCache && cache && (source === 'gemini' || source === 'ollama')) {
      cache[key] = { p: plan, _t: Date.now() };
      await writeCache(cache);
    }
    return plan;
  }

  function detectIntent(s, signals) {
    if (signals.includes('find_open') || /\bre-?open\b/.test(s)) return 'retrieve_open';
    if (signals.includes('focus_open')) return 'open_tabs';
    if (/\bunpin\b/.test(s)) return 'unpin_tabs';
    if (/\bpin\b/.test(s)) return 'pin_tabs';
    if (/\bunmute\b/.test(s)) return 'unmute_tabs';
    if (/\bmute\b/.test(s)) return 'mute_tabs';
    if (/\b(bookmark|save)\b/.test(s)) return 'bookmark_tabs';
    if (/\b(group|cluster|organi[sz]e)\b/.test(s)) return 'group_tabs';
    if (/\b(reload|refresh)\b/.test(s)) return 'reload_tabs';
    if (/\bsort\b/.test(s)) return 'sort_tabs';
    if (/\b(close|remove|clear|kill|delete|get rid of)\b/.test(s)) return 'close_tabs';
    // Focus/show verbs, checked last so any explicit action verb above wins.
    // These land on open_tabs (focus already-open tabs) rather than the
    // group_tabs default -- "show me the X tabs" should reveal, not regroup.
    if (/\b(open|focus|reveal|highlight|bring up|pull up|show)\b/.test(s)) return 'open_tabs';
    return 'group_tabs';
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

  // Two-sided window ("1 to 3 hours", "between 2 and 5 days", "1_to_3_hours").
  // Returns the canonical "N_to_M_unit" value that parseNumericWindow understands.
  // Must be tried before the single-sided extractTimeValue, whose non-anchored
  // matcher would otherwise grab the trailing "3 hours" and drop the lower bound.
  function extractTimeWindowValue(s) {
    const m = s.match(/(\d+)\s*[_ ]?(?:to|and|[-–—])[_ ]?\s*(\d+)\s*[_ ]?(minute|min|hour|hr|day|week)s?/);
    if (!m) return null;
    const u = { minute: 'minutes', min: 'minutes', hour: 'hours', hr: 'hours', day: 'days', week: 'weeks' }[m[3]];
    return `${m[1]}_to_${m[2]}_${u}`;
  }

  function detectTimeFilter(s) {
    const windowVal = extractTimeWindowValue(s);
    if (windowVal) {
      const openedW = /\b(opened|from|created)\b/.test(s) && !/\b(looked at|used|viewed|active|touched)\b/.test(s);
      return { field: 'time', op: 'between', value: windowVal, opts: { basis: openedW ? 'opened' : 'accessed' } };
    }
    const value = extractTimeValue(s);
    if (!value) return null;
    const olderThan =
      /\bolder than\b/.test(s) ||
      /\bhaven'?t\b[\s\S]*\bin (?:the )?(?:last|past)\b/.test(s) ||
      /\bnot (?:looked|touched|used|opened|visited)[\s\S]*\bin (?:the )?(?:last|past)\b/.test(s);
    const opened = /\b(opened|from|created)\b/.test(s) && !/\b(looked at|used|viewed|active|touched)\b/.test(s);
    return { field: 'time', op: olderThan ? 'older_than' : 'within', value, opts: {basis: opened ? 'opened' : 'accessed'} };
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
    if (m) return { field: 'rank', op: 'keep_newest', value: parseInt(m[1], 10), opts: {scope: 'within_set'} };
    m = s.match(/\b(\d+)\s+oldest\b/);
    if (m) return { field: 'rank', op: 'keep_oldest', value: parseInt(m[1], 10), opts: {scope: 'within_set'} };
    m = s.match(/\bkeep\s+(?:only\s+)?(?:my\s+)?(?:the\s+)?(\d+)\b/);
    if (m) return { field: 'rank', op: 'keep_newest', value: parseInt(m[1], 10), opts: {scope: 'within_set'} };
    return null;
  }

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

  function buildRegexPlan(cmd, signals = []) {
    const s = String(cmd || '').toLowerCase();
    const intent = detectIntent(s, signals);
    const include = [];
    const exclude = [];
    const action_params = {};

    const parts = s.split(EXCEPT_RE);
    const head = parts[0];
    const tail = parts.length > 1 ? parts.slice(1).join(' ') : '';

    if (intent === 'retrieve_open') action_params.topK = 1;
    if (/\b(bookmark|save)\b/.test(s) && /\b(then|and)\b[\s\S]*\bclose\b/.test(s)) action_params.closeAfterBookmark = true;

    const t = detectTimeFilter(s);
    if (t) include.push(t);

    const dom = detectDomain(head);
    if (dom) include.push({ field: 'domain', op: 'equals', value: dom });

    if (/\bduplicates?\b|\bdupes?\b/.test(s)) {
      include.push({ field: 'duplicate', op: 'is', value: true });
      if (/\bkeep\b[\s\S]*\b(one|most recent|recently)\b/.test(s)) {
        include.push({ field: 'rank', op: 'keep_newest', value: 1, opts: {scope: 'per_dup_group'} });
      }
    }

    for (const st of detectStates(head)) include.push({ field: 'state', op: 'is', value: st });
    for (const st of detectStates(tail)) exclude.push({ field: 'state', op: 'is', value: st });

    if (!include.some(f => f.field === 'rank')) {
      const rk = detectRankFilter(s);
      if (rk) include.push(rk);
    }

    if (!dom && !detectStates(head).length) {
      const topic = extractTopic(head);
      if (topic) include.push({ field: 'topic', op: 'about', value: topic });
    }
    if (tail && !detectStates(tail).length) {
      const extopic = extractTopic(tail);
      if (extopic) exclude.push({ field: 'topic', op: 'about', value: extopic });
    }
    
    const raw = {
        intent,
        include,
        exclude,
        confidence: 0.4,
        action_params
    };
    
    return buildV2Schema(raw);
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
    buildFilterPlan, validate, buildRegexPlan, parseMultiGroupCommand, normalizeCommand, detectTimeFilter, validateActionParams, SYSTEM, INTENTS,
    validateSteps, validateStep, validateV3Predicate, MAX_STEPS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentPlanner;
  if (typeof self !== 'undefined') self.AgentPlanner = AgentPlanner;
})();
