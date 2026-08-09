#!/usr/bin/env node
// Probe: math enrichment end-to-end in the real service worker (real MiniLM).
const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
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
  const logs = [];
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (e) => {
    const txt = (e.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    logs.push(txt.slice(0, 200));
  });

  await cdp.send('Runtime.evaluate', {
    expression: `new Promise((r) => chrome.storage.sync.set({ enableAi: true, useOllama: true, ollamaModel: 'qwen2.5', ollamaUrl: 'http://localhost:11434' }, r))`,
    awaitPromise: true, returnByValue: true, timeout: 15000,
  });

  const p1 = await browser.newPage();
  await p1.goto('https://en.wikipedia.org/wiki/Cricket', { waitUntil: 'load', timeout: 30000 });
  const p2 = await browser.newPage();
  await p2.goto('https://en.wikipedia.org/wiki/Film', { waitUntil: 'load', timeout: 30000 });
  const p3 = await browser.newPage();
  await p3.goto('https://en.wikipedia.org/wiki/Astronomy', { waitUntil: 'load', timeout: 30000 });

  // poll for enriched cards
  let state = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        await ensureRagReady();
        const cards = await TabDB.getAllTabCards();
        return JSON.stringify(cards.filter(c => c.url && c.url.includes('wikipedia')).map(c => ({
          title: c.title,
          v2: c.enrichment?.vecVersion === 2,
          category: c.enrichment?.category,
          tags: (c.enrichment?.tags || []).map(t => t.tag + '@' + t.score).join(','),
          subTopics: (c.enrichment?.subTopics || []).join(','),
          contentType: c.enrichment?.contentType,
          hasEmb: !!(c.embedding && c.embedding.length),
          pseudoLen: (c.pseudoDoc || '').length,
        })));
      })()`,
      awaitPromise: true, returnByValue: true, timeout: 30000,
    });
    state = JSON.parse(res.result.value);
    if (state.length === 3 && state.every(c => c.v2 && c.tags)) break;
  }
  console.log('CARDS:');
  for (const c of state) console.log('  ', JSON.stringify(c));
  console.log('LOGS (errors/enrich):');
  for (const l of logs.filter(l => /mathEnrich|TabCards|error|Error|Failed/i.test(l)).slice(-10)) console.log('  ', l.slice(0, 160));
  await cdp.detach();
  await browser.close();
})();
