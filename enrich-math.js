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
  const HARVEST_BIAS = 0.2;     // added per harvested/authoritative hint (each hint = one vote)
  const PRIOR_BIAS = 0.15;       // added for prior tags with conf >= 0.9

  // Harvest/prior tags are free-form strings ("cricket", "recipes") -> canonical tag names
  const TAG_ALIASES = {
    'artificial intelligence': 'tech', 'machine learning': 'tech', technology: 'tech', tech: 'tech',
    cricket: 'sports', football: 'sports', soccer: 'sports', basketball: 'sports',
    tennis: 'sports', sports: 'sports', olympics: 'sports', baseball: 'sports', hockey: 'sports',
    golf: 'sports', 'formula 1': 'sports',
    film: 'entertainment', movie: 'entertainment', movies: 'entertainment',
    tv: 'entertainment', television: 'entertainment', 'tv show': 'entertainment',
    'tv series': 'entertainment', music: 'entertainment', entertainment: 'entertainment',
    podcast: 'entertainment', radio: 'entertainment', celebrity: 'entertainment',
    recipes: 'cooking', recipe: 'cooking', food: 'cooking', cooking: 'cooking', baking: 'cooking',
    news: 'news', politics: 'news', journalism: 'news',
    coding: 'coding', programming: 'coding', software: 'coding', javascript: 'coding',
    python: 'coding', 'computer programming': 'coding',
    gaming: 'gaming', games: 'gaming', esports: 'gaming', video: 'video', videos: 'video',
    finance: 'finance', stocks: 'finance', investing: 'finance', economy: 'finance',
    science: 'science', research: 'science', astronomy: 'science', physics: 'science',
    biology: 'science', chemistry: 'science', universe: 'science', galaxy: 'science',
    'earth science': 'science', 'space exploration': 'science', geography: 'reference',
    work: 'work', jobs: 'work', career: 'work', learning: 'learning', education: 'learning',
    shopping: 'shopping', products: 'shopping', travel: 'travel', tourism: 'travel',
    health: 'health', fitness: 'health', medicine: 'health',
    reference: 'reference', wiki: 'reference', encyclopedia: 'reference', docs: 'docs',
    history: 'reference', literature: 'reference', social: 'social', reddit: 'social'
  };

  const ALIAS_KEYS = Object.keys(TAG_ALIASES).sort((a, b) => b.length - a.length);

  function canonicalTag(name) {
    const key = String(name || '').toLowerCase().split(/[^a-z0-9]+/)[0];
    return TAG_ALIASES[key] || null;
  }

  // matchTag(text): word-boundary substring match over alias keys (longest first).
  // e.g. "test cricket" -> 'sports', "association football" -> 'sports'
  function matchTag(text) {
    const t = String(text || '').toLowerCase();
    for (const key of ALIAS_KEYS) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(t)) return TAG_ALIASES[key];
    }
    return null;
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
    for (let i = 0; i < len; i++) s += a[i] * b[aOffset + i];
    return s;
  }

  async function initTopicVocab(embed) {
    if (embed) embedFn = embed || embedFn;
    if (!embedFn) return false;
    if (centroids && tagNames && topicVecs) return true; // idempotent — vocab already built

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
  // ctx = { harvestTags: string[], priorTags: string[], priorConf: number,
  //         structured: { type }|null, keywordHints: string[] }
  function mathEnrich(embedding, ctx) {
    ctx = ctx || {};
    const v = embedding && embedding.length === dim ? embedding : null;

    const scores = v ? scoreTags(v) : [];
    const topicMatches = v ? scoreTopics(v) : [];
    const scoreMap = new Map(scores.map(s => [s.tag, s.score]));

    // biases: harvest tags (authoritative markup) + keyword hints (catlinks/keywords)
    // + topic matches (subTopics) + high-conf priors. Each hint = one vote (stackable).
    const hintSources = [
      ...(ctx.harvestTags || []),
      ...(ctx.keywordHints || []),
      ...topicMatches.map(t => t.tag)
    ];
    for (const h of hintSources) {
      const tag = matchTag(h) || canonicalTag(h);
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

    // multi-label emission in z-space over the biased score vector
    const mean = list.reduce((s, x) => s + x.score, 0) / list.length;
    const variance = list.reduce((s, x) => s + (x.score - mean) * (x.score - mean), 0) / list.length;
    const sd = Math.sqrt(variance) || 1;
    const emitted = sd === 0
      ? [list[0]]
      : list.filter(x => (x.score - mean) / sd >= TAG_THRESHOLD_Z).slice(0, 3);
    const tags = (emitted.length ? emitted : [list[0]]).map(x => {
      const z = sd === 0 ? 0 : (x.score - mean) / sd;
      return { tag: x.tag, score: Number(sigmoidCal(z).toFixed(3)) };
    });

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
      subTopics: topicMatches.map(t => t.tag),
      entities: { people: [], orgs: [], works: [] },
      contentType,
      tier: 'math',
      vecVersion: 3,
      enrichedAt: Date.now()
    };
  }

  const api = { initTopicVocab, vocabInfo, isReady, scoreTags, scoreTopics, mathEnrich, canonicalTag, matchTag, TAG_PROTOTYPES, TOPIC_PHRASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.EnrichMath = api;
})();
