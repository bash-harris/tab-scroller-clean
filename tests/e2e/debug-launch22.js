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

  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension ID:', extId);

  // Open page and listen for isolated world contexts
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Runtime.enable');

  const contexts = [];

  cdp.on('Runtime.executionContextCreated', (event) => {
    const ctx = event.context;
    contexts.push(ctx);
    console.log('Context created:',
      'id:', ctx.id,
      'name:', JSON.stringify(ctx.name),
      'default:', ctx.auxData?.isDefault,
      'type:', ctx.auxData?.type,
      'origin:', (ctx.origin || '').substring(0, 40));
  });

  // Navigate - this will inject the content script
  await page.goto('https://example.com');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\nAll contexts captured (' + contexts.length + ' total):');
  for (const ctx of contexts) {
    console.log(`  ID:${ctx.id} | name:${JSON.stringify(ctx.name || '')} | default:${ctx.auxData?.isDefault} | type:${ctx.auxData?.type}`);
  }

  // Find non-default (isolated) contexts
  const isolated = contexts.filter(ctx => !ctx.auxData?.isDefault);
  console.log('\nNon-default contexts:', isolated.length);
  for (const ctx of isolated) {
    console.log(`  ID:${ctx.id} name:${JSON.stringify(ctx.name)} type:${ctx.auxData?.type}`);
  }

  // Try to find the content script context (one with 'chrome-extension' in origin/name)
  let csContext = isolated.find(ctx =>
    ctx.origin?.includes('chrome-extension') ||
    ctx.name?.includes('extension') ||
    ctx.name?.includes(extId)
  );

  if (!csContext) {
    // Try to find it by evaluating in each isolated context
    console.log('\nSearching for content script context by evaluating chrome API...');
    for (const ctx of isolated) {
      if (ctx.auxData?.isDefault) continue;
      try {
        const result = await cdp.send('Runtime.evaluate', {
          contextId: ctx.id,
          expression: 'typeof chrome?.runtime?.sendMessage === "function" ? "yes" : "no"',
          awaitPromise: false,
        });
        console.log(`  Context ${ctx.id}: chrome available: ${result.result?.value}`);
        if (result.result?.value === 'yes') {
          csContext = ctx;
        }
      } catch (e) {
        console.log(`  Context ${ctx.id}: error:`, e.message?.substring(0, 60));
      }
    }
  }

  if (csContext) {
    console.log(`\n=== Using content script context ${csContext.id} ===`);

    // Test 1: SESSION_GET_ACTIVE
    console.log('\nTest 1: SESSION_GET_ACTIVE');
    const result1 = await cdp.send('Runtime.evaluate', {
      contextId: csContext.id,
      expression: `
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "SESSION_GET_ACTIVE" }, (response) => {
            resolve(JSON.stringify(response || { error: 'no response' }));
          });
        })
      `,
      awaitPromise: true,
      timeout: 15000,
    });
    console.log('Result:', result1.result?.value);

    // Test 2: AI_COMMAND
    console.log('\nTest 2: AI_COMMAND "group all tabs"');
    const result2 = await cdp.send('Runtime.evaluate', {
      contextId: csContext.id,
      expression: `
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "AI_COMMAND", command: "group all tabs" }, (response) => {
            resolve(JSON.stringify(response || { error: 'no response' }));
          });
        })
      `,
      awaitPromise: true,
      timeout: 60000,
    });
    console.log('Result:', result2.result?.value);

  } else {
    console.log('\nCould not find content script context');
  }

  await browser.close();
})().catch(e => console.error(e));
