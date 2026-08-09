const {
  launchWithExtension,
  configureOllama,
  overrideAutoExecuteThreshold,
  restoreAutoExecuteThreshold,
  openTabSet,
  getFirstRealTabId,
  sendAiCommandFullPipeline,
  execDirectAiCommand,
  getTabState,
  resetTabState,
  closeExtraTabs,
  closeAllRealTabs,
  waitForTabCount,
  seedTabDB,
  executeInBackground,
  sleep,
} = require('./runner');
const { WIKI_SETS } = require('./fixtures');
const testCases = require('./testcases');

jest.setTimeout(600000);

function buildTabUrls(tc) {
  if (tc.options?.legacySet) {
    const legacySets = {
      'legacy-tv-geo': [...WIKI_SETS.geography, ...WIKI_SETS.television, ...WIKI_SETS.tv_geography,
        ...WIKI_SETS.astronomy, ...WIKI_SETS.tv_astronomy],
      'legacy-tv-astro': [...WIKI_SETS.astronomy, ...WIKI_SETS.tv_astronomy],
      'legacy-tv-broadcast': [...WIKI_SETS.television, ...WIKI_SETS.tv_geography, ...WIKI_SETS.tv_astronomy,
        ...WIKI_SETS.geography, ...WIKI_SETS.astronomy],
    };
    return legacySets[tc.setup.tabSet] || [];
  }
  if (tc.setup.tabCount) {
    const stressSets = {
      'stress-medium': generateStressUrls(20),
      'stress-large': generateStressUrls(40),
    };
    return stressSets[tc.setup.tabSet] || [];
  }
  if (tc.setup.multiSet && Array.isArray(tc.setup.tabSet)) {
    return tc.setup.tabSet.flatMap(s => WIKI_SETS[s]);
  }
  return WIKI_SETS[tc.setup.tabSet] || [];
}

function generateStressUrls(count) {
  const pools = Object.values(WIKI_SETS).flat();
  const urls = [];
  for (let i = 0; i < count; i++) {
    urls.push(pools[i % pools.length]);
  }
  return urls;
}

describe('Tab Scroller E2E: Full AI_COMMAND Pipeline', () => {
  const tiers = [1, 2, 3, 4];

  beforeAll(async () => {
    const ollamaCheck = await checkOllama();
    if (ollamaCheck) {
      console.log('Ollama reachable — tests will use LLM pipeline');
    } else {
      console.warn('Ollama NOT reachable at localhost:11434 — LLM-dependent tests will fail');
    }
  });

  for (const tier of tiers) {
    const tierCases = testCases.filter(tc => tc.tier === tier);
    if (tierCases.length === 0) continue;

    describe(`Tier ${tier}`, () => {
      let browser, bgTarget, bgCdp, optionsPage;

      beforeAll(async () => {
        const result = await launchWithExtension();
        browser = result.browser;
        bgTarget = result.bgTarget;
        optionsPage = result.optionsPage;
        bgCdp = await bgTarget.createCDPSession();
        await configureOllama(bgCdp);
        await sleep(2000);

        if (tier === 4) {
          console.log(`[Tier ${tier}] Seeding TabDB with 40 synthetic docs`);
          const docs = generateSyntheticDocs(40);
          const seedResult = await seedTabDB(bgCdp, docs);
          const seeded = seedResult.filter(r => r.success).length;
          console.log(`[Tier ${tier}] Seeded ${seeded}/${docs.length} docs`);
        }
      }, 60000);

      afterAll(async () => {
        try {
          await closeAllRealTabs(optionsPage);
        } catch (e) { /* ignore */ }
        try { await bgCdp.detach(); } catch (e) { /* ignore */ }
        try { await browser.close(); } catch (e) { /* ignore */ }
      }, 30000);

      for (const tc of tierCases) {
        test(tc.description, async () => {
          const urls = buildTabUrls(tc);
          if (urls.length === 0) {
            console.warn(`[${tc.id}] No URLs — skipping tab setup`);
          }

          if (urls.length > 0) {
            await openTabSet(browser, urls);
            await waitForTabCount(optionsPage, urls.length);
            await sleep(2000);
          }

          if (tc.setup.pinSome && Array.isArray(tc.setup.pinSome)) {
            const state = await getTabState(optionsPage);
            const realTabs = state.tabs.filter(t =>
              t.url && !t.url.startsWith('chrome-extension://')
            );
            for (const idx of tc.setup.pinSome) {
              if (realTabs[idx]) {
                await executeInBackground(bgCdp, `
                  (async () => {
                    await chrome.tabs.update(${realTabs[idx].id}, { pinned: true });
                  })()
                `);
              }
            }
            await sleep(500);
          }

          const stateBefore = await getTabState(optionsPage);
          const result = await runTestCase(tc, bgCdp, optionsPage);
          const stateAfter = await getTabState(optionsPage);

          expect(result).toBeDefined();
          expect(result.success).toBe(true);

          evaluateResults(tc, result, stateBefore, stateAfter);

          await resetTabState(optionsPage);
          await closeExtraTabs(optionsPage, 1);
        }, tc.options?.timeouts?.llm
          ? tc.options.timeouts.llm + 120000
          : 240000);
      }
    });
  }
});

