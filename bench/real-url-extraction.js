// bench/real-url-extraction.js
// Runs the PRODUCTION extraction path (extract-core.js __tsExtract, the exact
// function chrome.scripting.executeScript injects into real tabs) against LIVE
// URLs, then embeds each card's pseudoDoc and cosine-scores it against
// "group all amazon tabs" -- to answer two questions with data instead of
// guesses:
//
//   1. Does page-text extraction produce usable cards on real pages
//      (mainText volume, keywords, structured type, domain)?
//   2. With those real cards, does the SEMANTIC path even rank amazon-hosted
//      tabs above noise for an "all amazon tabs" query -- or is that exactly
//      why the deterministic domain fast path is required?
//
//   node bench/real-url-extraction.js

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const EXTRACT_SRC = fs.readFileSync(path.join(ROOT, 'extract-core.js'), 'utf8');

const CACHE = path.join(__dirname, '.embed-cache.json');
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

// Real production-representative URLs. Amazon product + cart-adjacent pages are
// the user's actual failing scenario ("7 amazon tabs open").
const URLS = [
  'https://www.amazon.com/dp/B0CHX2F5QT',                       // amazon.com product (Echo Pop style dp)
  'https://www.amazon.in/dp/B0D3PVL1NG',                        // amazon.in product
  'https://www.amazon.co.uk/gp/bestsellers/electronics',        // amazon.co.uk list page
  'https://github.com/facebook/react',
  'https://en.wikipedia.org/wiki/Cricket',
  'https://www.bbc.com/news',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });

  const cache = loadCache();
  const embed = await getEmbedder(cache);
  const qVec = await embed('group all amazon tabs');

  const results = [];
  for (const url of URLS) {
    const row = { url, ok: false };
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      row.httpStatus = resp ? resp.status() : null;
      // Give SPA/JSON-LD a beat; amazon bot-wall detection below.
      await new Promise(r => setTimeout(r, 1200));

      // Mirror tab-cards.js: inject extract-core.js, then call __tsExtract.
      await page.evaluate(EXTRACT_SRC);
      const out = await page.evaluate(() => globalThis.__tsExtract(document, window.location));
      if (!out) throw new Error('__tsExtract returned nothing');

      const pageTitle = await page.title();
      const host = (() => { try { return new URL(page.url()).hostname.replace(/^www\./, ''); } catch { return ''; } })();
      row.ok = true;
      row.finalUrl = page.url().slice(0, 90);
      row.botWall = /captcha|robot/i.test(pageTitle) || (out.mainText || '').length < 200;
      row.domain = host;
      row.title = (pageTitle || '').slice(0, 70);
      row.extractionLevel = out.extractionLevel || '';
      row.mainTextChars = (out.mainText || '').length;
      row.keywords = (out.structured?.keywords || []).length;
      row.structType = out.structured?.type || '';
      row.sampleText = (out.mainText || '').replace(/\s+/g, ' ').slice(0, 140);

      // pseudoDoc exactly as buildTabCard builds it when richData.pseudoDoc exists,
      // else the fallback string.
      const fallback = `${row.title} ${row.title} ${host.split('.').slice(-2).join(' ')}`.trim();
      const pseudoDoc = out.pseudoDoc || fallback;
      row.pseudoDocChars = pseudoDoc.length;
      const vec = await embed(pseudoDoc.slice(0, 2000));
      row.cosineToQuery = Number(cosine(qVec, vec).toFixed(4));
      row.amazonHosted = /(^|\.)amazon\.(com|in|co\.uk|de)$/.test(host);
    } catch (e) {
      row.error = e.message.slice(0, 120);
    }
    results.push(row);
    console.log(`${row.ok ? (row.botWall ? 'WARN' : 'ok  ') : 'ERR '} ${url}`);
    if (row.error) console.log(`      ${row.error}`);
  }
  await browser.close();
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  console.log('\n=== EXTRACTION QUALITY (real pages, production __tsExtract) ===');
  for (const r of results) {
    if (!r.ok) { console.log(`\n${r.url}\n  ERROR: ${r.error}`); continue; }
    console.log(`\n${r.url}`);
    console.log(`  http=${r.httpStatus} final=${r.finalUrl}`);
    console.log(`  domain=${r.domain}  amazonHosted=${r.amazonHosted}  botWall=${r.botWall}`);
    console.log(`  title="${r.title}"`);
    console.log(`  extractionLevel=${r.extractionLevel} mainTextChars=${r.mainTextChars} keywords=${r.keywords} structType=${r.structType}`);
    console.log(`  text sample: "${r.sampleText}"`);
    console.log(`  pseudoDocChars=${r.pseudoDocChars}  cosine("group all amazon tabs")=${r.cosineToQuery}`);
  }

  const amz = results.filter(r => r.amazonHosted && r.ok);
  const non = results.filter(r => !r.amazonHosted && r.ok && !r.botWall);
  if (amz.length && non.length) {
    const bestNon = Math.max(...non.map(r => r.cosineToQuery));
    console.log('\n=== VERDICT ===');
    console.log(`amazon cards cosine range : ${Math.min(...amz.map(r => r.cosineToQuery))} .. ${Math.max(...amz.map(r => r.cosineToQuery))}`);
    console.log(`best NON-amazon cosine    : ${bestNon}`);
    const separated = amz.every(r => r.cosineToQuery > bestNon);
    console.log(separated
      ? 'Semantic ranking WOULD separate amazon tabs on this sample.'
      : 'Semantic ranking CANNOT reliably separate amazon tabs on this sample -> confirms hostname predicates must be resolved deterministically (the new syntactic-domain fast path), not via embeddings.');
  }
})().catch(e => { console.error(e); process.exit(1); });
