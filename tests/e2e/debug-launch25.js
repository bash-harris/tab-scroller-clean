const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Make service worker stay alive
      '--disable-features=ServiceWorkerTerminationOnIdle',
      '--enable-features=ServiceWorkerImmediateStart',
      // Increase idle time for service workers (seconds)
      '--service-worker-idle-timeout-in-seconds=999999',
    ],
  });

  // Find the SW target with generous timeout
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 30000 }
  );
  console.log('SW target found:', swTarget.url());

  // Try to attach immediately
  try {
    const worker = await swTarget.worker();
    console.log('Worker obtained:', !!worker);
    
    // Evaluate in the worker
    const extId = await worker.evaluate(() => chrome.runtime.id);
    console.log('Extension ID:', extId);
    
    // Now that we have the worker, keep it alive by sending periodic pings
    const keepAlive = setInterval(async () => {
      try {
        await worker.evaluate(() => chrome.runtime.id);
      } catch (e) {
        console.log('Keep-alive failed, SW may have stopped');
        clearInterval(keepAlive);
      }
    }, 1000);

    // Open content page
    const page = await browser.newPage();
    await page.goto('https://example.com');
    await new Promise(r => setTimeout(r, 3000));
    
    // Configure settings
    const optionsPage = await browser.newPage();
    await optionsPage.goto(`chrome-extension://${extId}/options.html`);
    await new Promise(r => setTimeout(r, 2000));

    await optionsPage.evaluate(async () => {
      await new Promise(resolve => {
        chrome.storage.sync.set({
          useOllama: true,
          ollamaModel: 'qwen2.5:latest',
          ollamaUrl: 'http://localhost:11434',
          ollamaTimeout: 90000,
          enableAi: true,
          fallbackToOllama: true,
        }, resolve);
      });
    });
    console.log('Settings configured');

    // Find the service worker's CDP session and use it to evaluate
    // Actually, we already have the `worker` object - use it directly!
    
    // Get current tabs via the worker
    const tabs = await worker.evaluate(async () => {
      const allTabs = await chrome.tabs.query({});
      return allTabs.map(t => ({ id: t.id, url: t.url?.substring(0, 60) }));
    });
    console.log('Current tabs:', JSON.stringify(tabs));

    // Now try sending AI_COMMAND via the worker to simulate content script
    const windowId = tabs.length > 0 ? tabs[0].id : undefined;

    // Try calling parseAiCommand directly from the worker
    const parseResult = await worker.evaluate(async (cmd) => {
      try {
        const [window] = await chrome.windows.getLastFocused();
        const response = await parseAiCommand(cmd, window.id);
        return JSON.stringify(response || { error: 'no response' });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }, 'list all tabs as json');
    console.log('Parse result:', parseResult);

    clearInterval(keepAlive);
  } catch (e) {
    console.log('Error:', e.message);
  }

  await browser.close();
})().catch(e => console.error(e));
