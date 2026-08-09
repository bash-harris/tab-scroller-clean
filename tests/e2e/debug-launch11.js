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

  // Wait for service worker
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 15000 }
  );
  console.log('SW target:', swTarget.url());

  // Get all target IDs via browser CDP
  const browserCdp = await browser.createCDPSession();
  const targetsResp = await browserCdp.send('Target.getTargets', {});
  const swInfo = targetsResp.targetInfos.find(t => t.type === 'service_worker');
  
  console.log('Found SW targetInfo:', JSON.stringify(swInfo));

  if (swInfo) {
    // Attach to the service worker
    const attachResult = await browserCdp.send('Target.attachToTarget', {
      targetId: swInfo.targetId,
      flatten: true,
    });
    console.log('Attach result keys:', Object.keys(attachResult));

    // Now we should have a session for the worker
    // The session ID is in attachResult.sessionId
    if (attachResult.sessionId) {
      // Evaluate in the worker via the original CDP session but with the worker's session
      // Actually, we need to create a session from the target
      console.log('Got session ID:', attachResult.sessionId);
    }
  }

  // Alternative: use a page CDP session to evaluate on the worker
  // Or just use the service_worker target directly as the page
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${swInfo ? swInfo.url.split('/')[2] : 'unknown'}/options.html`);
  console.log('Options page loaded');
  
  // Try evaluating in the page
  const result = await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ id: t.id, url: t.url }));
  });
  console.log('Tabs:', JSON.stringify(result).substring(0, 500));

  await browser.close();
})().catch(e => console.error(e));
