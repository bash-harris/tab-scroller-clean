const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');

(async () => {
  console.log('Extension path:', EXTENSION_PATH);
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=800,600',
    ],
  });

  console.log('Chrome launched');
  await new Promise(r => setTimeout(r, 10000));

  const targets = await browser.targets();
  console.log('Targets:', targets.length);
  targets.forEach((t, i) => {
    console.log(i + ':', t.type(), t.url().substring(0, 140));
  });

  const bgTarget = targets.find(t => t.type() === 'service_worker' || t.type() === 'background_page');
  console.log('Service worker target found:', !!bgTarget);

  if (bgTarget) {
    console.log('BG URL:', bgTarget.url());
    const cdp = await bgTarget.createCDPSession();
    const version = await cdp.send('Runtime.evaluate', {
      expression: 'typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.id : "nope"',
      returnByValue: true,
    });
    console.log('Extension runtime:', version.result.value);
    await cdp.detach();
  }

  await browser.close();
  console.log('Done');
})().catch(e => console.error('Error:', e));
