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

  // Access the internal CDP connection to create sessions
  const conn = browser._connection;
  
  // Listen for target created events on the browser connection
  conn.on('CDP.Target.targetCreated', (event) => {
    const info = event.targetInfo;
    if (info.type === 'service_worker') {
      console.log('SW target created:', info.targetId, info.url);
    }
  });

  // Send setAutoAttach to automatically attach to all targets
  try {
    const result = await conn.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    console.log('setAutoAttach sent');

    // Listen for auto-attach events
    conn.on('CDP.Target.attachedToTarget', (event) => {
      console.log('Attached to target:',
        event.targetInfo.type,
        event.targetInfo.url.substring(0, 80),
        'session:', event.sessionId);
      
      if (event.targetInfo.type === 'service_worker') {
        // We now have a session to the SW!
        console.log('SW session available:', event.sessionId);
        
        // We can use this session via _connection.createSession
        // But we need to keep a reference to it
      }
    });

  } catch (e) {
    console.log('setAutoAttach error:', e.message);
  }

  // Wait for extension to fully load
  await new Promise(r => setTimeout(r, 8000));

  // Check all current targets
  const { targetInfos } = await conn.send('Target.getTargets');
  console.log('\nCurrent targets:');
  for (const t of targetInfos) {
    console.log(`  ${t.type}: ${(t.url || t.title || '').substring(0, 80)}`);
  }

  await browser.close();
})().catch(e => console.error(e));
