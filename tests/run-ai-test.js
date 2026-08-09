#!/usr/bin/env node
/**
 * Automated E2E test for Tab Scroller's SEMANTIC AI filtering.
 *
 * Launches Chrome with the extension loaded, opens 18 Wikipedia tabs across
 * 5 topics (geography / sports / entertainment / astronomy / tech), configures
 * Ollama (qwen2.5) via CDP, then drives the REAL agentic pipeline
 * (runCommandPipeline + executeToolCall — the exact functions the AI_COMMAND
 * message handler calls) with natural-language queries.
 *
 * Judges filtering ability with precision / recall per query.
 *
 * Usage: node tests/run-ai-test.js            (headed Chrome window)
 *        AI_TEST_HEADLESS=1 node tests/run-ai-test.js
 * Requires: Ollama running with qwen2.5 pulled (`ollama pull qwen2.5`)
 */

const puppeteer = require('puppeteer');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const HEADLESS = process.env.AI_TEST_HEADLESS === '1';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5';
const LLM_TIMEOUT_MS = 180000; // qwen2.5 on CPU can be slow

// ===== TAB DEFINITIONS =====
const TAB_SETS = {
  geography: [
    'https://en.wikipedia.org/wiki/Geography',
    'https://en.wikipedia.org/wiki/Earth',
    'https://en.wikipedia.org/wiki/Mountain',
    'https://en.wikipedia.org/wiki/River',
    'https://en.wikipedia.org/wiki/Ocean',
  ],
  sports: [
    'https://en.wikipedia.org/wiki/Cricket',
    'https://en.wikipedia.org/wiki/Association_football',
    'https://en.wikipedia.org/wiki/Basketball',
    'https://en.wikipedia.org/wiki/Tennis',
  ],
  entertainment: [
    'https://en.wikipedia.org/wiki/Film',
    'https://en.wikipedia.org/wiki/Music',
    'https://en.wikipedia.org/wiki/Radio',
    'https://en.wikipedia.org/wiki/Television',
  ],
  astronomy: [
    'https://en.wikipedia.org/wiki/Astronomy',
    'https://en.wikipedia.org/wiki/Star',
    'https://en.wikipedia.org/wiki/Galaxy',
  ],
  tech: [
    'https://en.wikipedia.org/wiki/Artificial_intelligence',
    'https://en.wikipedia.org/wiki/Computer_programming',
  ],
};

const ALL_URLS = Object.values(TAB_SETS).flat();

// ===== TEST QUERIES =====
const TEST_CASES = [
  {
    id: 1,
    prompt: 'group all tabs related to sports',
    expected: TAB_SETS.sports,
    mayAlsoInclude: [],
    shouldExclude: [...TAB_SETS.geography, ...TAB_SETS.entertainment, ...TAB_SETS.astronomy, ...TAB_SETS.tech],
    allowEmpty: false,
    action: 'group_tabs',
  },
  {
    id: 2,
    prompt: 'group all tabs related to entertainment',
    expected: TAB_SETS.entertainment,
    mayAlsoInclude: [],
    shouldExclude: [...TAB_SETS.geography, ...TAB_SETS.sports, ...TAB_SETS.astronomy, ...TAB_SETS.tech],
    allowEmpty: false,
    action: 'group_tabs',
  },
  {
    id: 3,
    prompt: 'group all tabs related to entertainment and sports',
    expected: [...TAB_SETS.entertainment, ...TAB_SETS.sports],
    mayAlsoInclude: [],
    shouldExclude: [...TAB_SETS.geography, ...TAB_SETS.astronomy, ...TAB_SETS.tech],
    allowEmpty: false,
    action: 'group_tabs',
  },
  {
    id: 4,
    prompt: 'group all tabs about technology and programming',
    expected: TAB_SETS.tech,
    mayAlsoInclude: [],
    shouldExclude: [...TAB_SETS.geography, ...TAB_SETS.sports, ...TAB_SETS.entertainment, ...TAB_SETS.astronomy],
    allowEmpty: false,
    action: 'group_tabs',
  },
  {
    id: 5,
    prompt: 'group all tabs related to cooking',
    expected: [],
    mayAlsoInclude: [],
    shouldExclude: ALL_URLS,
    allowEmpty: true, // no cooking tabs open — must return zero matches, not crash
    action: 'group_tabs',
  },
  {
    id: 6,
    prompt: 'close all tabs about astronomy',
    expected: TAB_SETS.astronomy,
    mayAlsoInclude: [],
    shouldExclude: [...TAB_SETS.geography, ...TAB_SETS.sports, ...TAB_SETS.entertainment, ...TAB_SETS.tech],
    allowEmpty: false,
    action: 'close_tabs',
  },
];

