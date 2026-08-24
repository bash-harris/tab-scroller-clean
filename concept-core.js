// concept-core.js
// Splits a command into (action, concept, domains). Shared verbatim between the
// extension service worker and bench/ -- the NLI selector's accuracy depends
// entirely on getting `concept` right, so a drifting second copy would make the
// bench score something the extension does not run.
//
// Deliberately cheap and deterministic: no model call, no network. That keeps
// the NLI arm's measured score attributable to NLI rather than to an LLM's
// paraphrasing of the command.

(() => {
  // Verb -> intent. Longest-first matching so "unpin" beats "pin".
  const INTENT_VERBS = [
    ['unpin', 'unpin_tabs'], ['unmute', 'unmute_tabs'],
    ['bookmark', 'bookmark_tabs'], ['reload', 'reload_tabs'],
    ['refresh', 'reload_tabs'], ['group', 'group_tabs'],
    ['sort', 'sort_tabs'], ['close', 'close_tabs'],
    ['pin', 'pin_tabs'], ['mute', 'mute_tabs'],
    ['switch', 'search_and_switch'], ['find', 'search_and_switch'],
    ['go to', 'search_and_switch']
  ];

  // Words that carry no topic. Stripped before the concept is read off.
  //
  // This list is load-bearing, not cosmetic. The concept becomes the hypothesis
  // handed to the NLI model -- "This browser tab is about {concept}." -- so a
  // junk word left in it changes the proposition being tested. Measured on the
  // same tab with the same model, varying only the concept string:
  //
  //   "search clean energy page" -> 0.07     "clean energy"      -> 0.93
  //   "both planning documents"  -> 0.38     "planning documents"-> 0.99
  //   "two google docs"          -> 0.37     "google docs"       -> 0.96
  //   "show bitcoin"             -> 0.57     "bitcoin"           -> 0.10
  //
  // The last line is a FALSE POSITIVE being removed: a pasta-recipe tab matched
  // a bitcoin query at 0.57 purely because "show" sat in the hypothesis.
  const FILLER = new Set([
    'my', 'all', 'the', 'a', 'an', 'tabs', 'tab', 'everything', 'every', 'them',
    'those', 'these', 'this', 'that', 'about', 'related', 'to', 'of', 'for',
    'and', 'or', 'just', 'please', 'now', 'any', 'some', 'open', 'currently',
    'dont', "don't", 'do', 'not', 'no', 'me', 'i', 'is', 'are', 'with', 'on',
    'in', 'from', 'into', 'up', 'out', 'only',
    // Generic container nouns -- they name a web page, never a topic.
    'page', 'pages', 'story', 'stories', 'article', 'articles', 'tutorial',
    'guide', 'thing', 'things', 'stuff', 'item', 'items', 'site', 'sites',
    // Quantifiers and determiners left over after the verb is stripped.
    'both', 'two', 'three', 'each', 'one', 'ones', 'other', 'another',
    // Discourse particles.
    'instead', 'also', 'too', 'here', 'there', 'it', 'its', 'they', 'their',
    // Verbs that survive INTENT_VERBS stripping because they are only
    // *sometimes* verbs ("show me X", "search for X"). They never name a topic.
    // Safe to strip: parseCommand reads the action from the raw command BEFORE
    // filler removal, so dropping these cannot change intent detection.
    'show', 'search', 'want', 'need', 'give', 'bring', 'list'
  ]);

  // Phrases meaning "operate on the whole set" — no topical filter at all.
  const SELECT_ALL = /\b(everything|all (?:my |the )?tabs|all of (?:my|them)|every tab)\b/i;

  function parseCommand(raw) {
    const cmd = String(raw || '').toLowerCase().trim();

    // Negation: "don't close my docs, just group them" — the real action is the
    // one AFTER the negation, so prefer a verb that follows "just"/",".
    const negated = new Set();
    const negMatch = cmd.match(/\b(?:don'?t|do not|dont)\s+(\w+)/);
    if (negMatch) {
      for (const [verb, intent] of INTENT_VERBS) {
        if (negMatch[1].startsWith(verb.slice(0, 4))) { negated.add(intent); break; }
      }
    }

    const afterJust = cmd.split(/\bjust\b|,/).slice(1).join(' ');
    const searchOrder = afterJust ? [afterJust, cmd] : [cmd];

    const found = [];
    for (const hay of searchOrder) {
      for (const [verb, intent] of INTENT_VERBS) {
        // word-boundary so "closed caption" does not read as the verb "close"
        const re = new RegExp(`(^|[^a-z])${verb}(?![a-z])`, 'i');
        if (re.test(hay) && !negated.has(intent) && !found.includes(intent)) found.push(intent);
      }
      if (found.length) break;
    }

    // "group my closed caption tabs" — "closed" is an adjective, not the verb.
    const closedAdj = /\bclosed\s+\w/.test(cmd);
    const action = found.find(f => !(f === 'close_tabs' && closedAdj)) || found[0] || null;
    const ambiguous = found.length > 1;

    // Concept = what remains once verbs and filler are gone.
    let rest = cmd;
    for (const [verb] of INTENT_VERBS) {
      rest = rest.replace(new RegExp(`(^|[^a-z])${verb}(?![a-z])`, 'gi'), ' ');
    }
    rest = rest.replace(/\bdon'?t\b|\bdo not\b/gi, ' ');
    const words = rest.split(/[^a-z0-9.]+/i).filter(w => w && !FILLER.has(w));

    // A domain token ("youtube.com") is a precise filter, not a fuzzy concept.
    const domains = words.filter(w => /\w\.\w/.test(w));
    const concept = words.filter(w => !/\w\.\w/.test(w)).join(' ').trim();

    const isSelectAll = SELECT_ALL.test(cmd) && !concept && !domains.length;

    // An empty concept with a quantifier is select-all even when the exact
    // phrasing is not in SELECT_ALL above.
    //
    // "group all open tabs" and "pin all currently open tabs" both strip to an
    // empty concept -- every word is filler -- but the regex missed them because
    // "open"/"currently" sit between the quantifier and "tabs". The consequence
    // was not a near-miss: with no concept and isSelectAll false, the NLI
    // selector was asked whether each tab "is about <empty string>" and returned
    // nothing, so a command naming every tab selected none.
    //
    // Keyed on the quantifier rather than on emptiness alone, because a bare
    // verb ("reload") also strips to nothing and must NOT mean every tab.
    const QUANTIFIED = /\b(all|every|everything|each)\b/i;
    const quantifiedEmpty = !concept && !domains.length && QUANTIFIED.test(cmd);

    // "a sound action over every tab": the words before the quantifier are
    // verbage ("turn off the sound"), not a topic filter, when everything
    // AFTER the quantifier reduces to bare tab-words. The universe -- not the
    // verbage -- is the target. A real topic after the quantifier ("all
    // youtube tabs") keeps this false.
    let suffixUniversal = false;
    if (!isSelectAll && !quantifiedEmpty && !domains.length) {
      const m = cmd.match(QUANTIFIED);
      if (m) {
        const reduced = cmd.slice(m.index + m[0].length)
          .split(/[^a-z0-9']+/i).filter(Boolean)
          .filter(w => !FILLER.has(w.toLowerCase()))
          .join(' ');
        suffixUniversal = reduced === '' || /^(tabs?|things|stuff)$/.test(reduced);
      }
    }

    // "a bare unmute command": no quantifier anywhere, but an action verb plus a
    // word that all strips to filler while tabs are still named -- the
    // window itself is the target. Requiring the verb keeps a bare fragment
    // ("my cricket tabs") from reading as everything.
    const bareUniverse = !concept && !domains.length && found.length > 0 &&
      /\b(tabs?|everything)\b/i.test(cmd);

    return {
      action: action || 'search_and_switch',
      concept,
      domains,
      isSelectAll: isSelectAll || quantifiedEmpty || suffixUniversal || bareUniverse,
      ambiguous,
      requiresConfirmation: action === 'close_tabs'
    };
  }

  const ConceptCore = { parseCommand, INTENT_VERBS, FILLER, SELECT_ALL };

  if (typeof module !== 'undefined' && module.exports) module.exports = ConceptCore;
  if (typeof self !== 'undefined') self.ConceptCore = ConceptCore;
})();
