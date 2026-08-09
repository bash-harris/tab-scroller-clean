const puppeteer = require('puppeteer');
const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

(async () => {
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './.puppeteer_user_data_sw_debug',
    args: [
      '--disable-extensions-except=' + EXTENSION_PATH,
      '--load-extension=' + EXTENSION_PATH,
      '--window-size=1400,900',
    ],
  });

  browser.on('targetcreated', async target => {
    console.log('Target created:', target.type(), target.url());
    if (target.type() === 'service_worker') {
      try {
        const worker = await target.worker();
        console.log('Attached to worker.');
        worker.on('console', msg => {
          console.log(`[Worker Console] ${msg.type().toUpperCase()}: ${msg.text()}`);
        });
      } catch (e) {
        console.error('Failed to attach to worker:', e.message);
      }
    }
  });

  await new Promise(r => setTimeout(r, 8000));
  await browser.close();
  console.log('Done');
})().catch(e => console.error('Error:', e));
