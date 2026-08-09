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

  // Try all known ways to find the service worker
  console.log('Method 1: browser.targets() with type filtering');
  let targets = await browser.targets();
  targets.forEach(t => console.log(' -', t.type(), t.url().slice(0, 120)));

  console.log('\nMethod 2: browser.waitForTarget');
  try {
    const sw = await browser.waitForTarget(
      t => t.type() === 'service_worker',
      { timeout: 10000 }
    );
    console.log('Found:', sw.url());
  } catch {
    console.log('Not found via waitForTarget');
  }

  console.log('\nMethod 3: Check all target types');
  const allTypes = ['service_worker', 'background_page', 'worker', 'shared_worker'];
  for (const type of allTypes) {
    try {
      const t = await browser.waitForTarget(t => t.type() === type, { timeout: 3000 });
      console.log('Found type=' + type + ':', t.url().slice(0, 120));
    } catch {
      console.log('No target of type=' + type);
    }
  }

  console.log('\nMethod 4: Navigate to an extension page to activate the SW');
  // Open any page, then navigate to chrome-extension://
  const page = await browser.newPage();
  await page.goto('https://example.com');
  
  // The extension content script should load. Then try to message the background
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage('nacdpobfhpkcimliaemdijaeleiaohha', { type: 'PING' }, (response) => {
        resolve(response || chrome.runtime.lastError?.message || 'no response');
      });
    });
  }).catch(e => 'Error: ' + e.message);
  console.log('Ping result:', result);

  // Now check targets again
  await new Promise(r => setTimeout(r, 3000));
  targets = await browser.targets();
  console.log('\nTargets after ping:');
  targets.forEach(t => console.log(' -', t.type(), t.url().slice(0, 120)));

  await browser.close();
})().catch(e => console.error(e));
