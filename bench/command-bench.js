// bench/command-bench.js
// Scores tab SELECTION against bench/commands.jsonl.
//
// Runs the real retrieval scorer over a frozen 15-tab pool with real MiniLM
// embeddings, and reports the metrics that matter for the product:
//
//   set-exact    selected set === expected set (the honest headline)
//   precision    of selected, how many were right
//   recall       of expected, how many were found
//   violations   tabs listed in mustNotSelect that were selected anyway
//   saturation   how many candidates tie at the top score (ranking is dead
//                when this is high -- the LLM then picks blind)
//
//   node bench/command-bench.js            current scorer
//   node bench/command-bench.js --v2       proposed scorer
//   node bench/command-bench.js --compare  both, side by side
//
// Embeddings cached in bench/.embed-cache.json, so repeat runs need no model.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE = path.join(__dirname, '.embed-cache.json');
const STOPWORDS = new Set([
  'about', 'related', 'with', 'and', 'all', 'tabs', 'the', 'group', 'close',
  'that', 'this', 'them', 'have', 'for', 'open', 'any', 'every', 'not', 'also',
  'their', 'these', 'those', 'into', 'from', 'which', 'what', 'please', 'now'
]);

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }

async function getEmbedder(cache) {
  let extractor = null;
  return async function embed(text) {
    const key = sha(text);
    if (cache[key]) return Float32Array.from(cache[key]);
    if (!extractor) {
      const { pipeline, env } = require('@xenova/transformers');
      env.cacheDir = path.join(__dirname, '.model-cache');
      extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    cache[key] = vec;
    return Float32Array.from(vec);
  };
}

function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

function tabText(t) {
  return `${t.title} ${t.url} ${t.category} ${(t.tags || []).join(' ')}`;
}

// ---------------------------------------------------------------------------
// V1 -- the scorer currently shipping in command-agent.js retrieveCandidates.
// Additive boosts on top of a cosine, then "return everything >= 0.3".
// ---------------------------------------------------------------------------
function scoreV1(cmd, tab, qVec, tVec) {
  let score = cosine(qVec, tVec);

  const tagText = (tab.tags || []).join(' ');
  const text = `${tab.title} ${tab.url} ${tab.category} ${tagText}`.toLowerCase();
  const tokens = cmd.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
  let keywordScore = 0;
  if (tokens.length) {
    let hits = 0;
    for (const tok of tokens) if (text.includes(tok)) hits++;
    keywordScore = hits / tokens.length;
  }
  if (keywordScore > score) score = keywordScore;

  // category-match boost: substring, unbounded
  const cardCategory = (tab.category || '').toLowerCase();
  const cardTags = (tab.tags || []).map(t => t.toLowerCase());
  const cmdWords = cmd.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
  for (const w of cmdWords) {
    if (cardCategory === w || cardCategory.includes(w) || cardTags.some(t => t === w || t.includes(w))) {
      score += 0.4;
      break;
    }
  }
  return score;
}

function selectV1(cmd, pool, qVec, vecs) {
  const scored = pool.map((t, i) => ({ tab: t, score: scoreV1(cmd, t, qVec, vecs[i]) }));
  scored.sort((a, b) => b.score - a.score);
  const qualified = scored.filter(s => s.score >= 0.3);
  // the floor-bypass: if fewer than 5 qualify, hand over the top 5 anyway
  const result = qualified.length >= 5 ? qualified : scored.slice(0, 5);
  return { selected: result.map(s => s.tab.id), scored };
}

// ---------------------------------------------------------------------------
// V2 -- proposed. Same inputs, no new model. Four changes:
//   1. rank-fusion instead of additive boosts, so no term can saturate
//   2. word-boundary category match (kills "port" in "sports")
//   3. relative cutoff against the top score, so a weak field returns few
//   4. no floor-bypass: zero matches is a legal answer
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// V2 deterministic pre-pass: confident lexical decisions made before any
// embedding math. Fires on (1) explicit domains / bare brand names,
// (2) all-tabs scope, (3) category-word scope. Anything else falls through
// to semantic scoring. Internal browser pages are never selectable, on any
// path.
// ---------------------------------------------------------------------------
const V2_ACTION_VERBS = [
  'pin', 'unpin', 'mute', 'unmute', 'reload', 'bookmark', 'close', 'group', 'save',
  'sort', 'organize', 'arrange', 'tidy'
];

// Browser-internal pages (new tab, extension options, ...) must never be
// acted on, regardless of what the command asks for.
function v2IsInternalTab(t) {
  const u = String((t && t.url) || '').toLowerCase();
  return u.startsWith('chrome://') || u.startsWith('chrome-extension://');
}

function v2HasActionVerb(cmdLower) {
  return V2_ACTION_VERBS.some(v => new RegExp(`\\b${v}\\b`).test(cmdLower));
}

// Host portion of a tab URL, lowercased, leading "www." stripped.
function v2TabHost(t) {
  const m = String(t.url || '').toLowerCase().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/);
  return m ? m[1].replace(/^www\./, '') : '';
}

