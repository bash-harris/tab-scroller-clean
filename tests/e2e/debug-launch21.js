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

  // Find SW target for extension ID
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension ID:', extId);

  // Open a page where content.js IS injected (manifest-declared)
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await new Promise(r => setTimeout(r, 3000));

  // Get CDP session to find the isolated world context
  const cdp = await page.createCDPSession();
  await cdp.send('Runtime.enable');

  // Collect execution contexts
  const contexts = [];

  cdp.on('Runtime.executionContextCreated', (event) => {
    contexts.push(event.context);
    console.log('Context created:', event.context.id,
      'name:', event.context.name || '(no name)',
      'origin:', event.context.origin?.substring(0, 50),
      'isDefault:', event.context.auxData?.isDefault);
  });

  // Also get existing contexts
  const { contexts: existingContexts } = await cdp.send('Runtime.executionContexts');
  for (const ctx of existingContexts) {
    contexts.push(ctx);
    console.log('Existing context:', ctx.id,
      'name:', ctx.name || '(no name)',
      'origin:', ctx.origin?.substring(0, 50),
      'isDefault:', ctx.auxData?.isDefault);
  }

  // Reload to trigger fresh context creation
  await page.reload();
  await new Promise(r => setTimeout(r, 3000));

  // Print all contexts
  console.log('\nAll execution contexts:');
  for (const ctx of contexts) {
    console.log(`  ID:${ctx.id} | name:"${ctx.name}" | default:${ctx.auxData?.isDefault} | origin:${(ctx.origin || '').substring(0,40)}`);
  }

  // Get fresh contexts after reload
  const { contexts: freshContexts } = await cdp.send('Runtime.executionContexts');
  console.log('\nFresh contexts after reload:');
  for (const ctx of freshContexts) {
    console.log(`  ID:${ctx.id} | name:"${ctx.name}" | default:${ctx.auxData?.isDefault} | origin:${(ctx.origin || '').substring(0,40)}`);
  }

  // Try evaluating in each context to find one where chrome.runtime.sendMessage works
  console.log('\nTesting each context for extension API access:');
  for (const ctx of freshContexts) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        contextId: ctx.id,
        expression: 'typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined" ? "has chrome" : "no chrome"',
        awaitPromise: false,
      });
      console.log(`  Context ${ctx.id} (${ctx.name || 'unnamed'}): ${result.result?.value}`);
    } catch (e) {
      console.log(`  Context ${ctx.id}: error - ${e.message}`);
    }
  }

  // Find the content script's isolated world context
  // It's the non-default context whose origin matches the page
  const csContext = freshContexts.find(ctx =>
    !ctx.auxData?.isDefault &&
    ctx.name?.includes(extId)
  );

  if (csContext) {
    console.log(`\nFound content script context: ${csContext.id} (${csContext.name})`);

    // Try sending a message from this context
    const result = await cdp.send('Runtime.evaluate', {
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

    console.log('Message result:', result.result?.value);
  } else {
    console.log('\nNo content script context found with extension ID in name');

    // Try the default context
    for (const ctx of freshContexts) {
      if (ctx.auxData?.isDefault || ctx.name === '' || ctx.name === undefined) {
        console.log('Trying default context:', ctx.id);
        try {
          const result = await cdp.send('Runtime.evaluate', {
            contextId: ctx.id,
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
          console.log('Default context message result:', result.result?.value);
        } catch (e) {
          console.log('Default context error:', e.message);
        }
      }
    }
  }

  await browser.close();
})().catch(e => console.error(e));
