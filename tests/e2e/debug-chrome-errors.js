const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
    ],
  });

  // Open chrome://extensions
  const page = await browser.newPage();
  await page.goto('chrome://extensions', { waitUntil: 'networkidle2' });
  console.log('Navigated to chrome://extensions');

  // Wait a bit for errors to render
  await new Promise(r => setTimeout(r, 5000));

  // Extract errors from the shadow DOM of chrome://extensions
  const errors = await page.evaluate(async () => {
    const manager = document.querySelector('extensions-manager');
    if (!manager) return 'No extensions-manager found';
    
    const itemList = manager.shadowRoot.querySelector('extensions-item-list');
    if (!itemList) return 'No extensions-item-list found';
    
    const items = itemList.shadowRoot.querySelectorAll('extensions-item');
    const result = [];
    
    for (const item of items) {
      const name = item.shadowRoot.querySelector('#name').innerText;
      const errorButton = item.shadowRoot.querySelector('#errors-button');
      if (errorButton) {
        errorButton.click();
        await new Promise(r => setTimeout(r, 1000));
        // Find errors in manager
        const errorPage = manager.shadowRoot.querySelector('extensions-error-page');
        if (errorPage) {
          const errorItems = errorPage.shadowRoot.querySelectorAll('.error-message');
          const errorTexts = Array.from(errorItems).map(e => e.innerText);
          result.push({ extension: name, errors: errorTexts });
        } else {
          result.push({ extension: name, errorButtonPresent: true, errorPageNotFound: true });
        }
      } else {
        result.push({ extension: name, noErrors: true });
      }
    }
    return result;
  });

  console.log('Extension Errors:', JSON.stringify(errors, null, 2));

  await browser.close();
  console.log('Done');
})().catch(e => console.error('Error:', e));
