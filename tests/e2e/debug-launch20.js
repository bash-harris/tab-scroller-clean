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

  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension ID:', extId);

  // Open content page first (content.js auto-injects on <all_urls>)
  const contentPage = await browser.newPage();
  await contentPage.goto('https://example.com');
  await new Promise(r => setTimeout(r, 3000));

  // Open options page
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Configure Ollama settings
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

  // Test message round-trip via executeScript with a HANDLED message type
  console.log('Testing SESSION_GET_ACTIVE round-trip...');
  const basicResult = await optionsPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const realTab = tabs.find(t => t.url && t.url.startsWith('http'));
    if (!realTab) return JSON.stringify({ error: 'no http tab', allTabs: tabs.map(t => t.url) });

    const results = await chrome.scripting.executeScript({
      target: { tabId: realTab.id },
      func: () => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "SESSION_GET_ACTIVE" }, (response) => {
            resolve(response);
          });
        });
      },
    });
    return JSON.stringify(results[0]?.result);
  });
  console.log('Round-trip result:', basicResult);

  // Now test AI_COMMAND
  console.log('Testing AI_COMMAND...');
  const aiResult = await optionsPage.evaluate(async (cmd) => {
    const tabs = await chrome.tabs.query({});
    const realTab = tabs.find(t => t.url && t.url.startsWith('http'));
    if (!realTab) return JSON.stringify({ error: 'no http tab' });

    const results = await chrome.scripting.executeScript({
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
    return JSON.stringify(results[0]?.result || { success: false, message: 'no result' });
  }, 'group all tabs');
  console.log('AI result:', aiResult);

  await browser.close();
})().catch(e => console.error(e));
