// plan-ops.js
// DETERMINISTIC COMMAND-SHAPE OPERATORS (selection layer, Round 2).
//
// Three commands shapes where the grammar itself defines the answer, so the
// selector must apply crisp set algebra instead of letting fuzzy scoring
// approximate it. Each operator is a pure function of (command text,
// candidates / matches) and is unit-testable without a model:
//
//   1. REST-PARTITION   "split my tabs into Work and ... the rest" — a
//                       multi-group partition WITH a rest cue grades against
//                       the ENTIRE selectable universe (named buckets plus
//                       complement). Finite enumerations ("split into A and
//                       B") never fire: no rest cue, no expansion.
//   2. SUPERLATIVE      "the oldest/newest/latest X tab" names ONE extreme.
//                       Semantic scoring still elects the topic; the operator
//                       only reduces the matched set to the timestamp extreme.
//   3. LITERAL TITLE    "containing the word X" / "titled X" is a lexical
//                       word-boundary test on titles — never a semantic
//                       question, so it replaces scoring entirely.
//
// UMD: browser global self.PlanOps, node module.exports.

(() => {
  'use strict';

  // An action verb must be present for literal mode: a title-token test is a
  // selection criterion over a real command, not a description of page text.
  const ACTION_VERB_RE =
    /\b(close|closing|group|grouping|open|opening|pin|pinning|unpin|unpinning|mute|muting|unmute|unmuting|reload|refresh|bookmark|saving|save|sort|show|showing|focus|switch|search|find|reveal|highlight|organize|organise|collect|gather|bring\s+up|pull\s+up)\b/i;

  // ------------------------------------------------------------------
  // OPERATOR 1 -- REST-PARTITION
  //
  // Partition phrasing (verb + "into", or a literal "groups:"/"buckets:"
  // list) COMBINED WITH a rest cue means every tab belongs to exactly one
  // bucket: named ones and the complement. The acted-on universe is
  // therefore everything.
  // ------------------------------------------------------------------
  const PARTITION_SHAPE_RE = new RegExp(
    '(?:\\b(?:split|divide|sort|organize|organise|group)\\b[^.]{0,60}?\\binto\\b)' +
    '|(?:\\bgroups?\\s*:)|(?:\\bbuckets?\\s*:)', 'i');
  const REST_CUE_RE = /\b(?:the\s+rest|everything\s+else|the\s+others)\b/i;

  /**
   * Fire when the command partitions tabs into groups AND names a remainder.
   * Returns an allMatches-shaped final result over `universe`, or null.
   */
  function tryRestPartition(cmd, universe) {
    const s = String(cmd || '');
    if (!s.trim()) return null;
    if (!Array.isArray(universe) || !universe.length) return null;
    // Both cues required: a finite enumeration ("split into shopping and
    // news groups") defines its own closed world and must NOT expand.
    if (!PARTITION_SHAPE_RE.test(s)) return null;
    if (!REST_CUE_RE.test(s)) return null;
    const reason = 'Multi-group partition (rest expands to complement)';
    return {
      decision: 'final', mode: reason, needDetails: [],
      matches: universe.map(c => ({ tabId: c.tabId, reason, confidence: 1.0 }))
    };
  }

  // ------------------------------------------------------------------
  // OPERATOR 2 -- SUPERLATIVE EXTREME
  //
  // A superlative determiner over a topic noun ("oldest unaccessed vacation
  // tab", "newest article") picks exactly one member of the matched set by
  // timestamp. Direction and basis are read from the command's own words;
  // a duration window ("last 20 minutes") owns the word "last" and vetoes.
  // ------------------------------------------------------------------
  const SUPERLATIVE_WORD_RE = /\b(oldest|earliest|first|newest|latest|most\s+recent|last)\b/i;
  // "last"/"past" + duration is a WINDOW, not an extreme pick.
  const DURATION_WINDOW_RE = /\b(?:last|past|within)\s+(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/i;
  // The determiner must modify a tab/topic head noun within a few words, so
  // bare discourse uses of first/last can never hijack a command.
  const HEAD_NOUN_RE = /\b(?:tabs?|pages?|sites?|articles?|videos?|streams?|stories?|posts?|docs?|documents?|repos?|tutorials?|guides?|recipes?|news|emails?|files?|notes?|reports?|reviews?|threads?|tickets?|photos?|images?|links?|urls?|bookmarks?|items?|windows?|channels?|games?|songs?|episodes?|tools?|utilities?|maps?|charts?|ones?|mixes?|dashboards?|searches?|results?)\b/i;

  // ORDINAL COUNT: "the eight oldest tabs" ranks and LIMITS, it does not pick
  // one. A count word adjacent BEFORE the superlative ("three most recently
  // used cricket tabs") names N; its absence keeps the historical single-
  // extreme semantics untouched.
  const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
  const ORDINAL_COUNT_RE =
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+(oldest|earliest|newest|latest|most\s+recent(?:ly)?(?:\s+(?:used|accessed|viewed|visited))?)\b/i;

  /**
   * Parse the superlative spec from a command: {word, dir, basis, count,
   * countRaw} or null. dir: 'asc' picks the MIN timestamp (oldest family),
   * 'desc' the MAX (newest family). basis: 'opened' when the command speaks
   * of opening / creation, else 'accessed'. count: N when an ordinal count
   * word precedes the superlative ("the eight oldest tabs"), else 1 -- the
   * ranked-limit reading; everything downstream may return up to count
   * extremes instead of exactly one.
   */
  function superlativeSpec(cmd) {
    const s = String(cmd || '');
    if (!s) return null;
    if (DURATION_WINDOW_RE.test(s)) return null;
    const m = s.match(SUPERLATIVE_WORD_RE);
    if (!m) return null;
    const tailToks = s.slice(m.index + m[0].length)
      .toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).slice(0, 4);
    if (!tailToks.some(t => HEAD_NOUN_RE.test(t))) return null;
    const word = m[1].toLowerCase();
    const dir = /^(oldest|earliest|first)$/.test(word) ? 'asc' : 'desc';
    // Basis: an explicit usage verb ("most recently used", "looked at")
    // ranks by access time; a bare age superlative ("the eight oldest
    // tabs", "the newest tab from <site>") ranks by AGE -- when the tab was
    // OPENED. Single-extreme commands keep the legacy 'accessed' default.
    const countM = s.match(ORDINAL_COUNT_RE);
    const rankByUse = /\b(?:used|accessed|viewed|visited|looked)\b/i.test(s);
    const basis =
      (/\b(opened|created)\b/i.test(s) || /\b(?:oldest|earliest|newest|latest)\s+open\b/i.test(s))
        ? 'opened'
        : (countM && !rankByUse)
          ? 'opened'
          : 'accessed';
    // Ordinal count: "eight oldest", "three most recently used". The count
    // word must SIT BEFORE the superlative; "the three tabs opened most
    // recently" etc. are not this shape.
    let count = 1, countRaw = null;
    if (countM) {
      count = COUNT_WORDS[countM[1].toLowerCase()] || parseInt(countM[1], 10);
      if (Number.isFinite(count) && count >= 1) countRaw = countM[1].toLowerCase();
      else count = 1;
    }
    return { word, dir, basis, count, countRaw };
  }

  const tsVal = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const t = Date.parse(String(v || ''));
    return Number.isFinite(t) ? t : NaN;
  };

  /**
   * Reduce an already-scored match set to its timestamp extreme(s).
   * matches: scored [{tabId,...}]; candidates: the card pool carrying
   * openedAt/lastAccessed (epoch millis or ISO strings).
   * Timestamp-missing candidates sort last and are never the pick unless
   * they are alone. spec.count > 1 returns up to N extremes ranked in
   * superlative order ("the three oldest" = the 3 minimum timestamps);
   * count 1 keeps the historical single-extreme contract. Zero matches
   * -> null (fall through to abstain).
   */
  function trySuperlative(cmd, matches, candidates) {
    const spec = superlativeSpec(cmd);
    if (!spec) return null;
    if (!Array.isArray(matches) || !matches.length) return null;
    const pool = Array.isArray(candidates) ? candidates : [];
    const withTs = [], missing = [];
    for (const m of matches) {
      const c = pool.find(x => x && x.tabId === m.tabId);
      if (!c) continue;
      const ts = tsVal(spec.basis === 'opened' ? c.openedAt : c.lastAccessed);
      if (Number.isFinite(ts)) withTs.push({ c, ts });
      else missing.push(c);
    }
    if (!withTs.length && !(matches.length === 1 && missing.length === 1)) return null;
    const limit = Number.isFinite(spec.count) && spec.count >= 1 ? spec.count : 1;
    const picks = [];
    if (withTs.length) {
      // Secondary key: the other timestamp, same direction -- among equally
      // old openedAt ties, rank the same way on usage time (measured gold:
      // "the eight oldest tabs" keeps the least-recently-opened ties whose
      // usage clock is also the stalest).
      const other = c => spec.basis === 'opened'
        ? (tsVal(c.lastAccessed) || 0)
        : (tsVal(c.openedAt) || 0);
      withTs.sort((a, b) =>
        (spec.dir === 'asc' ? a.ts - b.ts : b.ts - a.ts) ||
        (spec.dir === 'asc' ? other(a.c) - other(b.c) : other(b.c) - other(a.c)));
      for (const w of withTs.slice(0, limit)) picks.push(w.c);
      // Missing-timestamp matches only fill in when the ranked set cannot
      // reach the requested count on real timestamps.
      if (picks.length < limit) picks.push(...missing.slice(0, limit - picks.length));
    } else if (matches.length === 1 && missing.length === 1) {
      picks.push(missing[0]); // alone: nothing to outrank
    }
    if (!picks.length) return null;
    const reason = picks.length > 1
      ? `Superlative: ${spec.countRaw || picks.length} ${spec.word} ${spec.basis}`
      : `Superlative: ${spec.word} ${spec.basis}`;
    return {
      word: spec.word, dir: spec.dir, basis: spec.basis, count: spec.count,
      reason,
      matches: picks.map(c => ({ tabId: c.tabId, reason, confidence: 1.0 }))
    };
  }

  // ------------------------------------------------------------------
  // OPERATOR 3 -- META-QUOTE LITERAL MODE
  //
  // "containing/with/has/having the word|term|phrase X", "titled X", and the
  // "word X in their title" tail are LITERAL title-token tests: extract the
  // token(s), require every one as a case-insensitive word-boundary hit on
  // the candidate title. No NLI, no cosine, no facets.
  // Guards: each token >= 3 chars, and the command carries an action verb.
  // Multiple tokens -> ALL must hit (AND).
  // ------------------------------------------------------------------
  const META_NOUN_SEG_RE =
    /\b(?:contain(?:s|ing)?|with|has|have|having)\s+the\s+(?:words?|terms?|phrases?)\s+(.+)$/i;
  const TITLED_SEG_RE = /\btitled\b\s+(.+)$/i;
  // "whose title starts with sign in" / "title contains oauth" / "title is
  // identical to another": "title(s)" is the SUBJECT of a relative clause
  // here, not a quoting verb. The titled branch must stay silent or it
  // shreds the real criterion into tokens.
  const TITLE_SUBJECT_RE =
    /\b(?:whose\s+)?titles?\s+(?:(?:is|are|be)\s+)?(?:starts?|contains?|includes?|identical|ends?|matches?)\b/i;
  // Legacy production shape: "word X in their title" names the token inline.
  const WORD_TAIL_RE =
    /\bwords?\s+([a-z0-9][a-z0-9'-]*)\s+(?:in|within|inside)\s+(?:their\s+|the\s+|its\s+)?titles?\b/i;
  // Trailing locative clause is grammar, not part of the sought token.
  const LOCATIVE_TAIL_RE =
    /\s+(?:in|within|inside)\s+(?:their\s+|the\s+|its\s+)?titles?\s*$/i;
  const STOP_TOKENS = new Set([
    'the', 'and', 'for', 'with', 'not', 'you', 'your', 'are', 'was',
    'that', 'this', 'from', 'all', 'any', 'has', 'have', 'had'
  ]);

  function tokensFromSegment(seg) {
    const cleaned = String(seg || '')
      .trim()
      .replace(/^["']|["'][.,;!?]?$/g, '')   // unwrap quotes
      .replace(LOCATIVE_TAIL_RE, '')         // "... in their title" is grammar
      .replace(/[.,;!?.]+\s*$/, '');         // trailing punctuation
    return cleaned.toLowerCase().split(/[^a-z0-9']+/)
      .map(t => t.replace(/^['-]+|['-]+$/g, ''))
      .filter(t => t.length >= 3 && !STOP_TOKENS.has(t));
  }

  /**
   * Extract the literal title-token query from a command, or null.
   * Returns {token, tokens, mode:'title_contains'} where `tokens` is the
   * full conjunction list (>=1 entries) and `token` is their joined form.
   */
  function extractLiteralToken(cmd) {
    const s = String(cmd || '');
    if (!s) return null;
    if (!ACTION_VERB_RE.test(s)) return null;
    if (TITLE_SUBJECT_RE.test(s)) return null;

    let seg = null, single = null;
    let m = s.match(META_NOUN_SEG_RE);
    if (m) seg = m[1];
    if (!seg) {
      m = s.match(TITLED_SEG_RE);
      if (m) seg = m[1];
    }
    if (!seg) {
      m = s.match(WORD_TAIL_RE);
      if (m) single = m[1];
    }

    let tokens = [];
    if (single !== null) {
      const t = single.toLowerCase().replace(/^['-]+|['-]+$/g, '');
      tokens = t.length >= 3 ? [t] : [];
    } else if (seg !== null) {
      tokens = tokensFromSegment(seg);
    }
    if (!tokens.length) return null;
    return { token: tokens.join(' '), tokens, mode: 'title_contains' };
  }

  const PlanOps = { tryRestPartition, superlativeSpec, trySuperlative, extractLiteralToken };
  if (typeof module !== 'undefined' && module.exports) module.exports = PlanOps;
  if (typeof self !== 'undefined') self.PlanOps = PlanOps;
})();
