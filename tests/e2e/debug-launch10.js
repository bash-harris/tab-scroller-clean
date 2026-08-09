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

  // Find service worker via waitForTarget
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 15000 }
  );
  console.log('SW target found:');
  console.log('  type:', swTarget.type());
  console.log('  url:', swTarget.url());

  // Use the worker's worker() method which returns a WebWorker if available
  // Or try creating session via the worker target
  
  // Try: get the target's target ID and use CDP directly
  const targetInfo = await swTarget.targetInfo();
  console.log('  targetInfo.id:', targetInfo.targetId);
  
  // Create CDP session directly from the browser, not the target
  const browserCdp = await browser.createCDPSession();
  
  // Try attaching to the worker via Target.attachToTarget
  try {
    const attachResult = await browserCdp.send('Target.attachToTarget', {
      targetId: targetInfo.targetId,
      flatten: true,
    });
    console.log('Attach result:', JSON.stringify(attachResult));
  } catch (e) {
    console.log('Attach failed:', e.message);
  }

  // Try evaluating in the worker
  try {
    const evalResult = await browserCdp.send('Runtime.evaluate', {
      expression: 'typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.id : "nope"',
      uniqueContextId: targetInfo.targetId,
      awaitPromise: false,
      returnByValue: true,
    });
    console.log('Eval result:', JSON.stringify(evalResult));
  } catch (e) {
    console.log('Eval failed:', e.message);
  }

  // Try using ServiceWorker domain
  try {
    const swInfos = await browserCdp.send('ServiceWorker.workerRegistrationUpdated', () => {});
    console.log('SW updated:', JSON.stringify(swInfos));
  } catch (e) {
    console.log('SW domain error:', e.message);
  }
  
  // Get all workers
  try {
    const workers = await browserCdp.send('ServiceWorker.deliverPushMessage', {});
    console.log('Workers:', JSON.stringify(workers));
  } catch (e) {
    console.log('Failed:', e.message);
  }

  // Try a simpler approach: get all targets by CDP
  const allTargets = await browserCdp.send('Target.getTargets', {});
  console.log('\nAll CDP targets:');
  (allTargets.targetInfos || []).forEach(t => {
    console.log('  type:', t.type, 'id:', t.targetId, 'url:', (t.url || '').substring(0, 100));
  });

  await browserCdp.detach();

  // Now try another approach: directly create a session on a page, then eval on the worker
  const pages = await browser.pages();
  const page = pages[0];
  const pageCdp = await page.createCDPSession();
  
  // Try to discover workers from the page's CDP session
  try {
    const result = await pageCdp.send('Page.getResourceTree', {});
    console.log('\nResource tree:', JSON.stringify(result).substring(0, 300));
  } catch (e) {
    console.log('Resource tree error:', e.message);
  }

  await pageCdp.detach();
  await browser.close();
})().catch(e => console.error(e));
