const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './.puppeteer_user_data_worker',
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
    ],
  });

  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension ID:', extId);

  const worker = await swTarget.worker();
  console.log('Worker attached. Listening to console...');

  worker.on('console', msg => {
    console.log(`[Worker Console] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });

  // Open a dummy page so we have at least one tab
  const page = await browser.newPage();
  await page.goto('https://en.wikipedia.org/wiki/Cat');
  console.log('Dummy page loaded.');

  // Open options page to set up settings
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await optionsPage.evaluate(async () => {
    await new Promise(resolve => {
      chrome.storage.sync.set({
        useOllama: true,
        ollamaModel: 'qwen2.5:latest',
        ollamaUrl: 'http://localhost:11434',
        ollamaTimeout: 120000,
        enableAi: true,
        fallbackToOllama: true,
      }, resolve);
    });
  });
  console.log('Settings configured.');

  // Now, let's run the pipeline inside the service worker directly
  console.log('Inspecting worker global scope...');
  const scopeInfo = await worker.evaluate(() => {
    return JSON.stringify({
      selfEmbed: typeof self.Embed,
      selfTabDB: typeof self.TabDB,
      selfTransformers: typeof self.transformers,
      keys: Object.keys(self).filter(k => ['Embed', 'TabDB', 'transformers', 'runCommandPipeline', 'classifyCommand'].includes(k))
    });
  });
  console.log('Worker scope:', JSON.parse(scopeInfo));

  console.log('Running pipeline in worker...');
  try {
    const resultJson = await worker.evaluate(async () => {
      try {
        const [currentWindow] = await chrome.windows.getAll({ populate: false });
        const windowId = currentWindow.id;
        const response = await self.runCommandPipeline('group all tabs related to cats', windowId);
        return JSON.stringify(response);
      } catch (e) {
        return JSON.stringify({ error: e.message, stack: e.stack });
      }
    });
    console.log('Pipeline Result:', JSON.parse(resultJson));
  } catch (e) {
    console.error('Worker evaluation crashed:', e);
  }

  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
  console.log('Done');
})().catch(e => console.error('Error:', e));
