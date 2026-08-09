const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve('C:\\Users\\bkh\\Desktop\\tab scroller');

(async () => {
  console.log('EXTENSION_PATH:', EXTENSION_PATH);
  const exists = require('fs').existsSync(EXTENSION_PATH + '\\manifest.json');
  console.log('manifest.json exists:', exists);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
    ],
  });

  for (let i = 0; i < 60; i++) {
    const targets = await browser.targets();
    const bg = targets.find(t => t.type() === 'service_worker' || t.type() === 'background_page');
    if (bg) {
      console.log('Found at iteration', i);
      console.log('URL:', bg.url());
      const ver = await bg.targetInfo();
      console.log('Target info:', JSON.stringify(ver));
      await browser.close();
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Not found');
  
  // Check if there are any extension targets at all
  const targets = await browser.targets();
  for (const t of targets) {
    console.log('Target:', t.type(), t.url().substring(0, 150));
  }

  await browser.close();
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
