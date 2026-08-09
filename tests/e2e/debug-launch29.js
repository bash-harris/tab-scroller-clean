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

  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker',
    { timeout: 30000 }
  );

  // Give the SW extra time to fully initialize before attaching
  await new Promise(r => setTimeout(r, 5000));

  const worker = await swTarget.worker();
  console.log('Worker obtained after delay');

  // Try to access the runtime ID first to verify connection
  const extId = await worker.evaluate(() => chrome.runtime.id);
  console.log('Ext ID:', extId);

  // Now check if lexical scope variables are accessible
  // Use Runtime.globalLexicalScopeNames via CDP directly
  try {
    const cdpSession = await worker.createCDPSession();
    const { names } = await cdpSession.send('Runtime.globalLexicalScopeNames');
    console.log('Lexical scope names:', names?.filter(n => n.includes('KEYWORD') || n.includes('SNIPPET') || n.includes('CONFIDENCE')));
  } catch (e) {
    console.log('Could not get lexical scope:', e.message);
  }

  // Instead of directly accessing let variables, try calling functions that USE them
  // The function extractKeywords is a function declaration (not let), so it IS on the global scope
  const testResult = await worker.evaluate(async () => {
    try {
      // extractKeywords should be on global scope (function declaration)
      const result = extractKeywords('test command');
      return JSON.stringify({ success: true, keywords: result });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  });
  console.log('extractKeywords test:', testResult);

  // If extractKeywords works (which accesses KEYWORD_EXTRACTION_TOP_N), 
  // then the TDZ error was about timing, not scope.
  // If it still fails with TDZ, then the CDP evaluation scope is different.

  await browser.close();
})().catch(e => console.error(e));
