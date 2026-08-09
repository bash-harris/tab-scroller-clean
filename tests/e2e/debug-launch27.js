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
      '--disable-features=ServiceWorkerTerminationOnIdle',
      '--enable-features=ServiceWorkerImmediateStart',
      '--service-worker-idle-timeout-in-seconds=999999',
    ],
  });

  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 30000 }
  );

  const worker = await swTarget.worker();

  // Wait for SW to fully initialize (all let/const declarations done)
  await worker.evaluate(async () => {
    while (true) {
      try {
        const x = KEYWORD_EXTRACTION_TOP_N;
        break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 50));
      }
    }
  });
  console.log('SW fully initialized');

  const extId = await worker.evaluate(() => chrome.runtime.id);
  console.log('Ext ID:', extId);

  // Keep SW alive
  const keepAlive = setInterval(() => {
    worker.evaluate(() => chrome.runtime.id).catch(() => {});
  }, 2000);

  // Open pages
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await new Promise(r => setTimeout(r, 3000));

  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Configure settings
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
  console.log('Settings set');

  // Parse a command
  console.log('\n--- Test: parseAiCommand ---');
  const parseResult = await worker.evaluate(async (cmd) => {
    try {
      const windows = await chrome.windows.getLastFocused();
      const response = await parseAiCommand(cmd, windows.id);
      return JSON.stringify(response || { error: 'no response' });
    } catch (e) {
      return JSON.stringify({ error: e.message, stack: e.stack?.substring(0, 300) });
    }
  }, 'list all tabs as json');
  console.log('Parse result:', parseResult.substring(0, 500));

  // Execute the tool call
  const parsed = JSON.parse(parseResult);
  if (parsed.type === 'function' && parsed.functionCall) {
    console.log('\n--- Test: executeToolCall ---');
    const execResult = await worker.evaluate(async (fc) => {
      try {
        const windows = await chrome.windows.getLastFocused();
        const result = await executeToolCall(fc, windows.id);
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }, parsed.functionCall);
    console.log('Exec result:', execResult.substring(0, 500));
  }

  clearInterval(keepAlive);
  await browser.close();
})().catch(e => console.error(e));
