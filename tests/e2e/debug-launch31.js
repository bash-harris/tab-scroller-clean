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

  // Keep SW alive
  const keepAlive = setInterval(() => {
    worker.evaluate(() => chrome.runtime.id).catch(() => {});
  }, 1000);

  // Configure Ollama settings from within the WORKER context
  await worker.evaluate(async () => {
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
  console.log('Settings set from worker');

  // Get a window ID
  const windowInfo = await worker.evaluate(async () => {
    const windows = await chrome.windows.getLastFocused();
    return { id: windows.id, tabs: await chrome.tabs.query({ windowId: windows.id }) };
  });
  console.log('Window:', windowInfo.id, 'with', windowInfo.tabs.length, 'tabs');

  // Test 1: parseAiCommand via worker
  console.log('\n--- Test 1: parseAiCommand ---');
  const parseResult = await worker.evaluate(async (cmd, winId) => {
    try {
      const response = await parseAiCommand(cmd, winId);
      return JSON.stringify(response || { error: 'no response' });
    } catch (e) {
      return JSON.stringify({ error: e.message, stack: e.stack?.substring(0, 200) });
    }
  }, 'group all tabs', windowInfo.id);
  console.log('Parse result:', parseResult.substring(0, 500));

  // If parseAiCommand worked, test executeToolCall
  const parsed = JSON.parse(parseResult);
  if (parsed.type === 'function' && parsed.functionCall) {
    console.log('\n--- Test 2: executeToolCall ---');
    const execResult = await worker.evaluate(async (fc, winId) => {
      try {
        const result = await executeToolCall(fc, winId);
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }, parsed.functionCall, windowInfo.id);
    console.log('Exec result:', execResult.substring(0, 500));
  } else if (parsed.success !== undefined) {
    console.log('\nCommand returned:', parsed);
  }

  clearInterval(keepAlive);
  await browser.close();
})().catch(e => console.error(e));
