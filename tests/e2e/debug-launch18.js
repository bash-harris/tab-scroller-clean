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

  // Find SW target to get extension ID
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension ID:', extId);

  // Open options page
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Open a REAL content page for executeScript target
  const contentPage = await browser.newPage();
  await contentPage.goto('https://example.com');
  await new Promise(r => setTimeout(r, 3000));

  // Test if options page can use chrome.scripting.executeScript
  const testResult = await optionsPage.evaluate(async () => {
    try {
      // Check if scripting API is available
      if (!chrome.scripting) return JSON.stringify({ error: 'chrome.scripting not available' });
      
      const tabs = await chrome.tabs.query({});
      const realTab = tabs.find(t =>
        t.url && t.url.startsWith('http') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
      );
      
      if (!realTab) return JSON.stringify({ error: 'No real tab', allTabs: tabs.map(t => ({id: t.id, url: t.url})) });

      const results = await chrome.scripting.executeScript({
        target: { tabId: realTab.id },
        func: () => {
          return {
            hasChrome: typeof chrome !== 'undefined',
            hasSendMessage: typeof chrome.runtime?.sendMessage !== 'undefined',
            location: window.location.href,
          };
        },
      });
      
      return JSON.stringify(results);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  });
  
  console.log('Options page executeScript test:');
  console.log(JSON.parse(testResult));

  // If that works, try the AI_COMMAND pipeline
  if (JSON.parse(testResult).error) {
    console.log('Cannot use options page for executeScript, trying alternative');
  } else {
    console.log('Options page CAN use chrome.scripting.executeScript!');
    
    // Now try the full AI_COMMAND pipeline via the content script
    const fullResult = await optionsPage.evaluate(async (cmd) => {
      try {
        const tabs = await chrome.tabs.query({});
        const realTab = tabs.find(t =>
          t.url && t.url.startsWith('http') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
        );
        
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
      } catch (e) {
        return JSON.stringify({ success: false, message: e.message });
      }
    }, 'group all tabs');
    
    console.log('Full pipeline result:', JSON.parse(fullResult));
  }

  await browser.close();
})().catch(e => console.error(e));
