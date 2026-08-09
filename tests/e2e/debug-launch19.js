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

  // Open options page
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Configure Ollama settings via options page (direct storage access)
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
  console.log('Settings configured via options page');

  // Open a REAL content page  
  const contentPage = await browser.newPage();
  await contentPage.goto('https://example.com');
  await new Promise(r => setTimeout(r, 3000));

  // Step 1: Test basic message round-trip (non-AI message)
  console.log('Testing basic message round-trip...');
  const basicResult = await optionsPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const realTab = tabs.find(t =>
      t.url && t.url.startsWith('http')
    );
    if (!realTab) return JSON.stringify({ error: 'no real tab' });

    const results = await chrome.scripting.executeScript({
      target: { tabId: realTab.id },
      func: () => {
        return new Promise((resolve) => {
          // Send PING message to test round-trip
          chrome.runtime.sendMessage({ type: "PING" }, (response) => {
            resolve(response);
          });
        });
      },
    });
    
    return JSON.stringify(results[0]?.result);
  });
  console.log('PING result:', basicResult);

  // Step 2: Test AI_COMMAND with execDirectAiCommand
  console.log('Testing AI_COMMAND with execDirectAiCommand...');
  const aiResult = await optionsPage.evaluate(async (cmd) => {
    const tabs = await chrome.tabs.query({});
    const realTab = tabs.find(t =>
      t.url && t.url.startsWith('http')
    );
    if (!realTab) return JSON.stringify({ error: 'no real tab' });

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
  }, 'list all tabs as json');
  console.log('AI result:', aiResult);

  // Step 3: If step 2 failed with PING, the message handler might not support PING
  // Try AI_COMMAND via execDirectAiCommand (if that was implemented)
  
  await browser.close();
})().catch(e => console.error(e));
