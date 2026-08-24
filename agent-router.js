// agent-router.js
// LAYER 0 of the bounded tool-calling agent: a deterministic, $0, <5ms gate that
// decides whether a command needs the planner at all.
//
// WHY A ROUTER AT ALL
// The existing path (llm-query -> NliSelect -> one handler) compiles a command
// into a single topic query. That is the right, cheap tool for the ~80% of
// commands it already handles ("close my cricket tabs", "reload everything") and
// we must not regress it: it is faster and it costs nothing. The planner exists
// only for the shapes a single topic query literally cannot express -- time,
// exceptions, counts/ranks, live tab STATE, and find-and-open. This router is the
// fork, and keeping it deterministic (no model call) means the common case never
// pays for a capability it doesn't use, and the fork itself can never be down.
//
// The router only ever ADDS capability. A "simple" verdict runs the existing path
// exactly as before. A "complex" verdict that was unnecessary costs one extra
// Gemini call that still resolves to the same tabs (a single-filter plan). So it
// is tuned to catch the shapes the simple path MIS-handles, not to be a precise
// classifier -- a false "complex" is cheap, a missed "complex" is a wrong answer.

(() => {
  // Each class below maps to a capability the single-topic-query path cannot
  // express. A command is "complex" if it trips ANY class; the matched classes
  // are returned so the planner can be primed and telemetry can bucket commands.

  // TIME. The simple path has no notion of when a tab was opened or last used.
  const TEMPORAL = [
    /\byesterday\b/, /\btoday\b/, /\btonight\b/,
    /\bthis (morning|afternoon|evening|week|month)\b/,
    /\blast (night|week|month|hour)\b/,
    /\bpast (hour|day|week|month|\d+)\b/,
    /\bin the last\b/, /\bolder than\b/, /\bnewer than\b/,
    /\b\d+\s*(minute|min|hour|hr|day|week)s?\s*(ago|old)?\b/,
    /\bhaven'?t (looked at|touched|used|opened|visited|seen)\b/,
    /\bnot (looked at|touched|used|opened|visited)\b/,
    /\brecently\b/, /\bsince\b/,
  ];

  // EXCEPTION / negation -> set subtraction. "close X except Y".
  const EXCEPTION = [
    /\bexcept\b/, /\bexcluding\b/, /\bother than\b/, /\bapart from\b/,
    /\bbesides\b/, /\bbut not\b/, /\bbut keep\b/, /\bwithout\b/,
    /\bleaving\b/, /\baside from\b/,
  ];

  // COUNT / RANK -> "keep the 5 newest", "top 3", "the rest", "most relevant".
  const COUNT_RANK = [
    /\b(top|first|last|newest|oldest)\s+\d+\b/,
    /\b\d+\s+(most|newest|oldest|recent|latest|least)\b/,
    /\bkeep (only|the)\b/, /\bthe rest\b/,
    /\bmost recent(ly)?\b/, /\bleast recent(ly)?\b/,
    /\bmost relevant\b/, /\bmost used\b/,
  ];

  // STATE. The simple path would EMBED the word "audible"/"pinned" as a topic and
  // cosine-match tabs ABOUT audio, not tabs currently PLAYING audio -- the wrong
  // set. These are live-property filters, so they belong to the planner/executor.
  // Note "muted"/"pinned" (states) not "mute"/"pin" (the action verbs) -- a bare
  // "mute my music tabs" is a topic command the simple path already handles.
  const STATE = [
    /\bplaying (sound|audio|music)\b/, /\bmaking (noise|sound)\b/,
    /\baudible\b/, /\bmuted\b/, /\bpinned\b/, /\bunpinned\b/,
    /\bduplicates?\b/, /\bdupes?\b/,
  ];

  // FIND & OPEN -> content retrieval then focus/open a specific past tab.
  // "find" alone is not enough ("find my cricket tabs and close them" is a close);
  // require retrieval phrasing together with an open/switch verb, or a bare reopen.
  const RETRIEVE = /\b(find|locate|which|where|search for)\b/;
  const OPEN_VERB = /\b(open|reopen|re-open|switch to|go to|take me to|bring up|pull up|jump to)\b/;
  const THE_TAB_WHERE = /\bthe (tab|page|one) (where|that|i)\b/;

  // FOCUS OPEN -> activate/highlight tabs that are ALREADY open, picked by a
  // filter ("open the programming tabs", "focus my youtube tabs", "show me the
  // shopping tabs"). Distinct from find_open (content recall of a possibly-closed
  // tab): here a focus verb is followed within a short span by the PLURAL noun
  // "tabs", so "open the tab where I read X" (singular) stays with find_open and
  // "open youtube.com" (navigation, no "tabs") never trips it.
  const FOCUS_OPEN = /\b(open|focus|reveal|highlight|bring up|pull up|show me)\b[^.?!]{0,40}\btabs\b/;

  // MULTI_GROUP -> "in 3 groups", "split into groups", "group into X, Y, Z", "categorize into".
  const MULTI_GROUP = [
    /\b(\d+\s*(?:main\s*)?groups?)\b/i,
    /\b(multi(?:ple)?\s+groups?)\b/i,
    /\b(split|divide|sort|categorize|organize|group)\s+(?:all\s+)?(?:my\s+)?(?:the\s+)?(?:[a-z0-9]+\s+)?tabs\s+in(?:to)?\s+\d+\b/i,
    /\b(split|divide|sort|categorize|organize|group)\s+(?:all\s+)?(?:my\s+)?tabs\s+into\s+([a-z0-9\s,]+(?:and|&)[a-z0-9\s,]+)\b/i,
    /\bin(?:to)?\s+\d+\s+(?:main\s+)?groups?\s*[:-]/i
  ];

  function detectFindOpen(s) {
    if (/\bre-?open\b/.test(s)) return true;
    if (THE_TAB_WHERE.test(s) && OPEN_VERB.test(s)) return true;
    if (RETRIEVE.test(s) && OPEN_VERB.test(s)) return true;
    return false;
  }

  function anyMatch(patterns, s) {
    return patterns.some(re => re.test(s));
  }

  /**
   * Classify a raw command.
   * @returns {{complex: boolean, signals: string[]}} signals is a subset of
   *   ['temporal','exception','count_rank','state','find_open','focus_open','multi_group'] in fixed order.
   */
  function isComplexCommand(cmd) {
    const s = String(cmd || '').toLowerCase();
    const signals = [];
    if (anyMatch(TEMPORAL, s))    signals.push('temporal');
    if (anyMatch(EXCEPTION, s))   signals.push('exception');
    if (anyMatch(COUNT_RANK, s))  signals.push('count_rank');
    if (anyMatch(STATE, s))       signals.push('state');
    if (detectFindOpen(s))        signals.push('find_open');
    if (FOCUS_OPEN.test(s))       signals.push('focus_open');
    if (anyMatch(MULTI_GROUP, s)) signals.push('multi_group');
    return { complex: signals.length > 0, signals };
  }

  const AgentRouter = { isComplexCommand };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentRouter;
  if (typeof self !== 'undefined') self.AgentRouter = AgentRouter;
})();
