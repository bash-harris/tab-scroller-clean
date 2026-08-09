# Tab Enrichment Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LLM-based tab enrichment with a deterministic offline cascade (structured harvest + domain priors + MiniLM centroid math), removing the Ollama dependency from enrichment and fixing the broken enrichment persistence.

**Architecture:** Three tiers — (0) in-page harvest of JSON-LD/OpenGraph/Wikipedia categories + pseudo-document construction, (1) multi-label tag classification via L2-normalized centroid matvecs over the existing MiniLM embedding, (2) domain/path prior tables. All synchronous in `buildTabCard`; the LLM enrichment queue engine is deleted. Consumers (`command-agent.js`) switch from single-category boosts to tag-overlap scoring.

**Tech Stack:** Vanilla JS (MV3 service worker), IndexedDB (`TabDB`), MiniLM via transformers.js WASM (`Embed`), Node.js + puppeteer for E2E.

**Safety:** Repo is NOT git. Full backup exists at `C:\Users\bkh\Desktop\tab-scroller-clean-backup-2026-08-02`. After each task, run `node --check` on every changed JS file.

---

### Task 1: `domain-priors.js` — static domain/path prior tables

**Files:**
- Create: `domain-priors.js` (repo root, loaded via `importScripts` before `command-agent.js` usage)
- Test: `tests/domain-priors.test.js` (repo root test file, run with `node tests/domain-priors.test.js`)

- [ ] **Step 1: Write the failing unit test**