// Rule 2: command scopes to every selectable tab ("everything" /
// "all [my|the|open] tabs" / "every tab") combined with an action verb.
function v2AllTabsFired(cmdLower) {
  const scopedToAll =
    /\beverything\b/.test(cmdLower) ||
    /\b(?:all|every|each)\s+(?:my\s+|the\s+|open\s+|of\s+(?:my\s+|the\s+)?)?tabs?\b/.test(cmdLower);
  return scopedToAll && v2HasActionVerb(cmdLower);
}

// Dotted host-like tokens in the command ("youtube.com", "bbc.co.uk", ...).
function v2DomainTokens(cmdLower) {
  const out = [];
  const re = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/g;
  let m;
  while ((m = re.exec(cmdLower)) !== null) out.push(m[0]);
  return out;
}

// Bare-brand -> canonical hosts (general world knowledge, like an ontology:
// people say "amazon" without a TLD and mean amazon's properties). A tab
// matches a host when its hostname equals the host or is a subdomain of it
// ("music.youtube.com" counts for youtube). Matching is on HOSTS only, never
// raw URL substrings: an article whose URL PATH mentions "amazon-alternatives"
// lives on some other host and is not an Amazon tab. Distinct brands stay
// distinct: primevideo.com is not amazon.*, so neither query grabs the other.
const V2_BRAND_HOSTS = {
  amazon:     ['amazon.com', 'amazon.in', 'amazon.co.uk'],
  youtube:    ['youtube.com', 'youtu.be', 'music.youtube.com'],
  github:     ['github.com'],
  reddit:     ['reddit.com'],
  google:     ['google.com'],
  gmail:      ['mail.google.com'],
  ebay:       ['ebay.com'],
  flipkart:   ['flipkart.com'],
  primevideo: ['primevideo.com'],
  netflix:    ['netflix.com'],
  spotify:    ['spotify.com'],
  twitch:     ['twitch.tv'],
  wikipedia:  ['wikipedia.org'],
  twitter:    ['twitter.com', 'x.com'],
  x:          ['x.com', 'twitter.com']
};

// Compound phrases narrow their generic brand: "google docs" is
// docs.google.com specifically -- Gmail shares google.com hosting but is not
// a doc, so the bare "google" expansion must not fire for that phrase.
const V2_BRAND_PHRASES = {
  'google docs':  ['docs.google.com'],
  'google drive': ['drive.google.com'],
  'google mail':  ['mail.google.com']
};

// Nouns that describe the SCOPE of a command rather than naming a referent
// ("close all tabs", "pin the deals page"). Never site names themselves.
const V2_GENERIC_SCOPE_WORDS = new Set([
  'tab', 'tabs', 'page', 'pages', 'site', 'sites', 'link', 'links',
  'url', 'urls', 'domain', 'domains', 'one', 'ones', 'thing', 'things',
  'stuff', 'window', 'windows', 'folder'
]);

// Negation / exception cues. A command that carves out exceptions or states a
// negative ("everything except X", "not the Y ones") is not safe for an
// affirmative bulk rule: the complement reading wins, and complements are not
// decided lexically. Defer those commands to semantic scoring instead.
const V2_NEGATION_RE =
  /\b(?:not|no|never|except|without|keep|keeping|leave|leaving|exclude|excluding|skip|skipping|apart|aside|instead|other than|dont|doesnt|didnt|isnt|arent|wasnt|werent|cant|cannot|wont|shouldnt|wouldnt|couldnt)\b|[a-z]'t\b/i;

function v2HasNegationCue(cmdLower) {
  return V2_NEGATION_RE.test(cmdLower);
}

