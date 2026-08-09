const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './.puppeteer_user_data',
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
    ],
  });

  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Ext ID:', extId);

  // Keep SW alive via CDP - CONNECT but don't evaluate
  const worker = await swTarget.worker();
  console.log('Worker attached');

  let keepAliveOk = true;
  const keepAlive = setInterval(() => {
    worker.evaluate(() => chrome.runtime.id)
      .catch(() => { keepAliveOk = false; });
  }, 500);

  // Open content page (for content script injection target)
  const contentPage = await browser.newPage();
  await contentPage.goto('https://example.com');
  await new Promise(r => setTimeout(r, 3000));

  // Open options page (to call executeScript)
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Configure Ollama settings via options page
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
  console.log('Settings saved');

  console.log('Keepalive OK:', keepAliveOk);

  // Send AI_COMMAND from content script injected via executeScript
  console.log('Sending AI_COMMAND via content script...');
  const aiResult = await optionsPage.evaluate(async (cmd) => {
    const tabs = await chrome.tabs.query({});
    const realTab = tabs.find(t => t.url && t.url.startsWith('http'));
    if (!realTab) return JSON.stringify({ error: 'no real tab', tabs: tabs.map(t => t.url) });

    const results = await chrome.scripting.executeScript({
      target: { tabId: realTab.id },
      world: 'ISOLATED',
      func: (command) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "AI_COMMAND", command }, (response) => {
            resolve(response);
          });
        });
      },
      args: [cmd],
    });
    return JSON.stringify(results[0]?.result || {});
  }, 'group all tabs');
  console.log('AI result:', aiResult);
  console.log('Keepalive OK after:', keepAliveOk);

  clearInterval(keepAlive);
  await browser.close();
})().catch(e => console.error(e));
