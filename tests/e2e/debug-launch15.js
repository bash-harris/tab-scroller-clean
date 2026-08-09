const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--disable-background-timer-throttling',
      '--window-size=1400,900',
    ],
  });

  // Wait for SW
  let swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension ID:', extId);

  // Open options page
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Open a real web page for content script injection
  const realPage = await browser.newPage();
  await realPage.goto('about:blank');
  // about:blank won't work for content scripts, need a proper URL
  await realPage.goto('data:text/html,<html><body>test</body></html>');
  await new Promise(r => setTimeout(r, 2000));

  // Wait for SW again (should be alive now since we have extension pages)
  swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 5000 });

  // Configure Ollama settings first via options page
  await optionsPage.evaluate(async () => {
    await new Promise((resolve) => {
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
  console.log('Ollama settings configured');

  // Try to get the worker via Puppeteer
  try {
    const worker = await swTarget.worker();
    console.log('Got worker!');

    // Evaluate in the SW context
    const chromeId = await worker.evaluate(() => chrome.runtime.id);
    console.log('Chrome runtime ID:', chromeId);

    // Call parseAiCommand directly
    const result = await worker.evaluate(async (cmd) => {
      try {
        const [window] = await chrome.windows.getAll({ populate: false });
        const response = await parseAiCommand(cmd, window.id);
        if (!response || !response.functionCall) {
          return JSON.stringify({ success: false, message: response?.text || 'no response' });
        }
        const execResult = await executeToolCall(response.functionCall, window.id);
        return JSON.stringify(execResult);
      } catch (e) {
        return JSON.stringify({ success: false, message: e.message });
      }
    }, 'group tabs about cats');

    console.log('AI result:', result);
  } catch (e) {
    console.log('Worker error:', e.message);
  }

  await browser.close();
})().catch(e => console.error(e));