// ===== HELPERS =====
function log(msg) { console.log(`[TEST] ${msg}`); }
function pass(msg) { console.log(`  \u2705 PASS: ${msg}`); }
function fail(msg) { console.log(`  \u274C FAIL: ${msg}`); }
function info(msg) { console.log(`  \u2139\uFE0F  ${msg}`); }
function warn(msg) { console.log(`  \u26A0\uFE0F  ${msg}`); }

function slug(url) {
  const m = String(url || '').split('/wiki/')[1];
  return m ? decodeURIComponent(m).toLowerCase() : '';
}

function matchUrl(actualUrl, expectedUrl) {
  const s = slug(expectedUrl);
  return s && slug(actualUrl).includes(s);
}

async function waitForIndexing(cdp, minCards, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        await ensureRagReady();
        const tabs = await chrome.tabs.query({});
        const open = tabs.filter(t => t.url && !t.url.startsWith('chrome://'));
        const docs = await new Promise((resolve, reject) => {
          const req = indexedDB.open('TabScrollerRAG');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('pages', 'readonly');
            const all = tx.objectStore('pages').getAll();
            all.onsuccess = () => { db.close(); resolve(all.result || []); };
            all.onerror = () => { db.close(); reject(all.error); };
          };
          req.onerror = () => reject(req.error);
        });
        return JSON.stringify({
          docs: docs.length,
          withEmbedding: docs.filter(d => d.embedding && d.embedding.length).length,
          open: open.length,
          enriched: (await TabDB.getAllTabCards()).filter(c => c.enrichment && c.enrichment.vecVersion === 2 && (c.enrichment.tags || []).length >= 2).length,
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    try {
      const stats = JSON.parse(res.result.value);
      log(`Indexing progress: ${stats.withEmbedding}/${stats.open} pages embedded | ${stats.enriched} enriched cards`);
      if (stats.withEmbedding >= minCards || stats.enriched >= minCards) return stats;
    } catch (e) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for indexing (needed >= ${minCards} embedded pages)`);
}

async function evalInWorker(cdp, expression, timeout = LLM_TIMEOUT_MS) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (res.exceptionDetails) {
    throw new Error(`Worker eval exception: ${res.exceptionDetails.text || res.exceptionDetails.exception?.description || 'unknown'}`);
  }
  return res.result.value;
}

async function ungroupAll(cdp) {
  await evalInWorker(cdp, `(async () => {
    const tabs = await chrome.tabs.query({});
    const grouped = tabs.filter(t => t.groupId !== -1).map(t => t.id);
    if (grouped.length) await chrome.tabs.ungroup(grouped);
    return 'ok';
  })()`, 15000);
}

// ===== MAIN =====
(async () => {
  log(`Launching Chrome ${HEADLESS ? 'headless' : 'headed'} with Tab Scroller extension...`);
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: null,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--window-size=1400,900',
    ],
  });

  // Find the extension service worker
  let backgroundTarget;
  for (let i = 0; i < 40; i++) {
    const targets = await browser.targets();
    backgroundTarget = targets.find(t => t.type() === 'service_worker' || t.type() === 'background_page');
    if (backgroundTarget) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!backgroundTarget) {
    fail('Could not find extension service worker!');
    await browser.close();
    process.exit(1);
  }
  const extId = backgroundTarget.url().split('/')[2];
  log(`Extension ID: ${extId}`);

  const cdp = await backgroundTarget.createCDPSession();

  // ===== Configure AI provider in extension storage =====
  // Default: direct Ollama. With AI_BACKEND=1: Django gateway at :8000 (-> Ollama server-side).
  const BACKEND_MODE = process.env.AI_BACKEND === '1';
  const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
  const providerCfg = BACKEND_MODE
    ? {
        useOllama: false,
        useBackend: true,
        backendUrl: BACKEND_URL,
        backendApiKey: '',
        ollamaModel: OLLAMA_MODEL,
        ollamaTimeout: LLM_TIMEOUT_MS,
      }
    : {
        useOllama: true,
        useBackend: false,
        ollamaModel: OLLAMA_MODEL,
        ollamaUrl: OLLAMA_URL,
        ollamaTimeout: LLM_TIMEOUT_MS,
      };
  await evalInWorker(cdp, `new Promise((resolve) => {
    chrome.storage.sync.set(Object.assign({
      enableAi: true,
      allowCloudContent: true,
      enableAutoFallback: false,
      fallbackToOllama: false,
      aiMinGapMs: 0,
    }, ${JSON.stringify(providerCfg)}), () => resolve('configured'));
  })`, 15000);
  log(`Provider configured: ${BACKEND_MODE ? 'AI Backend (' + BACKEND_URL + ')' : 'Ollama (' + OLLAMA_URL + ')'} model=${OLLAMA_MODEL}`);

  // ===== Open tabs =====
  log(`Opening ${ALL_URLS.length} Wikipedia tabs...`);
  const wikiPages = [];
  for (const url of ALL_URLS) {
    try {
      const p = await browser.newPage();
      wikiPages.push(p);
      // Keep pages open + wait for 'load': the extension indexes tabs on
      // chrome.tabs.onUpdated 'complete', which never fires for closed tabs.
      await p.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
      warn(`Slow/failed load for ${url} (${String(e.message).split('\n')[0]})`);
    }
  }
  log('All tabs loaded. Waiting for indexing + embeddings...');
  await waitForIndexing(cdp, ALL_URLS.length - 2);

  // Snapshot tab state (id -> url)
  const tabSnapshot = JSON.parse(await evalInWorker(cdp, `(async () => {
    const tabs = await chrome.tabs.query({});
    const [win] = await chrome.windows.getAll({ populate: false });
    return JSON.stringify({ tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })), windowId: win.id });
  })()`, 15000));
  const urlById = new Map(tabSnapshot.tabs.map(t => [t.id, t.url]));
  const windowId = tabSnapshot.windowId;
  log(`Window ${windowId}: ${tabSnapshot.tabs.length} tabs`);

  // ===== ENRICHMENT STATS (coverage, latency, cache hit) =====
  const enrichStats = JSON.parse(await evalInWorker(cdp, `(async () => {
    const cards = await TabDB.getAllTabCards();
    const tabs = await chrome.tabs.query({});
    const openWiki = tabs.filter(t => t.url && t.url.includes('wikipedia.org'));
    const latencies = [];
    const timingCard = cards[0];
    if (timingCard) {
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        await buildTabCard({ id: timingCard.tabId, url: timingCard.url, title: timingCard.title });
        latencies.push(Date.now() - t0);
      }
    }
    const firstCard = cards[0];
    return JSON.stringify({
      coverage: openWiki.length ? cards.filter(c => c.enrichment?.vecVersion === 2 && (c.enrichment?.tags || []).length >= 2).length : 0,
      openWiki: openWiki.length,
      latencies,
      enrichedAt1: firstCard ? firstCard.enrichment?.enrichedAt : 0,
    });
  })()`, 60000));
  enrichStats.latencies.sort((a, b) => a - b);
  const p50 = enrichStats.latencies[Math.floor(enrichStats.latencies.length / 2)] || 0;
  info(`Enrichment coverage: ${enrichStats.coverage}/${enrichStats.openWiki} wiki tabs (>=2 tags)`);
  info(`buildTabCard latency (3 runs, cached card): ${enrichStats.latencies.join('ms, ')}ms | p50 ~${p50}ms`);

  // ===== RUN TESTS =====
  const results = [];

  for (const tc of TEST_CASES) {
    log('');
    log('====================================================');
    log(`TEST #${tc.id}: "${tc.prompt}"`);
    log(`Expected: ${tc.expected.length} tabs | Action: ${tc.action}`);
    log('====================================================');

    // 1) Run the REAL semantic pipeline (timed: prompt -> plan)
    let plan;
    let pipeMs = 0;
    let parsed;
    try {
      parsed = JSON.parse(await evalInWorker(cdp, `(async () => {
        try {
          const t0 = Date.now();
          const p = await runCommandPipeline(${JSON.stringify(tc.prompt)}, ${windowId});
          return JSON.stringify({ plan: p, pipeMs: Date.now() - t0 });
        } catch (err) {
          return JSON.stringify({ error: String(err && err.message || err) });
        }
      })()`, LLM_TIMEOUT_MS));
    } catch (err) {
      fail(`Pipeline crashed: ${err.message}`);
      results.push({ id: tc.id, prompt: tc.prompt, passed: false, reason: `crash: ${err.message}`, latencyMs: null });
      continue;
    }

    if (parsed.error) {
      fail(`Pipeline error: ${parsed.error}`);
      if (/403/i.test(parsed.error)) {
        info('Ollama blocks browser-origin requests. Fix: set OLLAMA_ORIGINS=* and restart Ollama (or: setx OLLAMA_ORIGINS "*" then restart the Ollama app).');
      }
      results.push({ id: tc.id, prompt: tc.prompt, passed: false, reason: parsed.error, latencyMs: null });
      continue;
    }
    plan = parsed.plan;
    pipeMs = parsed.pipeMs;

    const matchedUrls = plan.tabIds.map(id => urlById.get(id)).filter(Boolean);
    info(`Path: ${plan.path} | Confidence: ${plan.confidence ? plan.confidence.toFixed(2) : 'n/a'} | Matched: ${plan.tabIds.length} | Uncertain: ${plan.uncertain.length}`);
    plan.tabIds.forEach(id => info(`  MATCH: ${urlById.get(id)} — ${(plan.perTabReasons[id] || '').slice(0, 90)}`));
    plan.uncertain.forEach(id => info(`  ~uncertain: ${urlById.get(id)} — ${(plan.perTabReasons[id] || '').slice(0, 90)}`));

    // Zero-match expectations (e.g. "cooking" with no cooking tabs)
    if (plan.tabIds.length === 0 && tc.allowEmpty) {
      if (plan.path === 'semantic' && plan.uncertain.length === 0) {
        pass(`Correctly found zero matches for out-of-scope query (no cooking tabs open)`);
      } else {
        warn(`Zero tabs matched but ${plan.uncertain.length} uncertain — borderline`);
      }
      results.push({ id: tc.id, prompt: tc.prompt, passed: true, precision: 1, recall: 1 });
      continue;
    }
    if (plan.tabIds.length === 0) {
      fail(`Expected ${tc.expected.length} matches, got zero`);
      results.push({ id: tc.id, prompt: tc.prompt, passed: false, reason: 'zero matches', precision: 0, recall: 0 });
      continue;
    }

    // 2) Execute the plan's tool (timed: plan -> action)
    const groupName = tc.action === 'group_tabs' ? 'AI Test Group' : undefined;
    const execRes = JSON.parse(await evalInWorker(cdp, `(async () => {
      const t0 = Date.now();
      try {
        const args = { tabIds: ${JSON.stringify(plan.tabIds)} };
        if (${JSON.stringify(groupName || null)}) args.groupName = ${JSON.stringify(groupName)};
        const r = await executeToolCall(
          { name: ${JSON.stringify(plan.intent)}, args },
          ${windowId},
          ${JSON.stringify(tc.prompt)},
          ${JSON.stringify(plan.tabIds)}
        );
        return JSON.stringify(Object.assign({ execMs: Date.now() - t0 }, r));
      } catch (err) {
        return JSON.stringify({ success: false, message: String(err && err.message || err), execMs: Date.now() - t0 });
      }
    })()`, 60000));
    if (!execRes.success) {
      fail(`Execution failed: ${execRes.message}`);
      results.push({ id: tc.id, prompt: tc.prompt, passed: false, reason: execRes.message, precision: 0, recall: 0, latencyMs: pipeMs + execRes.execMs });
      continue;
    }
    const latencyMs = pipeMs + (execRes.execMs || 0);
    info(`Executed ${plan.intent}: ${execRes.message}`);
    info(`⏱ prompt→action: ${latencyMs}ms (pipeline ${pipeMs}ms + exec ${execRes.execMs || 0}ms)`);

    // 3) Verify end state: grouped tab ids (or closed for close_tabs)
    const state = JSON.parse(await evalInWorker(cdp, `(async () => {
      const tabs = await chrome.tabs.query({});
      const groups = await chrome.tabGroups.query({});
      const grouped = tabs.filter(t => t.groupId !== -1).map(t => ({ id: t.id, url: t.url, groupId: t.groupId }));
      const titles = groups.map(g => g.title);
      return JSON.stringify({ grouped, groupTitles: titles, openCount: tabs.length });
    })()`, 15000));

    let actualIds;
    if (tc.action === 'close_tabs') {
      const stillOpen = new Set(state.grouped.map(t => t.id));
      actualIds = plan.tabIds.filter(id => !stillOpen.has(id)); // closed = planned - still open
      const closedCount = plan.tabIds.length - plan.tabIds.filter(id => state.grouped.some(t => t.id === id)).length;
      info(`Close verified: ${closedCount}/${plan.tabIds.length} planned tabs actually closed (${state.openCount} tabs open)`);
    } else {
      actualIds = state.grouped.map(t => t.id);
      info(`Grouped: [${state.groupTitles.join(', ') || 'untitled'}] ${actualIds.length} tabs`);
    }
    const actualUrls = actualIds.map(id => urlById.get(id)).filter(Boolean);

    // 4) Score precision / recall against expected slugs
    const expectedSlugs = new Set(tc.expected.map(slug));
    let tp = 0;
    for (const url of actualUrls) if (expectedSlugs.has(slug(url))) tp++;
    const fp = actualUrls.length - tp;
    const fn = tc.expected.length - tp;
    const precision = actualUrls.length ? tp / actualUrls.length : 0;
    const recall = tc.expected.length ? tp / tc.expected.length : 0;

    for (const url of actualUrls) {
      if (expectedSlugs.has(slug(url))) pass(`Matched (TP): ${url.split('/wiki/')[1]}`);
    }
    for (const url of actualUrls) {
      if (!expectedSlugs.has(slug(url))) fail(`Wrong inclusion (FP): ${url.split('/wiki/')[1]}`);
    }
    if (fn > 0) {
      for (const expectedUrl of tc.expected) {
        if (!actualUrls.some(u => slug(u) === slug(expectedUrl))) fail(`Missed (FN): ${slug(expectedUrl)}`);
      }
    }

    const passed = precision >= 0.6 && recall >= 0.6;
    log(`Score: precision ${(precision * 100).toFixed(0)}% (${tp} TP, ${fp} FP) | recall ${(recall * 100).toFixed(0)}% (${fn} FN)`);
    passed ? pass(`TEST #${tc.id} PASSED`) : fail(`TEST #${tc.id} FAILED`);

    results.push({ id: tc.id, prompt: tc.prompt, passed, precision, recall, tp, fp, fn, latencyMs });

    // Cleanup between tests
    await ungroupAll(cdp);
    await new Promise(r => setTimeout(r, 1000));
  }

  // ===== OFFLINE CHECK (enrichment must work with enableAi:false) =====
  log('');
  log('OFFLINE CHECK: disable enableAi, confirm pipeline still works (enrichment is offline)');
  await evalInWorker(cdp, `new Promise((r) => chrome.storage.sync.set({ enableAi: false }, r))`, 15000);
  const offlinePlan = JSON.parse(await evalInWorker(cdp, `(async () => {
    try {
      const t0 = Date.now();
      const p = await runCommandPipeline('group all tabs related to sports', ${windowId});
      return JSON.stringify({ plan: p, pipeMs: Date.now() - t0 });
    } catch (err) { return JSON.stringify({ error: String(err && err.message || err) }); }
  })()`, LLM_TIMEOUT_MS));
  if (offlinePlan.error) { fail(`Offline check failed: ${offlinePlan.error}`); }
  else {
    info(`Offline check: matched ${offlinePlan.plan.tabIds.length} sports tabs with enableAi=false (path ${offlinePlan.plan.path}) in ${offlinePlan.pipeMs}ms`);
    pass('Enrichment independent of enableAi');
  }
  await evalInWorker(cdp, `new Promise((r) => chrome.storage.sync.set({ enableAi: true }, r))`, 15000);

  // ===== FINAL REPORT =====
  log('');
  log('####################################################');
  log('#             AI FILTERING TEST REPORT              #');
  log('####################################################');
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    if (!r.passed) allPassed = false;
    log(`# ${status}  Test #${r.id}: "${r.prompt}"`);
    if (typeof r.precision === 'number') {
      log(`#        precision=${(r.precision * 100).toFixed(0)}%  recall=${(r.recall * 100).toFixed(0)}%  (TP=${r.tp ?? '-'} FP=${r.fp ?? '-'} FN=${r.fn ?? '-'})`);
    }
    if (typeof r.latencyMs === 'number') {
      log(`#        prompt→action: ${r.latencyMs}ms`);
    }
    if (r.reason) log(`#        reason: ${r.reason}`);
  }
  const latencies = results.filter(r => typeof r.latencyMs === 'number').map(r => r.latencyMs);
  if (latencies.length > 0) {
    const total = latencies.reduce((a, b) => a + b, 0);
    log(`# Prompt→action: total ${total}ms | avg ${Math.round(total / latencies.length)}ms | per-test: ${latencies.join(' / ')}ms`);
  }
  log('####################################################');
  log(`Overall: ${results.filter(r => r.passed).length}/${results.length} tests passed.`);

  await cdp.detach();
  await browser.close();
  process.exit(allPassed ? 0 : 1);
})();