// Negation shapes that leave the named referent as the true target, so the
// affirmative rules stay safe:
//   desire:     "don't want any shopping tabs open anymore"
//               -> user declines the category; category reading holds.
//   replacement:"don't mute the finance tab, just pin it"
//               -> verb is swapped, object referent unchanged.
function v2NegationIsHarmless(cmdLower) {
  return /\b(?:dont|don'?t|do not)\s+(?:want|wanna|wish|need)\b/.test(cmdLower) ||
    /\bno\s+(?:more|longer)\b/.test(cmdLower) ||
    /\b(?:dont|don'?t|do not)\b[\w\s'-]*,\s*(?:just|simply|only)\b/.test(cmdLower);
}

// Collect every host the command explicitly references: dotted tokens
// ("youtube.com"), bare brands ("amazon"), compound brand phrases
// ("google docs"). All matches union together, so "flipkart and ebay" spans
// both stores. `consumed` records the command words each host claim used, so
// later checks know which tokens were already explained.
function v2CollectScopeHosts(cmdLower) {
  const hosts = [];
  const consumed = new Set();
  const push = (h, words) => {
    if (!hosts.includes(h)) hosts.push(h);
    for (const w of words) consumed.add(w);
  };

  // Explicit dotted domains first: "amazon.in" scopes to amazon.in ONLY --
  // its fragments must not also trigger the generic amazon brand expansion.
  for (const d of v2DomainTokens(cmdLower)) push(d, d.split('.'));

  const words = cmdLower.split(/[^a-z0-9]+/).filter(Boolean);

  // Compound brand phrases take their two words off the table.
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (V2_BRAND_PHRASES[phrase]) {
      for (const h of V2_BRAND_PHRASES[phrase]) push(h, [words[i], words[i + 1]]);
    }
  }

  // Remaining single-word brands.
  for (const w of words) {
    if (!consumed.has(w) && V2_BRAND_HOSTS[w]) {
      for (const h of V2_BRAND_HOSTS[w]) push(h, [w]);
    }
  }

  return { hosts, consumed };
}

// A leftover command word that looks like ANOTHER SITE we could not map means
// the scope is only partially understood ("gmail and wiki tabs" where wiki is
// not in the brand table): defer rather than silently dropping a referent.
// Ordinary descriptors ("deals page", "queue tabs") never look like a host,
// so they do not block a confident decision.
function v2HasUnmappedSiteWord(cmdLower, consumed, pool) {
  const hosts = pool.map(v2TabHost).filter(Boolean);
  const words = cmdLower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (w.length < 3 || consumed.has(w)) continue;
    if (STOPWORDS.has(w) || V2_ACTION_VERBS.includes(w)) continue;
    if (V2_GENERIC_SCOPE_WORDS.has(w)) continue;
    if (V2_BRAND_HOSTS[w]) continue; // a known brand with zero open tabs is a clean abstain below
    if (hosts.some(h => h.includes(w))) return true;
  }
  return false;
}

// Returns an array of pool ids when a deterministic rule decides outright
// (possibly empty: a named site with zero open tabs is an honest abstain),
// or null to defer to semantic scoring. `pool` here is already filtered to
// selectable tabs.
function v2DeterministicSelect(cmd, pool) {
  const cmdLower = cmd.toLowerCase();

  // Negation / exception-shaped commands: affirmative bulk rules must not
  // guess (the complement reading wins and complements are not decided
  // lexically). Desire- and replacement-shaped negations are exempt.
  const negated = v2HasNegationCue(cmdLower) && !v2NegationIsHarmless(cmdLower);

  // Rule 1 (highest precedence): explicit domains and bare brands. Wins over
  // the all-tabs rule, so "close all tabs on espncricinfo.com" is scoped by
  // the site, not by "all tabs".
  if (!negated) {
    const scope = v2CollectScopeHosts(cmdLower);
    if (scope.hosts.length) {
      if (v2HasUnmappedSiteWord(cmdLower, scope.consumed, pool)) return null;
      const sel = [];
      for (const t of pool) {
        const host = v2TabHost(t);
        if (host && scope.hosts.some(d => host === d || host.endsWith('.' + d))) sel.push(t.id);
      }
      return sel;
    }

    // Rule 2: all tabs.
    if (v2AllTabsFired(cmdLower)) return pool.map(t => t.id);

    // Rule 3: category-word scope ("sports tabs", "finance tab", ...). Whole-word
    // compare against actual category values, tolerating the trivial plural.
    // Un-prefixed verbs (unpin/unmute) are irrelevant here: selection keys off the
    // category noun alone, so they cannot skew this rule.
    const cats = [...new Set(pool.map(t => String(t.category || '').toLowerCase()))];
    const words = cmdLower.split(/[^a-z0-9]+/).filter(Boolean);
    let catHit = null;
    outer:
    for (const c of cats) {
      for (const w of words) {
        if (w === c || w === c + 's' || c === w + 's') { catHit = c; break outer; }
      }
    }
    if (catHit) {
      return pool.filter(t => String(t.category || '').toLowerCase() === catHit).map(t => t.id);
    }
  }

  return null;
}