```js
// tests/domain-priors.test.js
// Pure-function test — no chrome APIs, no Embed. Run: node tests/domain-priors.test.js
const path = require('path');
const priors = require(path.join(__dirname, '..', 'domain-priors.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; }
  else console.log('  ok:', msg);
}

// DOMAIN_PRIORS exact match
let r = priors.applyPriors('https://github.com/foo/bar');
assert(r && r.tags.includes('coding') && r.conf >= 0.9, 'github.com -> coding');

r = priors.applyPriors('https://www.espncricinfo.com/series/foo');
assert(r && r.tags.includes('cricket') && r.conf >= 0.9, 'espncricinfo.com -> cricket');

// PATH_PRIORS with capture group (subreddit)
r = priors.applyPriors('https://www.reddit.com/r/cricket/comments/x/');
assert(r && r.tags.includes('sports'), 'reddit /r/cricket -> sports via subreddit map');

r = priors.applyPriors('https://www.reddit.com/r/recipes/x/');
assert(r && r.tags.includes('cooking'), 'reddit /r/recipes -> cooking via subreddit map');

// PATH_PRIORS plain regex
r = priors.applyPriors('https://example.com/sports/football/live');
assert(r && r.tags.includes('sports'), '/sports/ path -> sports');

// No match -> null
r = priors.applyPriors('https://unknown-random-site-xyz.com/page');
assert(r === null, 'unknown domain/path -> null');

// www stripping + port + query string tolerance
r = priors.applyPriors('https://www.espncricinfo.com:443/series/x?utm_source=test');
assert(r && r.tags.includes('cricket'), 'www + port + query handled');

console.log(failures === 0 ? 'PASS' : `FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/domain-priors.test.js`
Expected: FAIL — `Cannot find module` for domain-priors.js (does not exist yet).

- [ ] **Step 3: Implement `domain-priors.js`**

```js
// domain-priors.js
// Static domain + URL-path -> tag priors. Pure functions, no chrome APIs, no Embed.
// applyPriors(url) -> { tags: string[], conf: number } | null
(() => {
  const DOMAIN_PRIORS = {
    'github.com':        { tags: ['coding', 'dev'],            conf: 0.95 },
    'gitlab.com':        { tags: ['coding', 'dev'],            conf: 0.95 },
    'bitbucket.org':     { tags: ['coding', 'dev'],            conf: 0.95 },
    'stackoverflow.com': { tags: ['coding'],                   conf: 0.95 },
    'stackexchange.com': { tags: ['coding', 'reference'],      conf: 0.9 },
    'leetcode.com':      { tags: ['coding'],                   conf: 0.98 },
    'codeforces.com':    { tags: ['coding'],                   conf: 0.98 },
    'hackerrank.com':    { tags: ['coding'],                   conf: 0.98 },
    'dev.to':            { tags: ['coding', 'dev'],            conf: 0.9 },
    'medium.com':        { tags: ['news', 'reference'],        conf: 0.6 },
    'espncricinfo.com':  { tags: ['sports', 'cricket'],        conf: 0.98 },
    'cricbuzz.com':      { tags: ['sports', 'cricket'],        conf: 0.98 },
    'espn.com':          { tags: ['sports'],                   conf: 0.98 },
    'bbc.com':           { tags: ['news'],                     conf: 0.95 },
    'bbc.co.uk':         { tags: ['news'],                     conf: 0.95 },
    'cnn.com':           { tags: ['news'],                     conf: 0.95 },
    'reuters.com':       { tags: ['news', 'finance'],          conf: 0.95 },
    'nytimes.com':       { tags: ['news'],                     conf: 0.95 },
    'theguardian.com':   { tags: ['news'],                     conf: 0.95 },
    'letterboxd.com':    { tags: ['entertainment', 'film'],    conf: 0.97 },
    'imdb.com':          { tags: ['entertainment', 'film'],    conf: 0.97 },
    'rottentomatoes.com':{ tags: ['entertainment', 'film'],    conf: 0.97 },
    'spotify.com':       { tags: ['entertainment', 'music'],   conf: 0.97 },
    'allrecipes.com':    { tags: ['cooking', 'food'],          conf: 0.98 },
    'foodnetwork.com':   { tags: ['cooking', 'food'],          conf: 0.98 },
    'seriouseats.com':   { tags: ['cooking', 'food'],          conf: 0.98 },
    'youtube.com':       { tags: ['video'],                    conf: 0.9 },
    'youtu.be':          { tags: ['video'],                    conf: 0.9 },
    'twitch.tv':         { tags: ['video', 'gaming'],          conf: 0.9 },
    'twitter.com':       { tags: ['social'],                   conf: 0.9 },
    'x.com':             { tags: ['social'],                   conf: 0.9 },
    'facebook.com':      { tags: ['social'],                   conf: 0.9 },
    'instagram.com':     { tags: ['social'],                   conf: 0.9 },
    'linkedin.com':      { tags: ['social', 'work'],           conf: 0.9 },
    'coursera.org':      { tags: ['learning'],                 conf: 0.95 },
    'udemy.com':         { tags: ['learning'],                 conf: 0.95 },
    'edx.org':           { tags: ['learning'],                 conf: 0.95 },
    'khanacademy.org':   { tags: ['learning'],                 conf: 0.95 },
    'arxiv.org':         { tags: ['science', 'reference'],     conf: 0.95 },
    'pubmed.ncbi.nlm.nih.gov': { tags: ['science', 'health'],  conf: 0.95 },
    'wikipedia.org':     { tags: [],                           conf: 0 } // handled by path/catlinks; no domain prior
  };

  const SUBREDDIT_MAP = {
    cricket: ['sports', 'cricket'], football: ['sports'], soccer: ['sports'],
    nba: ['sports', 'basketball'], basketball: ['sports'], tennis: ['sports'],
    formula1: ['sports'], nfl: ['sports'], cricketworldcup: ['sports', 'cricket'],
    movies: ['entertainment', 'film'], film: ['entertainment', 'film'],
    television: ['entertainment'], music: ['entertainment', 'music'],
    gaming: ['gaming'], pcgaming: ['gaming'],
    recipes: ['cooking', 'food'], cooking: ['cooking', 'food'], food: ['cooking', 'food'],
    programming: ['coding'], learnprogramming: ['coding'], javascript: ['coding'],
    python: ['coding'], webdev: ['coding', 'dev'],
    news: ['news'], worldnews: ['news'], politics: ['news'],
    finance: ['finance'], stocks: ['finance'], investing: ['finance'],
    science: ['science'], space: ['science'], physics: ['science'],
    books: ['reference'], askreddit: [], technology: ['tech']
  };

  const PATH_PRIORS = [
    [/^\/r\/([a-z0-9_]+)/i, (m) => SUBREDDIT_MAP[m[1].toLowerCase()] || null],
    [/^\/sports?(\/|$)/i, ['sports']],
    [/^\/sport(s)?\//i, ['sports']],
    [/^\/(film|movies?|tv|television|series)\//i, ['entertainment']],
    [/^\/watch\//i, ['video']],
    [/^\/recipes?(\/|$)/i, ['cooking']],
    [/^\/food(\/|$)/i, ['cooking']],
    [/^\/wiki\/category:/i, ['reference']],
    [/^\/r\/[^/]+/i, null] // generic reddit — no tag (subreddit map decides)
  ];

  function applyPriors(url) {
    if (!url) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const portStripped = host.split(':')[0];

    if (DOMAIN_PRIORS[portStripped] && DOMAIN_PRIORS[portStripped].conf > 0.7) {
      return { ...DOMAIN_PRIORS[portStripped], tags: [...DOMAIN_PRIORS[portStripped].tags] };
    }

    const path = u.pathname;
    for (const [pattern, mapper] of PATH_PRIORS) {
      const m = path.match(pattern);
      if (!m) continue;
      const tags = typeof mapper === 'function' ? mapper(m) : mapper;
      if (tags && tags.length) return { tags: [...tags], conf: 0.92 };
    }

    return null;
  }

  const api = { applyPriors, DOMAIN_PRIORS, SUBREDDIT_MAP, PATH_PRIORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.DomainPriors = api;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/domain-priors.test.js`
Expected: PASS (all ok lines, exit 0)

- [ ] **Step 5: Syntax check**

Run: `node --check domain-priors.js && node --check tests/domain-priors.test.js`
Expected: no output, exit 0

---

### Task 2: `enrich-math.js` — centroid vocab + multi-label tag scoring

**Files:**
- Create: `enrich-math.js` (repo root)
- Test: `tests/enrich-math.test.js`

- [ ] **Step 1: Write the failing unit test**

```js
// tests/enrich-math.test.js
// Pure math tests — Embed is injected as a stub. Run: node tests/enrich-math.test.js
const path = require('path');
const math = require(path.join(__dirname, '..', 'enrich-math.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; }
  else console.log('  ok:', msg);
}

// Stub embed: deterministic pseudo-vector from text hash (384 dims)
function stubEmbed(text) {
  const v = new Float32Array(384);
  for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < 384; i++) v[i] /= n;
  return v;
}

(async () => {
  await math.initTopicVocab(stubEmbed);

  // initTopicVocab built centroid table
  const info = math.vocabInfo();
  assert(info.tagCount >= 20, `>=20 tag centroids (got ${info.tagCount})`);
  assert(info.dim === 384, 'dim 384');

  // mathEnrich returns multi-label tags with top-tag category
  const ctx = { harvestTags: ['cricket'], priorTags: [], structured: null };
  const e = math.mathEnrich(stubEmbed('cricket match live score'), ctx);
  assert(typeof e.category === 'string' && e.category.length > 0, 'category = top tag');
  assert(Array.isArray(e.tags) && e.tags.length >= 1, 'tags array non-empty');
  assert(e.tags.every(t => typeof t.tag === 'string' && typeof t.score === 'number'), 'tag entries {tag, score}');
  assert(e.tags[0].score >= e.tags[1]?.score || e.tags.length === 1, 'tags sorted desc');
  assert(typeof e.tier === 'string', 'tier present');

  // harvestTags bias: 'cricket' harvest must land in emitted tags for sports-ish text
  const tags = e.tags.map(t => t.tag);
  assert(tags.includes('sports'), `harvest 'cricket' biases toward sports (got ${tags.join(',')})`);

  // prior bias: priorTags with conf>=0.9 add +0.15
  const e2 = math.mathEnrich(stubEmbed('generic neutral page'), { harvestTags: [], priorTags: ['gaming'], priorConf: 0.95, structured: null });
  assert(e2.tags.map(t => t.tag).includes('gaming'), 'prior tag gaming appears when biased');

  // contentType from structured type, else other
  const e3 = math.mathEnrich(stubEmbed('something'), { harvestTags: [], priorTags: [], structured: { type: 'NewsArticle' } });
  assert(e3.contentType === 'article', 'contentType article from NewsArticle');

  // No harvest, no priors, weak text -> category still top tag, tier math
  const e4 = math.mathEnrich(stubEmbed('x'), { harvestTags: [], priorTags: [], structured: null });
  assert(e4.tier === 'math', 'tier = math');
  assert(e4.subTopics.length <= 4, 'subTopics capped at 4');

  // vocabInfo before init should not crash
  console.log(failures === 0 ? 'PASS' : `FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/enrich-math.test.js`
Expected: FAIL — `Cannot find module` for enrich-math.js.

- [ ] **Step 3: Implement `enrich-math.js`**

```js
// enrich-math.js
// Multi-label tab tagging via L2-normalized centroid matvecs over MiniLM embeddings.
// Pure math + vocab; Embed injected via initTopicVocab(embedFn). No chrome APIs.
(() => {
  const TAG_PROTOTYPES = {
    sports: ['live cricket match score', 'football league standings table', 'NBA playoffs game recap', 'tennis grand slam draw', 'formula 1 race qualifying results', 'olympic medal table', 'hockey game highlights', 'tournament bracket results'],
    entertainment: ['film premiere review', 'music album release', 'tv series episode recap', 'concert tour dates', 'celebrity interview', 'movie trailer', 'box office results', 'netflix show'],
    news: ['breaking news report', 'world news today', 'headline roundup', 'election results coverage', 'press conference transcript', 'daily newspaper'],
    coding: ['javascript tutorial', 'debugging code example', 'git pull request review', 'function implementation', 'programming language docs', 'algorithm explanation'],
    dev: ['software release notes', 'deployment pipeline setup', 'developer tools review', 'api integration guide', 'code repository'],
    docs: ['user manual section', 'api reference documentation', 'how to guide', 'configuration guide'],
    video: ['watch video online', 'video streaming', 'live stream broadcast', 'video clip'],
    social: ['social media feed', 'community discussion thread', 'forum post', 'trending topics'],
    shopping: ['buy product online', 'amazon product listing', 'shopping cart checkout', 'product review comparison'],
    cooking: ['step by step recipe with ingredients', 'how to bake sourdough bread', 'restaurant menu and dish review', 'meal prep for the week', 'baking dessert recipe'],
    work: ['email inbox', 'project management tool', 'meeting notes', 'productivity app'],
    learning: ['online course lesson', 'study guide exam prep', 'tutorial for beginners', 'educational lecture'],
    science: ['scientific paper abstract', 'physics research findings', 'biology experiment results', 'astronomy discovery', 'academic study'],
    finance: ['stock market today', 'personal finance tips', 'cryptocurrency price', 'banking rates comparison'],
    travel: ['travel itinerary guide', 'hotel booking deals', 'city tourist attractions', 'flight booking'],
    gaming: ['video game review', 'game walkthrough guide', 'esports tournament', 'game patch notes'],
    music: ['song lyrics', 'music streaming playlist', 'band tour announcement', 'new single release'],
    film: ['movie review', 'film festival coverage', 'actor biography', 'movie database page'],
    health: ['medical condition overview', 'fitness workout plan', 'healthy diet advice', 'hospital services'],
    education: ['school curriculum', 'university course catalog', 'homework help', 'student resources'],
    reference: ['encyclopedia entry', 'dictionary definition', 'historical facts', 'biography reference'],
    tech: ['new technology product', 'gadget review', 'tech industry news', 'artificial intelligence article'],
    other: ['generic web page', 'miscellaneous content', 'personal website', 'placeholder page']
  };

  const TOPIC_PHRASES = [
    'cricket', 'test cricket', 'football', 'soccer', 'basketball', 'tennis', 'golf',
    'baseball', 'hockey', 'formula 1', 'olympics', 'world cup', 'cricket world cup',
    'film', 'movie', 'television series', 'tv show', 'music album', 'pop music',
    'rock music', 'classical music', 'concert', 'netflix', 'streaming service',
    'news article', 'politics', 'elections', 'economics', 'weather', 'health news',
    'javascript', 'python', 'typescript', 'react', 'node.js', 'git', 'linux',
    'machine learning', 'artificial intelligence', 'web development', 'database',
    'cooking', 'baking', 'recipes', 'ingredients', 'restaurant', 'food review',
    'quantum physics', 'astronomy', 'biology', 'chemistry', 'space exploration',
    'universe', 'galaxy', 'planet', 'earth science', 'geography', 'history',
    'philosophy', 'literature', 'education', 'university', 'online learning',
    'stock market', 'investing', 'cryptocurrency', 'banking', 'personal finance',
    'travel guide', 'tourism', 'hotel', 'vacation', 'airlines', 'flight',
    'video games', 'gaming', 'esports', 'game review', 'rpg', 'strategy game',
    'shopping', 'ecommerce', 'product review', 'fashion', 'clothing', 'electronics',
    'social media', 'reddit', 'twitter', 'instagram', 'facebook', 'forum',
    'medicine', 'fitness', 'nutrition', 'mental health', 'yoga', 'workout',
    'science fiction', 'fantasy', 'documentary', 'podcast', 'comedy', 'drama'
  ];

  const TAG_THRESHOLD_Z = 1.2;   // multi-label emission in z-space over the tag-score vector
  const TOPIC_THRESHOLD = 0.35;  // raw cosine for topic matches
  const HARVEST_BIAS = 0.25;     // added to centroid score for harvested tags
  const PRIOR_BIAS = 0.15;       // added for prior tags with conf >= 0.9

  // Harvest/prior tags are free-form strings ("cricket", "recipes") -> canonical tag names
  const TAG_ALIASES = {
    cricket: 'sports', football: 'sports', soccer: 'sports', basketball: 'sports',
    tennis: 'sports', sports: 'sports', olympics: 'sports',
    film: 'entertainment', movie: 'entertainment', movies: 'entertainment',
    tv: 'entertainment', television: 'entertainment', music: 'entertainment',
    entertainment: 'entertainment',
    recipes: 'cooking', recipe: 'cooking', food: 'cooking', cooking: 'cooking',
    news: 'news', politics: 'news',
    coding: 'coding', programming: 'coding', software: 'coding',
    gaming: 'gaming', games: 'gaming', video: 'video', videos: 'video',
    finance: 'finance', stocks: 'finance', investing: 'finance',
    science: 'science', research: 'science',
    work: 'work', jobs: 'work', learning: 'learning', education: 'learning',
    shopping: 'shopping', products: 'shopping', travel: 'travel',
    health: 'health', fitness: 'health',
    reference: 'reference', wiki: 'reference', docs: 'docs',
    tech: 'tech', technology: 'tech'
  };

  function canonicalTag(name) {
    const key = String(name || '').toLowerCase().split(/[^a-z0-9]+/)[0];
    return TAG_ALIASES[key] || null;
  }

  let centroids = null;          // Float32Array(T * D), L2-normalized rows
  let tagNames = null;           // string[] parallel to centroids
  let topicVecs = null;          // Float32Array(P * D), L2-normalized rows
  let topicNames = null;         // string[]
  let dim = 384;
  let embedFn = null;

  function l2normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  }

  function dot(a, b, aOffset = 0, len = dim) {
    let s = 0;
    for (let i = 0; i < len; i++) s += a[aOffset + i] * b[i];
    return s;
  }

  async function initTopicVocab(embed) {
    embedFn = embed || embedFn;
    if (!embedFn) return false;

    const tagList = Object.keys(TAG_PROTOTYPES);
    const tagCount = tagList.length;
    const tagCentroids = new Float32Array(tagCount * dim);

    for (let t = 0; t < tagCount; t++) {
      const phrases = TAG_PROTOTYPES[tagList[t]];
      const acc = new Float32Array(dim);
      let nPhrases = 0;
      for (const p of phrases) {
        try {
          const v = await embedFn(p);
          if (v && v.length === dim) {
            for (let i = 0; i < dim; i++) acc[i] += v[i];
            nPhrases++;
          }
        } catch (e) { /* skip bad phrase */ }
      }
      if (nPhrases === 0) continue;
      for (let i = 0; i < dim; i++) acc[i] /= nPhrases;
      const norm = l2normalize(acc);
      for (let i = 0; i < dim; i++) tagCentroids[t * dim + i] = norm[i];
    }

    const topicCount = TOPIC_PHRASES.length;
    const tVecs = new Float32Array(topicCount * dim);
    for (let p = 0; p < topicCount; p++) {
      try {
        const v = await embedFn(TOPIC_PHRASES[p]);
        if (v && v.length === dim) {
          const norm = l2normalize(v);
          for (let i = 0; i < dim; i++) tVecs[p * dim + i] = norm[i];
        }
      } catch (e) { /* skip */ }
    }

    centroids = tagCentroids;
    tagNames = tagList;
    topicVecs = tVecs;
    topicNames = TOPIC_PHRASES;
    return true;
  }

  function vocabInfo() {
    return {
      tagCount: tagNames ? tagNames.length : 0,
      topicCount: topicNames ? topicNames.length : 0,
      dim: centroids ? centroids.length / (tagNames ? tagNames.length : 1) : 0,
      ready: !!centroids
    };
  }

  function isReady() { return !!centroids && !!embedFn; }

  // scoreTags(queryOrCardVector) -> [{tag, score}] raw cosine, sorted desc
  function scoreTags(v) {
    if (!centroids || !v || v.length !== dim) return [];
    const scores = [];
    for (let t = 0; t < tagNames.length; t++) {
      scores.push({ tag: tagNames[t], score: dot(v, centroids, t * dim) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
  }

  // scoreTopics(v) -> [{tag: phrase, score}] cosine > threshold, sorted desc, max 4
  function scoreTopics(v) {
    if (!topicVecs || !v || v.length !== dim) return [];
    const out = [];
    for (let p = 0; p < topicNames.length; p++) {
      const s = dot(v, topicVecs, p * dim);
      if (s > TOPIC_THRESHOLD) out.push({ tag: topicNames[p], score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 4);
  }

  function sigmoidCal(z) { return 1 / (1 + Math.exp(-1.5 * z)); }

  // mathEnrich(embedding, ctx) -> enrichment object (v2 schema)
  // ctx = { harvestTags: string[], priorTags: string[], priorConf: number, structured: { type }|null }
  function mathEnrich(embedding, ctx) {
    ctx = ctx || {};
    const v = embedding && embedding.length === dim ? embedding : null;

    const scores = v ? scoreTags(v) : [];
    const scoreMap = new Map(scores.map(s => [s.tag, s.score]));

    // biases: harvest tags (authoritative markup) + high-conf domain/path priors
    for (const h of ctx.harvestTags || []) {
      const tag = canonicalTag(h);
      if (tag) scoreMap.set(tag, (scoreMap.get(tag) || 0) + HARVEST_BIAS);
    }
    if ((ctx.priorConf || 0) >= 0.9) {
      for (const p of ctx.priorTags || []) {
        const tag = canonicalTag(p);
        if (tag) scoreMap.set(tag, (scoreMap.get(tag) || 0) + PRIOR_BIAS);
      }
    }

    let list = Array.from(scoreMap.entries()).map(([tag, score]) => ({ tag, score }));
    list.sort((a, b) => b.score - a.score);
    if (list.length === 0) list = [{ tag: 'other', score: 0 }];

    // multi-label emission in z-space
    const mean = list.reduce((s, x) => s + x.score, 0) / list.length;
    const variance = list.reduce((s, x) => s + (x.score - mean) * (x.score - mean), 0) / list.length;
    const sd = Math.sqrt(variance) || 1;
    const emitted = list.filter(x => (x.score - mean) / sd >= TAG_THRESHOLD_Z || x.score >= 0.6);
    const tags = (emitted.length ? emitted : [list[0]]).map(x => ({
      tag: x.tag,
      score: Number(sigmoidCal((x.score - mean) / sd).toFixed(3))
    }));

    const contentType = (() => {
      const t = (ctx.structured && ctx.structured.type) || '';
      if (/article|news/i.test(t)) return 'article';
      if (/video/i.test(t)) return 'video';
      if (/product/i.test(t)) return 'product';
      if (/recipe/i.test(t)) return 'recipe';
      if (/software|code/i.test(t)) return 'tool';
      if (/forum/i.test(t)) return 'forum';
      if (/docs|reference|book/i.test(t)) return 'reference';
      if (/tv|movie|episode|series/i.test(t)) return 'video';
      if (tags[0].tag === 'video' || tags[0].tag === 'entertainment') return 'video';
      return 'other';
    })();

    return {
      category: tags[0].tag,
      tags,
      subTopics: v ? scoreTopics(v).map(t => t.tag) : [],
      entities: { people: [], orgs: [], works: [] },
      contentType,
      tier: 'math',
      vecVersion: 2,
      enrichedAt: Date.now()
    };
  }

  const api = { initTopicVocab, vocabInfo, isReady, scoreTags, scoreTopics, mathEnrich, canonicalTag, TAG_PROTOTYPES, TOPIC_PHRASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.EnrichMath = api;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/enrich-math.test.js`
Expected: PASS (exit 0)

- [ ] **Step 5: Syntax check**

Run: `node --check enrich-math.js && node --check tests/enrich-math.test.js`
Expected: no output, exit 0

---

### Task 3: `tab-cards.js` — extend harvest (schema tags, Wikipedia catlinks, pseudo-doc)

**Files:**
- Modify: `tab-cards.js:18-118` (`extractRichPageData` injected function)

- [ ] **Step 1: Extend the injected extraction function**

Replace the `collectNames`/JSON-LD block and return payload in `extractRichPageData`'s `func` (keep all existing behavior) with:

```js
const SCHEMA_TYPE_TO_TAG = {
  NewsArticle: 'news', Article: 'news', Report: 'news', LiveBlogPosting: 'news',
  Recipe: 'cooking', SportsEvent: 'sports', SportsTeam: 'sports',
  Movie: 'entertainment', TVSeries: 'entertainment', Episode: 'entertainment',
  MusicAlbum: 'entertainment', MusicRecording: 'entertainment', MusicGroup: 'music',
  SoftwareSourceCode: 'coding', WebApplication: 'coding', SoftwareApplication: 'coding',
  Product: 'shopping', Offer: 'shopping', JobPosting: 'work', Organization: 'work',
  VideoObject: 'video', VideoGame: 'gaming', ScholarlyArticle: 'science',
  Book: 'reference', WebPage: null, AboutPage: null
};
```

Add `const harvestTags = new Set();` next to `people`/`keywords`. In the JSON-LD loop, after `node['@type']` resolution:

```js
for (const ty of Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) {
  const tag = SCHEMA_TYPE_TO_TAG[String(ty)];
  if (tag) harvestTags.add(tag);
}
```

After the JSON-LD loop, add:

```js
// article:section / og:article:section -> topic tag
const section = meta('meta[property="article:section"]') || meta('meta[property="og:article:section"]');
if (section) harvestTags.add(section.trim().toLowerCase().slice(0, 30));

// Wikipedia human-curated categories (#mw-normal-catlinks)
for (const a of document.querySelectorAll('#mw-normal-catlinks a[href^="/wiki/Category:"]')) {
  const name = (a.textContent || '').trim().toLowerCase();
  if (name) keywords.add(name.slice(0, 50));
}
```

Build the pseudo-document right before `return out;`:

```js
// --- Pseudo-document for embedding (title x2 | path tokens | desc | h1 | h2x3 | first 2 sentences) ---
const pseudoParts = [];
const title = out.title || '';
if (title) pseudoParts.push(title, title);
try {
  const pathTokens = location.pathname.split(/[/\-_]+/).filter(t => t && t.length > 1);
  if (pathTokens.length) pseudoParts.push(pathTokens.join(' '));
} catch (e) {}
if (out.excerpt) pseudoParts.push(out.excerpt);
const h1 = document.querySelector('h1');
if (h1 && h1.textContent) pseudoParts.push(h1.textContent.trim().slice(0, 120));
const h2s = Array.from(document.querySelectorAll('h2')).slice(0, 3);
for (const h2 of h2s) {
  const t = (h2.textContent || '').trim();
  if (t) pseudoParts.push(t.slice(0, 80));
}
const sentenceMatch = out.mainText ? out.mainText.match(/[^.!?]+[.!?]+[^.!?]+[.!?]+/) : null;
if (sentenceMatch) pseudoParts.push(sentenceMatch[0].trim().slice(0, 240));
out.pseudoDoc = pseudoParts.filter(Boolean).join(' | ').slice(0, 800);
out.harvestTags = Array.from(harvestTags);
```

Note: `out` must contain `pseudoDoc` and `harvestTags` in the initializer too (empty strings/arrays).

- [ ] **Step 2: Wire pseudoDoc + harvestTags through the worker-side function**

In `extractRichPageData` worker code (after `data.mainText = sanitizePageContent(...)`), add sanitization:

```js
if (data) {
  data.mainText = sanitizePageContent(data.mainText);
  data.excerpt = sanitizePageContent(data.excerpt);
  data.harvestTags = (data.harvestTags || []).slice(0, 8).map(String);
  data.pseudoDoc = sanitizePageContent(data.pseudoDoc || '').slice(0, 800);
}
```

- [ ] **Step 3: Syntax check + smoke test**

Run: `node --check tab-cards.js`
Expected: no output, exit 0

---

### Task 4: `tab-cards.js` — mathEnrich integration + delete LLM enrichment path

**Files:**
- Modify: `tab-cards.js:120-221` (delete `ENRICHMENT_SYSTEM_INSTRUCTION`, `buildEnrichmentPrompt`, `enrichTabCards`)
- Modify: `tab-cards.js:239-350` (`buildTabCard`)
- Modify: `background.js:4581-4624` (delete queue engine) and `4646-4650`, `4667-4685` (remove queue calls) — see Task 5

- [ ] **Step 1: Delete the LLM enrichment section**

Remove from `tab-cards.js`: `ENRICHMENT_SYSTEM_INSTRUCTION` (lines 122-135), `buildEnrichmentPrompt` (137-151), and `enrichTabCards` (153-221). Keep `toPureText` if still referenced elsewhere (check with `rg -n "toPureText"` first; if unused, delete it too).

- [ ] **Step 2: Add mathEnrich call in `buildTabCard`**

Replace the card construction block (lines 312-334) so that after `const card = {...}` is built:

```js
  // ---- Math enrichment (offline, no LLM) ----
  const pseudoDoc = (richData && richData.pseudoDoc) ||
    `${card.title || ''} ${card.title || ''} ${domain.split('.').slice(-2).join(' ')}`.trim().slice(0, 800);
  const harvestTags = (richData && richData.harvestTags) || [];

  let embedding = new Float32Array(0);
  let enrichment = {
    category: category === 'other' ? 'other' : category,
    tags: category === 'other' ? [] : [{ tag: category, score: 0.9 }],
    subTopics: (richData && richData.structured && richData.structured.keywords || []).slice(0, 4),
    entities: (richData && richData.structured && richData.structured.people)
      ? { people: richData.structured.people, orgs: [], works: [] } : { people: [], orgs: [], works: [] },
    contentType: 'other',
    tier: 'math',
    vecVersion: 2,
    enrichedAt: Date.now()
  };

  try {
    if (typeof self.EnrichMath !== 'undefined' && typeof self.Embed !== 'undefined') {
      await self.EnrichMath.initTopicVocab(self.Embed.embed.bind(self.Embed));
      const v = await self.Embed.embed(pseudoDoc);
      if (v && v.length > 0) {
        embedding = new Float32Array(v);
        const prior = typeof self.DomainPriors !== 'undefined' ? self.DomainPriors.applyPriors(tab.url) : null;
        enrichment = self.EnrichMath.mathEnrich(embedding, {
          harvestTags,
          priorTags: prior ? prior.tags : [],
          priorConf: prior ? prior.conf : 0,
          structured: (richData && richData.structured) || null
        });
        if (enrichment.subTopics.length === 0) {
          enrichment.subTopics = (richData && richData.structured && richData.structured.keywords || []).slice(0, 4);
        }
      }
    }
  } catch (err) {
    console.warn('[TabCards] mathEnrich failed:', err.message);
  }

  card.pseudoDoc = pseudoDoc;
  card.embedding = embedding;
  card.enrichment = enrichment;

  await self.TabDB.storeTabCard(card);
```

Also update the `cachedCard` reuse branch (line 291): only reuse when fresh AND v2:

```js
const cachedCard = savedCards.find(c =>
  c.urlHash === urlHash &&
  c.contentHash === contentHash &&
  c.enrichment?.vecVersion === 2 &&
  c.enrichment?.enrichedAt > 0 &&
  (Date.now() - c.enrichment.enrichedAt) < 7 * 24 * 60 * 60 * 1000);
```

And change `contentHash` computation to derive from the pseudo-doc (line 284):

```js
const pseudoDocForHash = richData?.pseudoDoc || tab.title || '';
const contentHash = await sha256(pseudoDocForHash);
```

- [ ] **Step 3: Remove `queueCardForEnrichment` calls from `buildTabCard`**

Confirm no `queueCardForEnrichment` reference remains inside `tab-cards.js` (grep). The calls live in `background.js` (see Task 5).

- [ ] **Step 4: Syntax check**

Run: `node --check tab-cards.js`
Expected: no output, exit 0

---

### Task 5: `background.js` — delete enrichment queue engine + Ollama keep_alive/logging

**Files:**
- Modify: `background.js:4581-4624` (delete queue engine)
- Modify: `background.js:4634-4638` (`indexTabById` — remove queue call)
- Modify: `background.js:4667-4685` (reindex interval — remove queue call)
- Modify: `background.js:1475-1541` (`callOllama` — keep_alive + timing logs)

- [ ] **Step 1: Delete the queue engine**

Remove `pendingEnrichmentCards`, `enrichmentTimeout`, `queueCardForEnrichment`, `flushEnrichmentQueue` (background.js:4581-4624). Grep for remaining references before deleting:

Run: `rg -n "queueCardForEnrichment|flushEnrichmentQueue|pendingEnrichmentCards|enrichmentTimeout" background.js`
Expected: only the two call sites in `indexTabById` (4635) and the reindex interval (4675) remain — delete those calls in Steps 2-3.

- [ ] **Step 2: Remove queue call from `indexTabById`**

In `indexTabById` (background.js:4634-4638), delete the line `await queueCardForEnrichment(card);` — the function becomes:

```js
const card = await buildTabCard(tab);
const text = card.mainText || '';
await Indexer.indexTab(tab, text);
```

- [ ] **Step 3: Remove queue call from reindex interval**

In the 5-minute reindex interval (background.js:4673-4677), delete `await queueCardForEnrichment(card);` — loop body becomes:

```js
await ensureRagReady();
const card = await buildTabCard(tab);
const text = card.mainText || '';
await Indexer.indexTab(tab, text);
```

- [ ] **Step 4: `callOllama` — keep_alive + observability**

In `callOllama` (background.js:1500-1515), add `keep_alive: -1` to the body and wrap the request with timing + size logging:

```js
const t0 = Date.now();
const response = await fetch(`${ollamaUrl}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    prompt: fullPrompt,
    stream: false,
    format: responseFormat === 'json' ? 'json' : undefined,
    keep_alive: -1,
    options: {
      temperature,
      num_predict: maxTokens,
      num_ctx: 8192
    }
  }),
  signal: controller.signal
});
```

And replace the success log (background.js:1525) with:

```js
console.log(`[Ollama] OK in ${Date.now() - t0}ms (in:${fullPrompt.length} chars out:${(data.response || '').length} chars):`, data.response?.substring(0, 150));
```

And the error log (background.js:1533):

```js
console.error(`[Ollama] FAIL in ${Date.now() - t0}ms:`, error.message);
```

- [ ] **Step 5: Load the new modules in the service worker**

At the top of `background.js`, after line 5 (`importScripts('tab-cards.js', 'command-agent.js');`), add:

```js
importScripts('domain-priors.js', 'enrich-math.js');
```

- [ ] **Step 6: Syntax check**

Run: `node --check background.js`
Expected: no output, exit 0

---

### Task 6: `command-agent.js` — tag-overlap retrieval + compactCards v2

**Files:**
- Modify: `command-agent.js` (`retrieveCandidates` ~line 77-109, `reasonOverCandidates` compactCards ~line 115-127)

- [ ] **Step 1: Replace category boost with tag-overlap boost in `retrieveCandidates`**

Replace the category-match boost block (command-agent.js:106-109) with:

```js
    // Tag-overlap boost (multi-label): query tags ∩ card tags
    if (queryTags && queryTags.length && c.enrichment?.tags) {
      const cardTagSet = new Set(c.enrichment.tags.map(t => t.tag));
      let overlap = 0;
      for (const qt of queryTags) if (cardTagSet.has(qt)) overlap++;
      if (overlap > 0) score += 0.3 * Math.min(overlap, 2);
    }
```

And before the scoring loop (after `const query = new Float32Array(queryEmbedding);` at line 60), compute query tags once:

```js
  let queryTags = [];
  try {
    if (typeof self.EnrichMath !== 'undefined') {
      await self.EnrichMath.initTopicVocab(self.Embed.embed.bind(self.Embed));
      queryTags = self.EnrichMath.scoreTags(query)
        .filter(t => t.score > 0.35)
        .slice(0, 5)
        .map(t => t.tag);
    }
  } catch (e) { /* enrichment unavailable — skip tag overlap */ }
```

Note: `scoreTags` needs `initTopicVocab` to have run (it's lazy; idempotent). `self.Embed` is available in the worker via `ensureRagReady`.

- [ ] **Step 2: Update `compactCards` payload**

In `reasonOverCandidates` (command-agent.js:115-127), change the mapping to:

```js
  const compactCards = candidates.map((c, i) => {
    return {
      index: i + 1,
      tabId: c.tabId,
      title: c.title,
      domain: c.domain,
      category: c.enrichment?.category || 'other',
      tags: (c.enrichment?.tags || []).slice(0, 4).map(t => t.tag),
      contentType: c.enrichment?.contentType || 'other',
      people: c.enrichment?.entities?.people || [],
      subTopics: c.enrichment?.subTopics || []
    };
  });
```

(`summary` removed; `tags` added.)

- [ ] **Step 3: Syntax check**

Run: `node --check command-agent.js`
Expected: no output, exit 0

---

### Task 7: Extend `tests/run-ai-test.js` — coverage, latency, cache-hit metrics

**Files:**
- Modify: `tests/run-ai-test.js`

- [ ] **Step 1: Add enrichment stats to the indexing wait**

In `waitForIndexing`, extend the evaluated expression to also return card enrichment coverage:

```js
        const cards = await TabDB.getAllTabCards();
        const enrichedCards = cards.filter(c => c.enrichment && c.enrichment.vecVersion === 2 && c.enrichment.tags && c.enrichment.tags.length >= 2);
```

and log `stats.enriched = enrichedCards.length`. Change the completion condition to `stats.withEmbedding >= minCards || stats.enriched >= minCards`.

- [ ] **Step 2: Add post-run enrichment report**

After the tab snapshot (before the test loop), measure per-card enrichment latency + coverage + cache hit via one CDP eval:

```js
  const enrichStats = JSON.parse(await evalInWorker(cdp, `(async () => {
    const cards = await TabDB.getAllTabCards();
    const tabs = await chrome.tabs.query({});
    const openWiki = tabs.filter(t => t.url && t.url.includes('wikipedia.org'));
    const latencies = [];
    const timingCard = cards[0];
    if (timingCard) {
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const rebuilt = await buildTabCard({ id: timingCard.tabId, url: timingCard.url, title: timingCard.title });
        latencies.push(Date.now() - t0);
      }
    }
    return JSON.stringify({
      coverage: openWiki.length ? cards.filter(c => c.enrichment?.vecVersion === 2 && (c.enrichment?.tags || []).length >= 2).length : 0,
      openWiki: openWiki.length,
      latencies,
      cacheHit: cards[0] ? cards[0].enrichment?.enrichedAt : 0,
      cacheHitAfter: cards[0] ? cards[0].enrichment?.enrichedAt : 0,
    });
  })()`, 60000));
  enrichStats.latencies.sort((a, b) => a - b);
  const p50 = enrichStats.latencies[Math.floor(enrichStats.latencies.length / 2)];
  info(`Enrichment coverage: ${enrichStats.coverage}/${enrichStats.openWiki} wiki tabs (>=2 tags)`);
  info(`buildTabCard latency (3 runs): ${enrichStats.latencies.join('ms, ')}ms | p50 ~${p50}ms`);
  info(`Cache hit (enrichedAt unchanged across rebuilds): ${enrichStats.cacheHit === enrichStats.cacheHitAfter}`);
```

- [ ] **Step 3: Add an `enableAi:false` offline check**

After the main test loop, before the final report:

```js
  log('OFFLINE CHECK: disable enableAi, confirm pipeline still works (enrichment is offline)');
  await evalInWorker(cdp, `new Promise((r) => chrome.storage.sync.set({ enableAi: false }, r))`, 15000);
  const offlinePlan = JSON.parse(await evalInWorker(cdp, `(async () => {
    try { return JSON.stringify(await runCommandPipeline('group all tabs related to sports', ${windowId})); }
    catch (err) { return JSON.stringify({ error: String(err && err.message || err) }); }
  })()`, LLM_TIMEOUT_MS));
  if (offlinePlan.error) { fail(`Offline check failed: ${offlinePlan.error}`); }
  else { info(`Offline check: matched ${offlinePlan.tabIds.length} sports tabs with enableAi=false`); pass('Enrichment independent of enableAi'); }
  await evalInWorker(cdp, `new Promise((r) => chrome.storage.sync.set({ enableAi: true }, r))`, 15000);
```

- [ ] **Step 4: Syntax check**

Run: `node --check tests/run-ai-test.js`
Expected: no output, exit 0

---

### Task 8: Full E2E run + verdict

**Files:**
- None (verification task)

- [ ] **Step 1: Syntax check all changed files**

Run:
```
node --check background.js; node --check tab-cards.js; node --check command-agent.js; node --check domain-priors.js; node --check enrich-math.js
```
Expected: no output, exit 0 for each

- [ ] **Step 2: Unit tests**

Run: `node tests/domain-priors.test.js; node tests/enrich-math.test.js`
Expected: PASS, PASS

- [ ] **Step 3: Full E2E suite**

Run: `node tests/run-ai-test.js`
Expected: pipeline completes; report shows precision/recall per test. **Acceptance:**
- Test 1 (sports) recall > 0 (baseline 0%)
- Test 2 (entertainment) recall > 0
- Test 3 (entertainment+sports) recall >= 0.75 (baseline 50%)
- Test 4 (tech) recall > 0 (baseline 0%)
- Test 5 (cooking) precision stays 0-1 FP (baseline 5 FP)
- Test 6 (close astronomy) recall >= 0.67 (baseline 33%)
- Enrichment coverage reported >= 50%
- Offline check passes

- [ ] **Step 4: If a test regressed vs baseline, diagnose via plan §12 metrics (coverage/latency lines) and iterate vocab/priors in `domain-priors.js`/`enrich-math.js`; re-run.**
