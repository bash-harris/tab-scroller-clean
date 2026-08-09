const puppeteer = require('puppeteer');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '..');

let browser;

const launchBrowser = async () => {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: false, // Must be false to test extension APIs effectively
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
  }
  return browser;
};

const closeBrowser = async () => {
  if (browser) {
    await browser.close();
    browser = null;
  }
};

module.exports = {
  launchBrowser,
  closeBrowser
};