// Topic equivalence table: generic world knowledge mapping a command topic to
// concept phrases that literally appear in tab title/url/tags text even when
// the topic word itself does not ("Ashes" -> England v Australia Test series,
// "clean power" -> solar farm). Keys may be a single command word or an
// adjacent word pair; values are phrases matched word-by-word.
const V2_TOPIC_SYNONYMS = {
  cricket: ['test match', 'ashes', 'ipl', 'england australia', 'old trafford'],
  ashes: ['test series', 'england australia', 'old trafford'],
  football: ['premier league', 'fifa', 'soccer', 'uefa'],
  soccer: ['premier league', 'fifa', 'football', 'uefa'],
  keyboard: ['keyboards', 'mechanical keyboard', 'keebtalk', 'hardware'],
  caption: ['captions', 'subtitles', 'closed captions'],
  docs: ['document', 'documents', 'google docs'],
  stock: ['stocks', 'share price', 'equities', 'wall street', 'bloomberg', 'nasdaq'],
  market: ['markets', 'economy', 'finance', 'trading', 'stocks', 'wall street'],
  crypto: ['bitcoin', 'ethereum', 'blockchain', 'btc', 'nft', 'coinbase', 'web3'],
  power: ['solar', 'renewable', 'wind energy', 'green energy', 'solar farm'],
  'clean power': ['solar', 'renewable', 'wind energy', 'green energy'],
  tech: ['technology', 'software', 'hardware', 'keyboard', 'captions', 'coding'],
  technology: ['tech', 'software', 'hardware', 'gadgets'],
  cat: ['cats', 'kitten', 'kittens', 'feline'],
  travel: ['trip', 'vacation', 'beaches', 'flights']
};

// Compound topics whose meaning differs from their parts: "fantasy football"
// is league management, not match coverage. Their words are OPAQUE -- they
// neither expand nor lexically match their ordinary single-word senses.
const V2_OPAQUE_TOPICS = new Set(['fantasy football']);

function v2TopicExpansion(cmdWords) {
  const out = [];
  const push = (phrases) => { for (const p of phrases) if (!out.includes(p)) out.push(p); };
  const opaque = new Set();
  for (let i = 0; i < cmdWords.length - 1; i++) {
    const pair = `${cmdWords[i]} ${cmdWords[i + 1]}`;
    if (V2_OPAQUE_TOPICS.has(pair)) {
      opaque.add(cmdWords[i]);
      opaque.add(cmdWords[i + 1]);
    } else if (V2_TOPIC_SYNONYMS[pair]) {
      push(V2_TOPIC_SYNONYMS[pair]);
    }
  }
  for (const w of cmdWords) {
    if (!opaque.has(w) && V2_TOPIC_SYNONYMS[w]) push(V2_TOPIC_SYNONYMS[w]);
  }
  return { phrases: out, opaque };
}

// Alphanumeric token bag: punctuation/hyphens/dots become separators, so
// "test-match" yields tokens "test" and "match" and a phrase matches when all
// of its words appear as standalone tokens.
function v2TokenSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean));
}

