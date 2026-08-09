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

  // Use the browser's OWN target to create a CDP session
  const browserTarget = browser.target();
  console.log('Browser target type:', browserTarget.type());
  const cdp = await browserTarget.createCDPSession();
  console.log('Browser-level CDP session created');

  // Get all targets
  const targetsResp = await cdp.send('Target.getTargets', {});
  console.log('All targets:');
  for (const t of targetsResp.targetInfos || []) {
    console.log('  type:', t.type, 'id:', t.targetId.slice(0, 20), 'url:', (t.url || '').slice(0, 100));
  }

  // Find SW
  const swInfo = (targetsResp.targetInfos || []).find(t => t.type === 'service_worker');
  if (!swInfo) {
    console.log('No SW target found');
    await cdp.detach();
    await browser.close();
    return;
  }

  console.log('\nSW target ID:', swInfo.targetId);

  // Try attaching
  try {
    const attachResult = await cdp.send('Target.attachToTarget', {
      targetId: swInfo.targetId,
      flatten: true,
    });
    console.log('Attached. sessionId:', attachResult.sessionId ? 'present' : 'missing');

    // Create a new CDP session for the SW
    const swCdp = await browserTarget.createCDPSession();
    
    // Actually, we need to use the session ID from the attach result
    // Let me check if we can reuse the same CDP session by specifying the sessionId
    
    // Try Runtime.evaluate with session
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: 'chrome.runtime.id',
      returnByValue: true,
    });
    console.log('Eval result:', JSON.stringify(evalResult));
  } catch (e) {
    console.log('Error:', e.message);
  }

  await cdp.detach();
  await browser.close();
})().catch(e => console.error(e));
