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
    ],
  });

  // Listen for NEW service worker targets and attach immediately
  let worker;

  browser.on('targetcreated', async (target) => {
    if (target.type() === 'service_worker') {
      console.log('SW target created!');
      try {
        worker = await target.worker();
        console.log('Worker attached successfully');
      } catch (e) {
        console.log('worker() failed:', e.message);
      }
    }
  });

  // Wait for the extension to load (up to 20 seconds)
  await new Promise(r => setTimeout(r, 3000));

  // Open options page to trigger the extension
  // First, try to find the extension ID from any available source
  const targets = await browser.targets();
  let extId = null;
  
  // Navigate to about:blank and check for extension
  const page = await browser.newPage();
  try {
    // The extension might have injected something
    await page.goto('https://example.com');
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    console.log('Navigation error:', e.message);
  }

  // Get extension ID from the service worker we (hopefully) attached to
  if (worker) {
    extId = await worker.evaluate(() => chrome.runtime.id);
    console.log('Ext ID from worker:', extId);
  } else {
    console.log('No worker attached yet, trying to trigger SW creation');
    // Navigate to a page that will trigger content script, which sends messages to SW
    // This should cause the SW to start
  }

  console.log('Worker available:', !!worker);
  
  if (worker) {
    // Worker is available! Let's rock.
    const tabs = await worker.evaluate(async () => {
      const allTabs = await chrome.tabs.query({});
      return allTabs.map(t => ({ id: t.id, url: t.url?.substring(0, 80) }));
    });
    console.log('Tabs:', JSON.stringify(tabs));

    const tabsInfo = await worker.evaluate(async () => {
      const allTabs = await chrome.tabs.query({});
      return JSON.stringify(allTabs.map(t => ({ id: t.id, url: t.url })));
    });
    console.log('All tabs:', tabsInfo);
  }

  await browser.close();
})().catch(e => console.error(e));
