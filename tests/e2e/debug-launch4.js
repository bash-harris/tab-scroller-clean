const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..');
const USER_DATA_DIR = path.join(os.tmpdir(), 'chrome-e2e-test-' + Date.now());

(async () => {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  console.log('Extension path:', EXTENSION_PATH);
  console.log('Temp user data:', USER_DATA_DIR);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
      '--no-first-run',
      '--user-data-dir=' + USER_DATA_DIR,
    ],
  });

  console.log('Chrome launched');

  for (let i = 0; i < 60; i++) {
    const targets = await browser.targets();
    const bgTarget = targets.find(t => t.type() === 'service_worker');
    if (bgTarget) {
      console.log('Service worker found at iteration', i);
      console.log('URL:', bgTarget.url());
      await browser.close();
      process.exit(0);
    }
    console.log(`Iteration ${i}: ${targets.length} targets`);
    for (const t of targets) {
      console.log('  -', t.type(), t.url().substring(0, 100));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Service worker NOT found');
  await browser.close();
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
