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

  const worker = await swTarget.worker();
  console.log('Worker obtained');

  // Test 1: Can we access let variable directly?
  try {
    const v = await worker.evaluate(() => KEYWORD_EXTRACTION_TOP_N);
    console.log('Test 1 - Direct let access:', v);
  } catch (e) {
    console.log('Test 1 - Direct let access FAILED:', e.message?.substring(0, 80));
  }

  // Test 2: Can we access a var variable?
  // Add one via evaluate first (this creates it in the global eval context)
  try {
    await worker.evaluate(() => { self.__testVar = 42; });
    const v = await worker.evaluate(() => self.__testVar);
    console.log('Test 2 - self.__testVar:', v);
  } catch (e) {
    console.log('Test 2 - self.__testVar FAILED:', e.message?.substring(0, 80));
  }

  // Test 3: Can we call a function declared with "function"?
  try {
    const v = await worker.evaluate(() => typeof extractKeywords);
    console.log('Test 3 - typeof extractKeywords:', v);
  } catch (e) {
    console.log('Test 3 - extractKeywords FAILED:', e.message?.substring(0, 80));
  }

  // Test 4: Can we call extractKeywords (which internally uses KEYWORD_EXTRACTION_TOP_N)?
  try {
    const v = await worker.evaluate(() => {
      try {
        return extractKeywords('test command');
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    });
    console.log('Test 4 - extractKeywords call:', JSON.stringify(v));
  } catch (e) {
    console.log('Test 4 - extractKeywords FAILED:', e.message?.substring(0, 80));
  }

  // Test 5: Can we access let variables from a function THAT WAS DEFINED in the SW?
  try {
    const v = await worker.evaluate(() => {
      try {
        return parseAiCommand('group all tabs', null);
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    });
    console.log('Test 5 - parseAiCommand call:', JSON.stringify(v).substring(0, 300));
  } catch (e) {
    console.log('Test 5 - parseAiCommand FAILED:', e.message?.substring(0, 80));
  }

  // Test 6: KEYWORD_EXTRACTION_TOP_N might be accessible via self if it were var
  try {
    const v = await worker.evaluate(() => self.KEYWORD_EXTRACTION_TOP_N);
    console.log('Test 6 - self.KEYWORD_EXTRACTION_TOP_N:', v);
  } catch (e) {
    console.log('Test 6 - self.KEYWORD_EXTRACTION_TOP_N FAILED:', e.message?.substring(0, 80));
  }

  // Test 7: Let's see what's on self
  try {
    const v = await worker.evaluate(() => {
      const keys = [];
      for (const key in self) {
        if (key.includes('KEYWORD') || key.includes('SNIPPET') || key.includes('THRESHOLD')) {
          keys.push(key);
        }
      }
      return keys;
    });
    console.log('Test 7 - let vars on self:', v);
  } catch (e) {
    console.log('Test 7 FAILED:', e.message?.substring(0, 80));
  }

  // Test 8: Can we use chrome.storage to get settings?
  try {
    const v = await worker.evaluate(async () => {
      return new Promise(resolve => {
        chrome.storage.sync.get({ testSetting: 'default' }, items => {
          resolve(JSON.stringify(items));
        });
      });
    });
    console.log('Test 8 - chrome.storage.sync.get:', v);
  } catch (e) {
    console.log('Test 8 FAILED:', e.message?.substring(0, 80));
  }

  await browser.close();
})().catch(e => console.error(e));
