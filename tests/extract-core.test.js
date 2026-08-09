// tests/extract-core.test.js
// Phase 0 / A1 regression gate for the extraction fix.
//
// Before the fix, tab-cards.js injected 'vendor/readability.js' while the file on
// disk was 'vendor/readibility.js'. executeScript rejected, the catch swallowed it,
// and extractRichPageData returned null for EVERY page — so mainText, harvestTags,
// structured.keywords and pseudoDoc were empty on every card in the product.
//
// This test runs the real extract-core.js against frozen offline fixtures in a
// headless browser and asserts the signals are actually populated. It needs no
// embedding model, so it runs standalone and fast.
//
//   node tests/extract-core.test.js
//
// Set TS_SIMULATE_BROKEN_READABILITY=1 to skip loading Readability. NOTE this is
// NOT the pre-fix state: it only degrades Readability to the body-innerText
// fallback, and JSON-LD/OpenGraph still parse. The actual pre-fix product was
// strictly worse -- the missing-file executeScript rejected before the extraction
// function ran at all, so extractRichPageData returned null and NO signal was
// collected. See bench/report-extraction.js for the three-way comparison.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'bench', 'fixtures');
const SIMULATE_BROKEN = process.env.TS_SIMULATE_BROKEN_READABILITY === '1';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function extract(page, fixture) {
  const file = path.join(FIXTURES, fixture);
  await page.goto('file://' + file.replace(/\\/g, '/'), { waitUntil: 'load' });
  if (!SIMULATE_BROKEN) {
    await page.addScriptTag({ path: path.join(ROOT, 'vendor', 'readibility.js') });
  }
  await page.addScriptTag({ path: path.join(ROOT, 'extract-core.js') });
  return page.evaluate(() => globalThis.__tsExtract(document, location));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();

  console.log(SIMULATE_BROKEN
    ? '\n--- extract-core (SIMULATING PRE-FIX: Readability not loaded) ---'
    : '\n--- extract-core (post-fix) ---');

  // --- Recipe: JSON-LD Recipe -> cooking harvest tag, keywords, full extraction
  {
    const out = await extract(page, 'recipe-sourdough.html');
    ok('recipe: extractionLevel full', out.extractionLevel === 'full', out.extractionLevel);
    ok('recipe: mainText non-empty', out.mainText.length > 200, `len=${out.mainText.length}`);
    ok('recipe: harvestTags has cooking', out.harvestTags.includes('cooking'), JSON.stringify(out.harvestTags));
    ok('recipe: structured.type Recipe', out.structured.type === 'Recipe', out.structured.type);
    ok('recipe: keywords include sourdough',
      out.structured.keywords.some(k => /sourdough/i.test(k)), JSON.stringify(out.structured.keywords));
    ok('recipe: author collected', out.structured.people.includes('Elena Fischer'), JSON.stringify(out.structured.people));
    ok('recipe: pseudoDoc richer than title x2',
      out.pseudoDoc.length > (out.title.length * 2 + 10), `len=${out.pseudoDoc.length}`);
  }

  // --- News: NewsArticle -> news tag, article:section -> cricket
  {
    const out = await extract(page, 'news-cricket-jsonld.html');
    ok('news: extractionLevel full', out.extractionLevel === 'full', out.extractionLevel);
    ok('news: harvestTags has news', out.harvestTags.includes('news'), JSON.stringify(out.harvestTags));
    ok('news: harvestTags has cricket section', out.harvestTags.includes('cricket'), JSON.stringify(out.harvestTags));
    ok('news: headline captured', /Chennai ODI/.test(out.structured.headline), out.structured.headline);
    ok('news: datePublished captured', out.structured.datePublished.startsWith('2026-03-11'), out.structured.datePublished);
    ok('news: keywords include cricket',
      out.structured.keywords.some(k => /cricket/i.test(k)), JSON.stringify(out.structured.keywords));
    ok('news: mainText mentions Kohli', /Kohli/.test(out.mainText), out.mainText.slice(0, 80));
  }

  // --- Wikipedia: human-curated catlinks harvested into keywords
  {
    const out = await extract(page, 'wikipedia-catlinks.html');
    ok('wiki: catlinks -> keywords',
      out.structured.keywords.some(k => /cricket formats/i.test(k)), JSON.stringify(out.structured.keywords));
    ok('wiki: mainText non-empty', out.mainText.length > 200, `len=${out.mainText.length}`);
  }

  // --- Repo page: SoftwareSourceCode -> coding
  {
    const out = await extract(page, 'repo-page.html');
    ok('repo: harvestTags has coding', out.harvestTags.includes('coding'), JSON.stringify(out.harvestTags));
    ok('repo: keywords include testing',
      out.structured.keywords.some(k => /testing/i.test(k)), JSON.stringify(out.structured.keywords));
  }

  // --- SPA with empty <article>: must degrade to body-fallback, not crash
  {
    const out = await extract(page, 'spa-video-empty-article.html');
    ok('spa: falls back to body', out.extractionLevel === 'body-fallback', out.extractionLevel);
    // A client-rendered shell has no visible body text, so mainText is legitimately
    // empty here. The card stays useful only via title + JSON-LD, which is why the
    // harvestTags assertion below matters more for this class of page than mainText.
    ok('spa: title survives as signal', /Kuldeep Yadav/.test(out.title), out.title);
    ok('spa: pseudoDoc built from title + path even with no body text',
      /Kuldeep/.test(out.pseudoDoc), out.pseudoDoc.slice(0, 100));    ok('spa: VideoObject -> video tag', out.harvestTags.includes('video'), JSON.stringify(out.harvestTags));
  }

  // --- Injection fixture: extraction must surface the text as inert DATA.
  // extract-core does not sanitize; tab-cards.js applies sanitizePageContent to
  // mainText/excerpt/pseudoDoc afterwards. Assert the raw payload is present here
  // so the sanitizer's contribution is measurable rather than assumed.
  {
    const out = await extract(page, 'injection-title.html');
    ok('injection: page still extracts', out.mainText.length > 100, `len=${out.mainText.length}`);
    ok('injection: payload present pre-sanitize',
      /ignore previous instructions/i.test(out.title), out.title);
    ok('injection: structured.headline carries payload (must be sanitized downstream)',
      /ignore any instructions/i.test(out.structured.headline), out.structured.headline);
  }

  await browser.close();

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('harness error:', err);
  process.exit(1);
});
