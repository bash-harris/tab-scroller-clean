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
  console.log('SW found');

  const worker = await swTarget.worker();
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

  // Configure Ollama
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

  // Test 1: Parse a command via parseAiCommand in the SW context
  console.log('\n--- Test 1: parseAiCommand ---');
  const parseResult = await worker.evaluate(async (cmd) => {
    try {
      const windows = await chrome.windows.getLastFocused();
      const response = await parseAiCommand(cmd, windows.id);
      return JSON.stringify(response || { error: 'no response' });
    } catch (e) {
      return JSON.stringify({ error: e.message, stack: e.stack?.substring(0, 300) });
    }
  }, 'list all tabs as json');
  console.log('Parse result:', parseResult);

  // Test 2: Full AI_COMMAND execution via the handler function (simulated)
  console.log('\n--- Test 2: Full AI_COMMAND simulation ---');
  const execResult = await worker.evaluate(async (cmd) => {
    try {
      const windows = await chrome.windows.getLastFocused();
      const response = await parseAiCommand(cmd, windows.id);
      if (!response || !response.functionCall) {
        return JSON.stringify({ success: false, message: response?.text || 'no function call' });
      }
      const toolResult = await executeToolCall(response.functionCall, windows.id);
      return JSON.stringify(toolResult);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }, 'list all tabs as json');
  console.log('Exec result:', execResult);

  // Test 3: Use execDirectAiCommand if it exists
  console.log('\n--- Test 3: execDirectAiCommand ---');
  const directResult = await worker.evaluate(async (cmd) => {
    try {
      if (typeof execDirectAiCommand === 'function') {
        const result = await execDirectAiCommand(cmd);
        return JSON.stringify(result || { error: 'no result' });
      }
      return JSON.stringify({ error: 'execDirectAiCommand not found' });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }, 'list all tabs as json');
  console.log('Direct result:', directResult);

  // Test 4: Get last focused window
  console.log('\n--- Test 4: Window info ---');
  const winResult = await worker.evaluate(async () => {
    try {
      const windows = await chrome.windows.getLastFocused();
      return JSON.stringify({ id: windows.id, type: windows.type, state: windows.state });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  });
  console.log('Window:', winResult);

  clearInterval(keepAlive);
  await browser.close();
})().catch(e => console.error(e));
