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

  // Find SW immediately and attach before it stops
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  console.log('SW found:', swTarget.url());

  // IMMEDIATELY get the worker
  const worker = await swTarget.worker().catch(e => {
    console.log('Initial worker() failed:', e.message);
    return null;
  });

  if (!worker) {
    console.log('Could not get worker. Trying retry loop...');
    
    // Try multiple times: wait for the target to appear again
    for (let i = 0; i < 10; i++) {
      try {
        const swTarget2 = await browser.waitForTarget(
          t => t.type() === 'service_worker',
          { timeout: 5000 }
        );
        const w = await swTarget2.worker().catch(() => null);
        if (w) {
          console.log('Got worker on retry', i);
          // Use it
          const result = await w.evaluate(() => chrome.runtime.id);
          console.log('Result:', result);
          break;
        }
      } catch (e) {
        console.log('Retry', i, 'failed:', e.message);
      }
    }
    await browser.close();
    return;
  }

  // Got the worker! Now keep it alive by evaluating
  const result = await worker.evaluate(() => chrome.runtime.id);
  console.log('Worker alive, runtime ID:', result);

  // Try more operations
  const tabCount = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.length;
  });
  console.log('Tab count:', tabCount);

  // Get extension ID
  const extId = await worker.evaluate(() => chrome.runtime.id);
  console.log('Extension ID:', extId);

  // Open options page
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 1000));

  // Configure Ollama via the worker
  await worker.evaluate(async () => {
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
  console.log('Ollama configured');

  // Open a real page (about:blank with content?)
  const realPage = await browser.newPage();
  await realPage.goto('data:text/html,<html><body>test page</body></html>');

  // Now try an AI command via the direct CDP path (in worker context)
  const aiResult = await worker.evaluate(async (cmd) => {
    try {
      const [window] = await chrome.windows.getAll({ populate: false });
      const response = await parseAiCommand(cmd, window.id);
      if (!response || !response.functionCall) {
        return JSON.stringify({ success: false, message: response?.text || 'no function call' });
      }
      const execResult = await executeToolCall(response.functionCall, window.id);
      return JSON.stringify(execResult);
    } catch (e) {
      return JSON.stringify({ success: false, message: e.message });
    }
  }, 'group all tabs');
  console.log('AI result:', aiResult);

  // Try the full AI_COMMAND pipeline
  // Send AI_COMMAND via chrome.scripting.executeScript from the worker
  const fullResult = await worker.evaluate(async (cmd) => {
    try {
      const tabs = await chrome.tabs.query({});
      const realTab = tabs.find(t =>
        t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('data:')
      );
      if (!realTab) {
        // Use any available tab
        const anyTab = tabs.find(t => t.id);
        if (!anyTab) return JSON.stringify({ success: false, message: 'no tabs' });
        
        const scriptResult = await chrome.scripting.executeScript({
          target: { tabId: anyTab.id },
          func: (command) => {
            return new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: "AI_COMMAND", command }, (response) => {
                resolve(response);
              });
            });
          },
          args: [cmd],
        });
        return JSON.stringify(scriptResult[0]?.result || { success: false, message: 'no result' });
      }
      
      const scriptResult = await chrome.scripting.executeScript({
        target: { tabId: realTab.id },
        func: (command) => {
          return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "AI_COMMAND", command }, (response) => {
              resolve(response);
            });
          });
        },
        args: [cmd],
      });
      return JSON.stringify(scriptResult[0]?.result || { success: false, message: 'no result' });
    } catch (e) {
      return JSON.stringify({ success: false, message: e.message });
    }
  }, 'group all tabs');
  console.log('Full pipeline result:', fullResult);

  await browser.close();
})().catch(e => console.error(e));
