// tests/enrich-math.test.js
// Pure math tests — Embed is injected as a stub. Run: node tests/enrich-math.test.js
const path = require('path');
const math = require(path.join(__dirname, '..', 'enrich-math.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; }
  else console.log('  ok:', msg);
}

// Stub embed: bag-of-words hashing (word overlap => higher cosine). Deterministic semantics.
function stubEmbed(text) {
  const v = new Float32Array(384);
  for (const w of text.toLowerCase().split(/\W+/)) {
    if (!w) continue;
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % 384] += 1;
  }
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

  // prior bias: priorTags with conf>=0.9 add +0.15. Empty text -> all raw cosines 0,
  // so only the biased tag can emit.
  const e2 = math.mathEnrich(stubEmbed(''), { harvestTags: [], priorTags: ['gaming'], priorConf: 0.95, structured: null });
  assert(e2.tags.map(t => t.tag).includes('gaming'), `prior tag gaming appears when biased (got ${e2.tags.map(t => t.tag).join(',')})`);
  assert(e2.category === 'gaming', 'category = gaming (biased top tag)');

  // contentType from structured type, else other
  const e3 = math.mathEnrich(stubEmbed('something'), { harvestTags: [], priorTags: [], structured: { type: 'NewsArticle' } });
  assert(e3.contentType === 'article', 'contentType article from NewsArticle');

  // No harvest, no priors, weak text -> category still top tag, tier math
  const e4 = math.mathEnrich(stubEmbed('x'), { harvestTags: [], priorTags: [], structured: null });
  assert(e4.tier === 'math', 'tier = math');
  assert(e4.subTopics.length <= 4, 'subTopics capped at 4');

  // canonicalTag aliasing
  assert(math.canonicalTag('Cricket') === 'sports', 'canonicalTag cricket -> sports');
  assert(math.canonicalTag('Film') === 'entertainment', 'canonicalTag film -> entertainment');
  assert(math.canonicalTag('zzz-unknown') === null, 'canonicalTag unknown -> null');

  // matchTag word-boundary substring matching (multiword keys, longest-first)
  assert(math.matchTag('test cricket') === 'sports', 'matchTag "test cricket" -> sports');
  assert(math.matchTag('association football') === 'sports', 'matchTag "association football" -> sports');
  assert(math.matchTag('television series') === 'entertainment', 'matchTag "television series" -> entertainment');
  assert(math.matchTag('artificial intelligence') === 'tech', 'matchTag "artificial intelligence" -> tech');
  assert(math.matchTag('random unrelated phrase') === null, 'matchTag no alias -> null');
  assert(math.matchTag('") === null || math.matchTag("') === null, 'matchTag empty -> null');

  console.log(failures === 0 ? 'PASS' : `FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
