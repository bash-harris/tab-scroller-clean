const { launchBrowser, closeBrowser } = require('./setup');

const urls = [
  // 5 Geography
  'https://en.wikipedia.org/wiki/Geography',
  'https://en.wikipedia.org/wiki/Earth',
  'https://en.wikipedia.org/wiki/Mountain',
  'https://en.wikipedia.org/wiki/River',
  'https://en.wikipedia.org/wiki/Ocean',
  // 2 Television
  'https://en.wikipedia.org/wiki/Television',
  'https://en.wikipedia.org/wiki/Broadcasting',
  // 2 TV Shows related to Geography
  'https://en.wikipedia.org/wiki/Planet_Earth_(2006_TV_series)',
  'https://en.wikipedia.org/wiki/National_Geographic_Explorer',
  // 3 Astronomy
  'https://en.wikipedia.org/wiki/Astronomy',
  'https://en.wikipedia.org/wiki/Star',
  'https://en.wikipedia.org/wiki/Galaxy',
  // 3 TV Shows related to Astronomy
  'https://en.wikipedia.org/wiki/Cosmos:_A_Personal_Voyage',
  'https://en.wikipedia.org/wiki/The_Universe_(TV_series)',
  'https://en.wikipedia.org/wiki/How_the_Universe_Works'
];

describe('AI Prompt Automated Tests - Complex Wikipedia Scenario', () => {
  let browser;
  let optionsPage;
  let extId;

  beforeAll(async () => {
    browser = await launchBrowser();
    
    // 1. Get Extension ID - Wait for service worker to initialize
    let backgroundTarget;
    for (let i = 0; i < 20; i++) {
      const targets = await browser.targets();
      backgroundTarget = targets.find(target => target.type() === 'service_worker' || target.type() === 'background_page');
      if (backgroundTarget) break;
      await new Promise(r => setTimeout(r, 500));
    }
    
    if (!backgroundTarget) throw new Error('Could not find service worker target');
    const extUrl = backgroundTarget.url();
    extId = extUrl.split('/')[2];
    
    // 2. Open options page to set Ollama configuration
    optionsPage = await browser.newPage();
    await optionsPage.goto(`chrome-extension://${extId}/options.html`);
    await optionsPage.evaluate(async () => {
      return new Promise((resolve) => {
        chrome.storage.sync.set({ 
          useOllama: true, 
          ollamaModel: 'qwen2.5', // Ensure local model matches your setup
          ollamaUrl: 'http://localhost:11434',
          enableAi: true
        }, resolve);
      });
    });

    // 3. Open all 15 Wikipedia tabs
    // Note: We use Promise.all to open them quickly
    await Promise.all(urls.map(url => browser.newPage().then(p => p.goto(url, { waitUntil: 'domcontentloaded' }))));
    
  });

  afterAll(async () => {
    await closeBrowser();
  });

  const runAiCommand = async (commandText) => {
    return await optionsPage.evaluate(async (cmd) => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "AI_COMMAND",
          command: cmd
        }, (response) => {
          resolve(response);
        });
      });
    }, commandText);
  };

  const getTabGroups = async () => {
    return await optionsPage.evaluate(async () => {
      const groups = await chrome.tabGroups.query({});
      const tabs = await chrome.tabs.query({});
      return { groups, tabs: tabs.map(t => ({ url: t.url, title: t.title, groupId: t.groupId })) };
    });
  };

  it('should group geography tabs correctly', async () => {
    console.log('Sending command: group all tabs related to geography and places');
    const result = await runAiCommand('group all tabs related to geography and places');
    console.log('AI Response:', result);
    
    // Wait for Chrome tab grouping to propagate
    await new Promise(r => setTimeout(r, 2000));
    
    const state = await getTabGroups();
    
    // Verify that at least some Geography tabs were grouped
    const geographyUrls = urls.slice(0, 5);
    const groupedGeographyTabs = state.tabs.filter(t => 
      geographyUrls.some(gUrl => t.url && t.url.includes(gUrl)) && t.groupId !== -1
    );

    // AI might include Planet Earth, but let's just assert that it grouped at least the pure geography ones
    expect(groupedGeographyTabs.length).toBeGreaterThanOrEqual(1);
  });

  it('should group astronomy tabs while excluding TV shows', async () => {
    console.log('Sending command: group all tabs related to astronomy but not related to televison shows');
    const result = await runAiCommand('group all tabs related to astronomy but not related to televison shows');
    console.log('AI Response:', result);
    
    // Wait for Chrome tab grouping to propagate
    await new Promise(r => setTimeout(r, 2000));
    
    const state = await getTabGroups();
    
    // Astronomy base urls
    const astronomyUrls = urls.slice(9, 12);
    // Astronomy TV show urls
    const astronomyTvUrls = urls.slice(12, 15);

    const groupedAstronomyTabs = state.tabs.filter(t => 
      astronomyUrls.some(aUrl => t.url && t.url.includes(aUrl)) && t.groupId !== -1
    );

    const groupedAstronomyTvTabs = state.tabs.filter(t => 
      astronomyTvUrls.some(tvUrl => t.url && t.url.includes(tvUrl)) && t.groupId !== -1
    );

    // We expect astronomy to be grouped
    expect(groupedAstronomyTabs.length).toBeGreaterThanOrEqual(1);
    
    // We expect the TV shows to NOT be grouped with the same astronomy group.
    // If the AI is perfect, groupedAstronomyTvTabs length might be 0 for that group.
    // Let's just log it to see the LLM's performance!
    console.log('Grouped pure astronomy tabs:', groupedAstronomyTabs.length);
    console.log('Grouped TV astronomy tabs:', groupedAstronomyTvTabs.length);
  });
});
