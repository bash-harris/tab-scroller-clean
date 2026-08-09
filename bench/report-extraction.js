// bench/report-extraction.js
// Measures what the extraction fix (Phase 0 / A1) actually recovers, per fixture.
//
// Three modes, so the claim is falsifiable rather than asserted:
//
//   prefix    - faithful pre-fix behaviour. tab-cards.js injected
//               'vendor/readability.js' but the file on disk was
//               'vendor/readibility.js', so chrome.scripting.executeScript
//               REJECTED on step 1 and the extraction function never ran.
//               extractRichPageData returned null -> zero signals, every page.
//   no-readab - extraction runs but Readability is unavailable (body-innerText
//               fallback only). Shown to isolate Readability's contribution from
//               the JSON-LD / OpenGraph contribution.
//   postfix   - current code.
//
//   node bench/report-extraction.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

// pseudoDoc pre-fix = title + title + domain (tab-cards.js buildPseudoDoc with a
// null extraction), which is what every card in the product actually contained.
function prefixSignals(title, host) {
  return {
    extraction: 'null (never ran)',
    mainTextChars: 0,
    keywords: 0,
    harvestTags: 0,
    people: 0,
    structType: '',
    boilerplate: 0,
    pseudoDocChars: (title + ' ' + title + ' ' + host).length
  };
}

// Boilerplate strings that appear in nav/footer chrome in the fixtures but never
// in the article body. Readability is supposed to strip these; the body-innerText
// fallback cannot. This is the precision measure -- raw character count actually
// goes DOWN when Readability works, so volume alone would be misleading.
const BOILERPLATE = [
  /Subscribe to our newsletter/i,
  /^\s*Home\s+Cricket\s+Football/im,
  /Copyright 2026/i,
  /Loading player/i,
  /views\s*StreamTube/i
];

function boilerplateHits(text) {
  return BOILERPLATE.filter(re => re.test(text)).length;
}

function signals(out) {
  return {
    extraction: out.extractionLevel,
    mainTextChars: out.mainText.length,
    keywords: out.structured.keywords.length,
    harvestTags: out.harvestTags.length,
    people: out.structured.people.length,
    structType: out.structured.type || '-',
    boilerplate: boilerplateHits(out.mainText),
    pseudoDocChars: out.pseudoDoc.length
  };
}

async function run(page, fixture, withReadability) {
  const file = path.join(FIXTURES, fixture);
  await page.goto('file://' + file.replace(/\\/g, '/'), { waitUntil: 'load' });
  if (withReadability) {
    await page.addScriptTag({ path: path.join(ROOT, 'vendor', 'readibility.js') });
  }
  await page.addScriptTag({ path: path.join(ROOT, 'extract-core.js') });
  return page.evaluate(() => globalThis.__tsExtract(document, location));
}

function pad(s, n) { return String(s).padEnd(n); }
function padl(s, n) { return String(s).padStart(n); }

(async () => {
  const fixtures = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.html')).sort();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();

  const totals = {
    prefix: { mainText: 0, keywords: 0, harvestTags: 0, pseudoDoc: 0, usable: 0, boilerplate: 0 },
    noReadab: { mainText: 0, keywords: 0, harvestTags: 0, pseudoDoc: 0, usable: 0, boilerplate: 0 },
    postfix: { mainText: 0, keywords: 0, harvestTags: 0, pseudoDoc: 0, usable: 0, boilerplate: 0 }
  };

  console.log('\nEXTRACTION SIGNAL REPORT  (Phase 0 / A1)');
  console.log('mainText chars | keywords | harvestTags | pseudoDoc chars\n');

  for (const fx of fixtures) {
    const post = await run(page, fx, true);
    const noR = await run(page, fx, false);
    const pre = prefixSignals(post.title, new URL(post.url || 'file:///x').hostname || 'localfile');

    const sPost = signals(post);
    const sNoR = signals(noR);

    console.log(pad(fx.replace(/\.html$/, ''), 30));
    for (const [label, s, key] of [
      ['  prefix   ', pre, 'prefix'],
      ['  no-readab', sNoR, 'noReadab'],
      ['  postfix  ', sPost, 'postfix']
    ]) {
      console.log(
        `${label} ${padl(s.mainTextChars, 6)} | ${padl(s.keywords, 8)} | ` +
        `${padl(s.harvestTags, 11)} | ${padl(s.pseudoDocChars, 6)} | bp:${s.boilerplate}  ${s.extraction}`
      );
      totals[key].mainText += s.mainTextChars;
      totals[key].keywords += s.keywords;
      totals[key].harvestTags += s.harvestTags;
      totals[key].pseudoDoc += s.pseudoDocChars;
      totals[key].boilerplate += s.boilerplate;
      // "usable" = has more than title-level signal to embed or match on.
      if (s.mainTextChars > 200 || s.keywords > 0 || s.harvestTags > 0) totals[key].usable++;
    }
    console.log('');
  }

  await browser.close();

  const n = fixtures.length;
  console.log('='.repeat(72));
  console.log(`TOTALS over ${n} fixtures`);
  console.log(`${pad('', 12)} ${padl('mainText', 8)} | ${padl('keywords', 8)} | ${padl('hTags', 6)} | ${padl('pseudoDoc', 9)} | ${padl('boilerpl', 8)} | usable`);
  for (const [label, key] of [['prefix', 'prefix'], ['no-readab', 'noReadab'], ['postfix', 'postfix']]) {
    const t = totals[key];
    console.log(`${pad(label, 12)} ${padl(t.mainText, 8)} | ${padl(t.keywords, 8)} | ${padl(t.harvestTags, 6)} | ${padl(t.pseudoDoc, 9)} | ${padl(t.boilerplate, 8)} | ${t.usable}/${n}`);
  }

  const grow = (a, b) => (a === 0 ? 'inf' : (b / a).toFixed(1) + 'x');
  console.log('');
  console.log(`pseudoDoc growth prefix -> postfix : ${grow(totals.prefix.pseudoDoc, totals.postfix.pseudoDoc)}`);
  console.log(`mainText  growth prefix -> postfix : ${grow(totals.prefix.mainText, totals.postfix.mainText)}`);
  console.log(`Readability's own share of mainText: ${totals.postfix.mainText - totals.noReadab.mainText} chars ` +
    `(${(100 * (totals.postfix.mainText - totals.noReadab.mainText) / Math.max(1, totals.postfix.mainText)).toFixed(0)}%)`);
  console.log(`Boilerplate blocks in mainText     : no-readab ${totals.noReadab.boilerplate} -> postfix ${totals.postfix.boilerplate}`);
  console.log('');
  console.log('Read the mainText delta as precision, not volume: Readability returns');
  console.log('FEWER characters than body-innerText because it drops nav/footer chrome.');
  console.log('The boilerplate row is the quality signal; raw char count is not.');
  console.log('');
})().catch(err => { console.error(err); process.exit(1); });
