const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  console.log('Extension path:', EXTENSION_PATH);
  console.log('Launching Chrome with various extension flags...');

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--load-extension=' + EXTENSION_PATH,
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--enable-automation',
      '--no-first-run',
      '--disable-default-apps',
      '--window-size=800,600',
    ],
  });

  await new Promise(r => setTimeout(r, 10000));

  const targets = await browser.targets();
  console.log('Targets:', targets.length);
  for (const t of targets) {
    console.log('-', t.type(), t.url().substring(0, 140));
  }

  // Try to access chrome://extensions page
  const page = await browser.newPage();
  try {
    await page.goto('chrome://inspect/#service-workers');
    const text = await page.evaluate(() => document.body.innerText);
    console.log('Chrome inspect:', text.substring(0, 500));
  } catch(e) {
    console.log('Could not open chrome://inspect:', e.message);
  }

  // Try to get extension info via CDP
  const session = await page.target().createCDPSession();
  const result = await session.send('Extensions.loadUnpacked', {
    path: EXTENSION_PATH,
  }).catch(e => ({ error: e.message }));
  console.log('Extensions.loadUnpacked result:', JSON.stringify(result));

  // Check available tabs
  const tabs = await session.send('SystemInfo.getInfo').catch(e => ({ error: e.message }));
  console.log('SystemInfo:', JSON.stringify(tabs).substring(0, 200));

  await browser.close();
})();
