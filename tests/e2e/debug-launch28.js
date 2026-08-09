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
    ],
  });

  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 30000 }
  );

  const worker = await swTarget.worker();
  console.log('Worker obtained');

  // Keep SW alive by sending periodic eval
  const keepAlive = setInterval(() => {
    worker.evaluate(() => 1+1).catch(() => {});
  }, 1000);

  // Test TDZ: try to access KEYWORD_EXTRACTION_TOP_N with retries
  let initOk = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await worker.evaluate(() => KEYWORD_EXTRACTION_TOP_N);
      initOk = true;
      break;
    } catch (e) {
      if (attempt === 0) console.log('TDZ detected, waiting for init...');
      await new Promise(r => setTimeout(r, 100));
    }
  }
  console.log('Init OK:', initOk);

  const extId = await worker.evaluate(() => chrome.runtime.id);
  console.log('Ext ID:', extId);

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

  // Parse a command with retry for TDZ
  const parseResult = await worker.evaluate(async (cmd) => {
    try {
      const windows = await chrome.windows.getLastFocused();
      const response = await parseAiCommand(cmd, windows.id);
      return JSON.stringify(response || { error: 'no response' });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }, 'list all tabs as json');
  console.log('Parse result:', parseResult.substring(0, 500));

  // If parseResult shows TDZ error, try once more
  if (parseResult.includes('Cannot access')) {
    await new Promise(r => setTimeout(r, 1000));
    const parseResult2 = await worker.evaluate(async (cmd) => {
      try {
        const windows = await chrome.windows.getLastFocused();
        const response = await parseAiCommand(cmd, windows.id);
        return JSON.stringify(response || { error: 'no response' });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }, 'list all tabs as json');
    console.log('Parse result (retry):', parseResult2.substring(0, 500));
  }

  clearInterval(keepAlive);
  await browser.close();
})().catch(e => console.error(e));
