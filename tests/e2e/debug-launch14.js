const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--disable-background-timer-throttling',
      '--window-size=1400,900',
    ],
  });

  // Get extension ID from the service worker target
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extUrl = swTarget.url();
  const extId = extUrl.split('/')[2];
  console.log('Extension ID:', extId);

  // Open the options page (keeps the SW alive since it's an extension page)
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await new Promise(r => setTimeout(r, 2000));

  // Now try to find and attach to the SW again — it should be alive
  // Use browser's own target for CDP
  const bTarget = browser.target();
  const cdp = await bTarget.createCDPSession();

  const targetsResp = await cdp.send('Target.getTargets', {});
  const swInfo = (targetsResp.targetInfos || []).find(t => t.type === 'service_worker');
  
  if (!swInfo) {
    console.log('No SW target in CDP list');
    // Check what we do have
    for (const t of targetsResp.targetInfos) {
      console.log('  -', t.type, t.url?.substring(0, 80));
    }
    await cdp.detach();
    await browser.close();
    return;
  }

  console.log('SW targetId:', swInfo.targetId);
  
  // Try to use Puppeteer's WorkerTarget.worker() immediately after opening options page
  const swTarget2 = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 5000 });
  
  // Try multiple times to get the worker
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const worker = await swTarget2.worker();
      console.log('Worker obtained on attempt', attempt);
      
      // Now evaluate using the worker
      const extIdFromWorker = await worker.evaluate(() => chrome.runtime.id);
      console.log('Extension ID from worker:', extIdFromWorker);
      
      // Call a script injection via the worker
      const result = await worker.evaluate(async (cmd) => {
        // Find a real page tab
        const pages = await chrome.tabs.query({});
        const realTab = pages.find(t => t.url && !t.url.startsWith('chrome-extension://'));
        if (!realTab) throw new Error('No real tab found');
        
        const scriptResult = await chrome.scripting.executeScript({
          target: { tabId: realTab.id },
          func: (command) => {
            return new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: 'AI_COMMAND', command }, (response) => {
                resolve(response);
              });
            });
          },
          args: [cmd],
        });
        return scriptResult[0]?.result;
      }, 'group tabs about cats');
      
      console.log('AI_COMMAND result:', JSON.stringify(result));
      break;
    } catch (e) {
      console.log('Attempt', attempt, 'failed:', e.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await cdp.detach();
  await browser.close();
})().catch(e => console.error(e));