function selectV2(cmd, pool, qVec, vecs) {
  // Internal pages (chrome://, chrome-extension://) are never candidates:
  // excluded from deterministic rules AND from semantic scoring, so no
  // selection path can ever emit one.
  const cand = pool
    .map((t, i) => ({ tab: t, vec: vecs[i] }))
    .filter(p => !v2IsInternalTab(p.tab));
  const selPool = cand.map(p => p.tab);

  // Deterministic pre-pass: when a rule decides outright, skip embeddings.
  const detIds = v2DeterministicSelect(cmd, selPool);
  if (detIds) {
    const rankOfId = new Map(detIds.map((id, i) => [id, i]));
    const scored = cand.map((p) => ({
      tab: p.tab, vec: 0, lex: 0, dom: 0,
      score: rankOfId.has(p.tab.id) ? 1 - rankOfId.get(p.tab.id) * 0.001 : 0
    }));
    scored.sort((a, b) => b.score - a.score);
    return { selected: detIds.slice(), scored };
  }

  const cmdLower = cmd.toLowerCase();
  const cmdWords = cmdLower.split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  const { phrases: expansions, opaque: opaqueWords } = v2TopicExpansion(cmdWords);
  // Opaque compound-topic words ("fantasy" in "fantasy football") do not lex
  //ically match their ordinary single-word senses.
  const lexWords = cmdWords.filter(w => !opaqueWords.has(w));

  const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');

  const rows = cand.map((p) => {
    const tab = p.tab;
    const vec = cosine(qVec, p.vec);

    const hay = `${tab.title} ${tab.category} ${(tab.tags || []).join(' ')}`.toLowerCase();
    let lex = 0;
    for (const w of lexWords) if (wordRe(w).test(hay)) lex++;
    lex = lexWords.length ? lex / lexWords.length : 0;

    // domain match is a separate, precise signal
    let dom = 0;
    for (const w of cmdWords) {
      if (/\./.test(w) && tab.url.toLowerCase().includes(w.replace(/^www\./, ''))) dom = 1;
    }

    // query-side knowledge expansion: count equivalence-table phrases whose
    // words all appear in the tab's title/url/category/tags text
    let exp = 0;
    if (expansions.length) {
      const toks = v2TokenSet(tabText(tab));
      for (const phrase of expansions) {
        if (phrase.split(' ').every(w => toks.has(w))) exp++;
      }
    }
    return { tab, vec, lex, dom, exp };
  });

  // Reciprocal-rank fusion over the three signals: scale-free, so a single
  // signal cannot dominate the way the +0.4 additive boost did.
  const rankOf = (key) => {
    const order = [...rows].sort((a, b) => b[key] - a[key]);
    const m = new Map();
    order.forEach((r, i) => m.set(r.tab.id, i + 1));
    return m;
  };
  const rv = rankOf('vec'), rl = rankOf('lex'), rd = rankOf('dom');
  const K = 10;
  for (const r of rows) {
    r.score = 1 / (K + rv.get(r.tab.id)) + 1 / (K + rl.get(r.tab.id)) + 1 / (K + rd.get(r.tab.id));
    // hard evidence overrides fusion: exact domain hit, a full lexical match,
    // or an expansion-phrase hit recovered from the topic equivalence table
    if (r.dom === 1) r.score += 1;
    if (r.lex >= 0.99) r.score += 0.5;
    if (r.exp > 0) r.score += 0.5;
  }
  rows.sort((a, b) => b.score - a.score);

  // Hard evidence: direct lexical/domain support or an expansion-phrase match.
  const hasEvidence = (r) => r.dom === 1 || r.lex >= 0.5 || r.exp > 0;

  // Abstain only when NO row shows hard evidence; a noise row topping the
  // fused ranking must not veto tabs that have real support.
  const top = rows[0];
  if (!top || !rows.some(hasEvidence)) return { selected: [], scored: rows };

  const selected = rows
    .filter((r) => (hasEvidence(r) || r.vec >= 0.35) && r.score >= top.score * 0.72)
    .map((r) => r.tab.id);
  return { selected, scored: rows };
}

