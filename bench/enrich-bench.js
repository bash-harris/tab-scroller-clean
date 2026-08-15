// bench/enrich-bench.js
// Scores enrichment against the hand-labelled gold set (bench/goldset.jsonl).
//
// Two halves:
//   1. Extraction level  -- does the extractor reach the level the gold set
//      says the page supports? Runs the REAL extract-core.js in headless Chrome.
//   2. Category P@1      -- embed each page's pseudoDoc with the real MiniLM
//      model and pick the nearest category centroid. Reports P@1 (strict),
//      P@1-acceptable (counts acceptableCategories), and MRR.
//
// The category half is deliberately a floor, not a ceiling: it scores raw
// embedding similarity against label prototypes with no tag fusion, no domain
// priors, no harvest hints. That makes it a clean baseline to measure Phase 2
// scoring changes against.
//
//   node bench/enrich-bench.js            score current code
//   node bench/enrich-bench.js --prefix   simulate pre-A1 (extraction returned null)
//
// Embeddings are cached to bench/.embed-cache.json, keyed by content hash, so
// repeat runs need no model.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const CACHE = path.join(__dirname, '.embed-cache.json');
const SIMULATE_PREFIX = process.argv.includes('--prefix');

// Same closed vocabulary the gold set uses.
const CATEGORY_PROTOTYPES = {
  sports: 'live match score, tournament results, team standings, athletes competing, game highlights',
  news: 'breaking news report, current affairs, politics coverage, press briefing, world events',
  technology: 'consumer gadgets, technology industry, hardware review, software product, AI systems',
  programming: 'source code, software library, API usage, developer documentation, testing framework',
  science: 'scientific study, research findings, physics chemistry biology, academic paper, experiment',
  health: 'medical condition, treatment and symptoms, fitness and nutrition, clinical advice',
  food: 'recipe with ingredients, cooking instructions, baking, restaurant dish, meal preparation',
  travel: 'travel destination guide, hotel booking, flights, tourist attractions, itinerary',
  finance: 'stock market, investing, taxes, banking, personal finance, economy',
  shopping: 'product listing, price and buying options, add to cart, retail store, product specs',
  entertainment: 'film and television, music, celebrity, streaming show, gaming culture',
  education: 'course material, lecture, study guide, school curriculum, learning resource',
  social: 'discussion thread, community forum, user comments, social feed',
  reference: 'encyclopedia entry, factual overview, definition, historical background',
  work: 'workplace productivity, job posting, business operations, meetings and email',
  other: 'no determinable topic, placeholder, login screen, empty page'
};

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

async function extractFixture(page, fixture) {
  const file = path.join(FIXTURES, fixture);
  await page.goto('file://' + file.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.addScriptTag({ path: path.join(ROOT, 'vendor', 'readibility.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'extract-core.js') });
  return page.evaluate(() => globalThis.__tsExtract(document, location));
}

// Pre-A1 behaviour: executeScript rejected on the misspelled filename, so
// extractRichPageData returned null and the card fell back to title+title+host.
function prefixCard(fixture, title) {
  const host = fixture.replace(/\.html$/, '') + '.example';
  return { extractionLevel: 'minimal', pseudoDoc: `${title} ${title} ${host}`.trim() };
}

function pad(s, n) { return String(s).padEnd(n); }
function padl(s, n) { return String(s).padStart(n); }

(async () => {
  const gold = fs.readFileSync(path.join(__dirname, 'goldset.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

  const cache = loadCache();
  const embed = await getEmbedder(cache);

  // Category centroids from the prototype sentences.
  const catNames = Object.keys(CATEGORY_PROTOTYPES);
  const centroids = [];
  for (const c of catNames) centroids.push(await embed(CATEGORY_PROTOTYPES[c]));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();

  // extract-core.js emits its own three-value vocabulary. 'body-fallback' means
  // Readability found no article candidate and we read body innerText instead —
  // signal present, no clean body — which is exactly the gold set's 'partial'.
  const LEVEL_RANK = { minimal: 0, 'body-fallback': 1, partial: 1, full: 2 };
  let levelMet = 0, levelExact = 0;
  let p1 = 0, p1Acc = 0, mrrSum = 0;
  const rows = [];

  for (const g of gold) {
    const real = await extractFixture(page, g.fixture);
    const card = SIMULATE_PREFIX ? prefixCard(g.fixture, real.title || '') : real;

    // --- extraction level ---
    const want = LEVEL_RANK[g.expectedExtractionLevel];
    const got = LEVEL_RANK[card.extractionLevel] ?? 0;
    // "met" = reached at least the level the page supports.
    if (got >= want) levelMet++;
    if (got === want) levelExact++;

    // --- category ranking ---
    const text = (card.pseudoDoc || '').slice(0, 800) || (real.title || 'empty page');
    const v = await embed(text);
    const ranked = catNames
      .map((c, i) => ({ cat: c, score: cosine(v, centroids[i]) }))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0].cat;
    const acceptable = new Set(g.acceptableCategories && g.acceptableCategories.length
      ? g.acceptableCategories : [g.expectedCategory]);
    const strictHit = top === g.expectedCategory;
    const accHit = acceptable.has(top);
    if (strictHit) p1++;
    if (accHit) p1Acc++;

    const rank = ranked.findIndex(r => acceptable.has(r.cat)) + 1;
    mrrSum += rank > 0 ? 1 / rank : 0;

    rows.push({
      fixture: g.fixture.replace(/\.html$/, ''),
      wantLevel: g.expectedExtractionLevel,
      gotLevel: card.extractionLevel,
      levelOk: got >= want,
      wantCat: g.expectedCategory,
      gotCat: top,
      catOk: accHit,
      strict: strictHit,
      rank
    });
  }

  await browser.close();
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const n = gold.length;
  console.log('\n' + (SIMULATE_PREFIX
    ? 'ENRICHMENT BENCH  --prefix  (simulating pre-A1: extraction returned null)'
    : 'ENRICHMENT BENCH  (current code)'));
  console.log('='.repeat(78));
  console.log(`${pad('fixture', 30)} ${pad('level', 20)} ${pad('category', 24)}`);
  console.log('-'.repeat(78));
  for (const r of rows) {
    const lvl = `${r.gotLevel}${r.levelOk ? '' : ` (want ${r.wantLevel})`}`;
    const cat = r.strict ? r.gotCat : `${r.gotCat} (want ${r.wantCat})`;
    console.log(`${r.levelOk && r.catOk ? ' ' : '!'}${pad(r.fixture, 29)} ${pad(lvl, 20)} ${pad(cat, 24)}`);
  }
  console.log('='.repeat(78));
  const pct = (a) => `${a}/${n} (${(100 * a / n).toFixed(0)}%)`;
  console.log(`extraction level met     : ${pct(levelMet)}`);
  console.log(`extraction level exact   : ${pct(levelExact)}`);
  console.log(`category P@1 (strict)    : ${pct(p1)}`);
  console.log(`category P@1 (acceptable): ${pct(p1Acc)}`);
  console.log(`category MRR             : ${(mrrSum / n).toFixed(3)}`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