async function checkOllama() {
  try {
    const http = require('http');
    return await new Promise((resolve) => {
      const req = http.get('http://localhost:11434/api/tags', { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

async function runTestCase(tc, bgCdp, optionsPage) {
  if (tc.options?.isDestructive) {
    await overrideAutoExecuteThreshold(bgCdp, 0);
  }

  try {
    if (tc.expected.intent === 'recall_tabs' || !tc.options?.useFullPipeline) {
      return await execDirectAiCommand(tc.command, bgCdp);
    }

    const realTabId = await getFirstRealTabId(optionsPage);
    if (!realTabId) {
      console.warn(`[${tc.id}] No real tab for full pipeline, falling back to direct CDP`);
      return await execDirectAiCommand(tc.command, bgCdp);
    }

    return await sendAiCommandFullPipeline(tc.command, bgCdp, realTabId);
  } finally {
    if (tc.options?.isDestructive) {
      await restoreAutoExecuteThreshold(bgCdp);
    }
  }
}

function evaluateResults(tc, result, before, after) {
  const expected = tc.expected.intent;
  const actualIntent = result.intent || result.tool;

  if (!Array.isArray(expected)) {
    expect(actualIntent).toBe(expected);
  }

  if (expected === 'close_tabs') {
    const realBefore = before.tabs.filter(t => t.url && !t.url.startsWith('chrome-extension://'));
    const realAfter = after.tabs.filter(t => t.url && !t.url.startsWith('chrome-extension://'));
    console.log(`[${tc.id}] Tabs before=${realBefore.length}, after=${realAfter.length}`);

    if (tc.setup.pinSome) {
      const pinnedAfter = realAfter.filter(t => t.pinned);
      const pinnedBefore = realBefore.filter(t => t.pinned);
      console.log(`[${tc.id}] Pinned tabs before=${pinnedBefore.length}, after=${pinnedAfter.length}`);
    }
  }

  if (expected === 'group_tabs') {
    const beforeGrouped = before.tabs.filter(t => t.groupId !== -1).length;
    const afterGrouped = after.tabs.filter(t => t.groupId !== -1).length;
    console.log(`[${tc.id}] Grouped tabs: ${beforeGrouped} → ${afterGrouped}`);
    expect(afterGrouped).toBeGreaterThan(beforeGrouped);
  }

  if (expected === 'recall_tabs') {
    expect(result.message).toBeDefined();
    console.log(`[${tc.id}] recall_tabs: ${result.message}`);
  }

  if (expected === 'pin_tabs') {
    const beforePinned = before.tabs.filter(t => t.pinned).length;
    const afterPinned = after.tabs.filter(t => t.pinned).length;
    console.log(`[${tc.id}] Pinned: ${beforePinned} → ${afterPinned}`);
  }

  if (expected === 'bookmark_tabs') {
    console.log(`[${tc.id}] Bookmark result:`, result.message);
  }

  if (expected === 'mute_tabs') {
    console.log(`[${tc.id}] Mute result:`, result.message);
  }

  if (expected === 'reload_tabs') {
    console.log(`[${tc.id}] Reload result:`, result.message);
  }

  if (expected === 'snooze_tabs') {
    console.log(`[${tc.id}] Snooze result:`, result.message);
  }
}

function generateSyntheticDocs(count) {
  const topics = [
    { title: 'Cat', text: 'Cats are small carnivorous mammals. They are often kept as pets.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Cat' },
    { title: 'Dog', text: 'Dogs are domesticated mammals and popular pets.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Dog' },
    { title: 'Bird', text: 'Birds are warm-blooded vertebrates with feathers and wings.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Bird' },
    { title: 'Python', text: 'Python is a high-level programming language known for readability.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Python' },
    { title: 'JavaScript', text: 'JavaScript is a programming language for the web.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/JavaScript' },
    { title: 'Music', text: 'Music is an art form combining sound and silence.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Music' },
    { title: 'Space', text: 'Space exploration uses astronomy and spacecraft.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Space_exploration' },
    { title: 'Astronomy', text: 'Astronomy studies celestial objects and phenomena.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Astronomy' },
    { title: 'Geography', text: 'Geography studies Earth landscapes and environments.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Geography' },
    { title: 'Television', text: 'Television broadcasts audio visual content to viewers.', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Television' },
  ];

  const docs = [];
  for (let i = 0; i < count; i++) {
    const t = topics[i % topics.length];
    docs.push({
      url: `${t.url}_${i}`,
      title: `${t.title} ${i}`,
      text: `${t.text} Additional content for diversity.`,
      domain: t.domain,
      timestamp: Date.now(),
      categories: ['web'],
      embedding: null,
    });
  }
  return docs;
}