function evaluate(name, selectFn, pool, cmds, qVecs, vecs) {
  let exact = 0, precSum = 0, recSum = 0, violations = 0, satSum = 0, n = 0;
  let abstainCases = 0, abstainCorrect = 0, closeWrong = 0, closeSelected = 0;
  const failures = [];

  for (const c of cmds) {
    const { selected, scored } = selectFn(c.command, pool, qVecs[c.command], vecs);
    const exp = new Set(c.expectedTabIds || []);
    const got = new Set(selected);

    const tp = [...got].filter(id => exp.has(id)).length;
    const precision = got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    const recall = exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
    const isExact = got.size === exp.size && [...exp].every(id => got.has(id));

    const viol = (c.mustNotSelect || []).filter(id => got.has(id)).length;

    // D0 gates: abstention correctness and wrong-tab closes on destructive intents.
    if (exp.size === 0) { abstainCases++; if (got.size === 0) abstainCorrect++; }
    if (c.expectedIntent === 'close_tabs' && exp.size > 0) {
      closeSelected += got.size; closeWrong += (got.size - tp);
    }

    // saturation: how many candidates tie within 1e-9 of the top score
    const topScore = scored.length ? scored[0].score : 0;
    const tied = scored.filter(s => Math.abs(s.score - topScore) < 1e-9).length;

    if (isExact) exact++;
    precSum += precision; recSum += recall; violations += viol; satSum += tied; n++;

    if (!isExact || viol) {
      failures.push({
        command: c.command,
        expected: [...exp].sort((a, b) => a - b),
        got: [...got].sort((a, b) => a - b),
        viol
      });
    }
  }

  return {
    name,
    exact, n,
    precision: precSum / n,
    recall: recSum / n,
    violations,
    saturation: satSum / n,
    abstainCorrect,
    abstainCases,
    closeWrong,
    closeSelected,
    failures
  };
}

function report(r) {
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`\n${r.name}`);
  console.log('-'.repeat(58));
  console.log(`  set-exact        ${r.exact}/${r.n} (${pct(r.exact / r.n)})`);
  console.log(`  precision        ${pct(r.precision)}`);
  console.log(`  recall           ${pct(r.recall)}`);
  console.log(`  mustNotSelect    ${r.violations} violation(s)`);
  console.log(`  abstain-correct  ${r.abstainCases ? `${r.abstainCorrect}/${r.abstainCases}` : 'n/a'}`);
  console.log(`  false-close      ${r.closeWrong}/${r.closeSelected} selected-on-close wrong`);
  console.log(`  top-score ties   ${r.saturation.toFixed(1)} avg candidates tied at #1`);
}

// Exported for golden-bench.js; the CLI main below only runs when invoked
// directly, so requiring this file has no side effects.
module.exports = { selectV1, selectV2, scoreV1, tabText };

if (require.main !== module) return;

(async () => {
  const fileArgIdx = process.argv.indexOf('--file');
  const dataFile = path.join(__dirname, fileArgIdx > -1 ? process.argv[fileArgIdx + 1] : 'commands.jsonl');
  const recs = fs.readFileSync(dataFile, 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
  const pool = recs.find(r => r._tabPool)._tabPool;
  // Selection scorers below cannot grade bucket membership, so multi-group
  // planning cases are counted out rather than mis-scored as zero-match.
  const allCmds = recs.filter(r => r.command);
  const multiCmds = allCmds.filter(c => c.expectedIntent === 'group_multi');
  const cmds = allCmds.filter(c => c.expectedIntent !== 'group_multi');

  const cache = loadCache();
  const embed = await getEmbedder(cache);

  const vecs = [];
  for (const t of pool) vecs.push(await embed(tabText(t)));
  const qVecs = {};
  for (const c of cmds) qVecs[c.command] = await embed(c.command);
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  console.log(`\nCOMMAND BENCH  --  ${cmds.length} commands over a ${pool.length}-tab pool (${dataFile.split(/[\\/]/).pop()})`);
  if (multiCmds.length) console.log(`  (skipping ${multiCmds.length} group_multi case(s): selection scorers cannot grade bucket membership)`);
  console.log('='.repeat(58));

  const wantV2 = process.argv.includes('--v2');
  const wantCompare = process.argv.includes('--compare');

  const results = [];
  if (!wantV2 || wantCompare) results.push(evaluate('V1  (currently shipping)', selectV1, pool, cmds, qVecs, vecs));
  if (wantV2 || wantCompare) results.push(evaluate('V2  (proposed)', selectV2, pool, cmds, qVecs, vecs));

  results.forEach(report);

  const last = results[results.length - 1];
  console.log(`\n  failures for ${last.name}:`);
  for (const f of last.failures.slice(0, 12)) {
    console.log(`   "${f.command}"`);
    console.log(`      expected [${f.expected}]  got [${f.got}]${f.viol ? `  ** ${f.viol} FORBIDDEN **` : ''}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
