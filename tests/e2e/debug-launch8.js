const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  await new Promise(r => setTimeout(r, 3000));
  
  const targets = await browser.targets();
  console.log('Targets without extension:');
  for (const t of targets) {
    console.log(' -', t.type(), ':', t.url().substring(0, 150));
  }

  // Try to list all service worker registrations
  const pages = await browser.pages();
  try {
    const page = pages[0];
    await page.goto('chrome://serviceworker-internals/');
    await new Promise(r => setTimeout(r, 3000));
    const content = await page.evaluate(() => document.body.innerText);
    console.log('Service worker internals:', content.substring(0, 1000));
  } catch (e) {
    console.log('SW internals error:', e.message);
  }

  await browser.close();
})().catch(e => console.error(e));
