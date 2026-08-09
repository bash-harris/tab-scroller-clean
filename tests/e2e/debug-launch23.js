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

  // Use browser-level CDP session for Target domain
  const browserCdp = await browser.createCDPSession();

  // Listen for new targets and auto-attach to service workers
  browserCdp.on('Target.targetCreated', async (event) => {
    if (event.targetInfo.type === 'service_worker') {
      console.log('SW target created:', event.targetInfo.targetId);
      try {
        await browserCdp.send('Target.attachToTarget', {
          targetId: event.targetInfo.targetId,
          flatten: true,
        });
        console.log('Auto-attached to SW!');
      } catch (e) {
        console.log('Auto-attach failed:', e.message);
      }
    }
  });

  // Also try Target.setAutoAttach
  try {
    await browserCdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    console.log('Target auto-attach configured');

    // Listen for attached targets
    browserCdp.on('Target.attachedToTarget', (event) => {
      if (event.targetInfo.type === 'service_worker') {
        console.log('SW auto-attached:', event.targetInfo.targetId,
          'session:', event.sessionId);
      }
    });
  } catch (e) {
    console.log('setAutoAttach failed:', e.message);
  }

  // Wait for extension to load
  await new Promise(r => setTimeout(r, 5000));

  // Now get all targets and see if any SW session exists
  const { targetInfos } = await browserCdp.send('Target.getTargets');
  const swTarget = targetInfos.find(t => t.type === 'service_worker');
  
  if (swTarget) {
    console.log('SW target found in list:', swTarget.targetId);
    // Try attaching now
    try {
      const attachResult = await browserCdp.send('Target.attachToTarget', {
        targetId: swTarget.targetId,
        flatten: true,
      });
      console.log('Attached now. Session:', attachResult.sessionId);
    } catch (e) {
      console.log('Attach now failed:', e.message);
    }
  } else {
    console.log('No SW target in list');
    console.log('All targets:');
    for (const t of targetInfos) {
      console.log(`  ${t.type}: ${t.url.substring(0, 80)}`);
    }
  }

  await browser.close();
})().catch(e => console.error(e));
