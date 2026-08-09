#!/usr/bin/env node
// Probe: print enrichment tags for the exact 18 test URLs (real MiniLM).
const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..');

const TAB_SETS = {
  geography: ['Geography', 'Earth', 'Mountain', 'River', 'Ocean'],
  sports: ['Cricket', 'Association_football', 'Basketball', 'Tennis'],
  entertainment: ['Film', 'Music', 'Radio', 'Television'],
  astronomy: ['Astronomy', 'Star', 'Galaxy'],
  tech: ['Artificial_intelligence', 'Computer_programming'],
};
const ALL = Object.values(TAB_SETS).flat().map(s => `https://en.wikipedia.org/wiki/${s}`);

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    protocolTimeout: 600000,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let bg;
  for (let i = 0; i < 40; i++) {
    const targets = await browser.targets();
    bg = targets.find(t => t.type() === 'service_worker' || t.type() === 'background_page');
    if (bg) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const cdp = await bg.createCDPSession();

  for (const url of ALL) {
    const p = await browser.newPage();
    try { await p.goto(url, { waitUntil: 'load', timeout: 30000 }); } catch (e) {}
  }

  let state = null;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        await ensureRagReady();
        const cards = await TabDB.getAllTabCards();
        return JSON.stringify(cards.filter(c => c.url && c.url.includes('wikipedia')).map(c => ({
          title: c.title,
          tags: (c.enrichment?.tags || []).slice(0, 4).map(t => t.tag + '@' + t.score).join(' '),
          subTopics: (c.enrichment?.subTopics || []).slice(0, 3).join(','),
          kw: (c.structured?.keywords || []).slice(0, 5).join(','),
        })));
      })()`,
      awaitPromise: true, returnByValue: true, timeout: 30000,
    });
    state = JSON.parse(res.result.value);
    if (state.length >= 17) break;
  }
  for (const c of state.sort((a, b) => a.title.localeCompare(b.title))) {
    console.log(c.title.padEnd(28), '|', c.tags.padEnd(48), '|', c.subTopics);
  }
  await cdp.detach();
  await browser.close();
})();
