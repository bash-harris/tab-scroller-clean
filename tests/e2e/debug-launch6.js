const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  console.log('EXTENSION_PATH:', EXTENSION_PATH);

  const browser = await puppeteer.launch({
    headless: false,
    dumpio: true,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
    ],
  });

  // Wait for browser to settle
  await new Promise(r => setTimeout(r, 3000));

  const pages = await browser.pages();
  const page = pages[0];
  
  // Navigate to the extension's options page directly
  // First, let's find the extension ID from targets
  const targets = await browser.targets();
  
  // Try to go to a known extension page path 
  // The extension ID can be found from chrome://extensions
  await page.goto('chrome://extensions', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  
  // Now check if any extension-related pages appeared
  const targets2 = await browser.targets();
  console.log('Targets after navigating to chrome://extensions:');
  for (const t of targets2) {
    console.log(' -', t.type(), ':', t.url().substring(0, 150));
  }

  // Try getting extension IDs via extensions API if available
  try {
    const result = await page.evaluate(() => {
      // Try to find extension elements
      return document.body.innerText.substring(0, 1000);
    });
    console.log('Extensions page content:', result);
  } catch (e) {
    console.log('Could not get extensions content:', e.message);
  }

  // Wait a bit more for service workers
  await new Promise(r => setTimeout(r, 5000));

  const targets3 = await browser.targets();
  const swTarget = targets3.find(t => t.type() === 'service_worker');
  if (swTarget) {
    console.log('Service worker target found!');
    console.log('URL:', swTarget.url());
  } else {
    console.log('No service worker target found');
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
