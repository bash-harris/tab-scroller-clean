const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');
console.log('__dirname:', __dirname);
console.log('EXTENSION_PATH resolved:', EXTENSION_PATH);

const puppeteer = require('puppeteer');
(async () => {
  console.log('Launching...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
      '--no-first-run',
    ],
  });
  console.log('Launched. Waiting for service worker...');

  for (let i = 0; i < 60; i++) {
    const targets = await browser.targets();
    for (const t of targets) {
      if (t.type() !== 'browser') {
        console.log('Iteration', i, ':', t.type(), t.url().substring(0, 120));
      }
    }
    const bgTarget = targets.find(t => t.type() === 'service_worker');
    if (bgTarget) {
      console.log('Service worker found:', bgTarget.url());
      await browser.close();
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Service worker not found');
  await browser.close();
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
