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

  // Find SW target
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 15000 }
  );
  console.log('SW target found');

  // Try accessing as worker via Puppeteer API
  try {
    // Wait a bit for the worker to be "ready"
    await new Promise(r => setTimeout(r, 1000));
    
    const worker = await swTarget.worker();
    console.log('Worker obtained:', !!worker);
    
    if (worker) {
      const result = await worker.evaluate(() => {
        return typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : 'no chrome';
      });
      console.log('Worker eval result:', result);
    }
  } catch (e) {
    console.log('Worker eval error:', e.message);
  }

  // Try creating CDPSession on a page first, then using Target.attachToTarget
  const pages = await browser.pages();
  const page = pages[0];
  
  // Use the browser CDP session to attach to the worker
  const browserCdp = await browser.createCDPSession();
  
  // Get targets via CDP
  const targetsResp = await browserCdp.send('Target.getTargets', {});
  const swInfo = targetsResp.targetInfos.find(t => t.type === 'service_worker');
  console.log('\nSW via CDP:', JSON.stringify(swInfo));
  
  if (swInfo) {
    // Attach to the worker
    const attachResult = await browserCdp.send('Target.attachToTarget', {
      targetId: swInfo.targetId,
      flatten: true,
    });
    console.log('Attached: sessionId present:', !!attachResult.sessionId);
    
    // Evaluate using raw CDP on the worker's context
    try {
      const evalResult = await browserCdp.send('Runtime.evaluate', {
        expression: 'chrome.runtime.id',
        uniqueContextId: swInfo.targetId,
        returnByValue: true,
      });
      console.log('CDP eval via uniqueContextId:', JSON.stringify(evalResult));
    } catch (e) {
      console.log('CDP uniqueContextId eval failed:', e.message);
    }
  }

  await browserCdp.detach();
  await browser.close();
})().catch(e => console.error(e));
