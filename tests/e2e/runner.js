const puppeteer = require('puppeteer');
const { EXTENSION_PATH, ALL_WIKI_URLS_SET } = require('./fixtures');

const POLL_INTERVAL = 500;

async function waitForBackgroundTarget(browser, maxWaitMs = 30000) {
  return await browser.waitForTarget(
    target => target.type() === 'service_worker' || target.type() === 'background_page',
    { timeout: maxWaitMs }
  );
}

async function launchWithExtension() {
  const extPath = typeof EXTENSION_PATH === 'string' ? EXTENSION_PATH : String(EXTENSION_PATH);
  console.log('[runner] Launching with extension path:', extPath);
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './.puppeteer_user_data',
    args: [
      '--disable-extensions-except=' + extPath,
      '--load-extension=' + extPath,
      '--window-size=1400,900',
    ],
  });

  const bgTarget = await waitForBackgroundTarget(browser);
  const extUrl = bgTarget.url();
  const extId = extUrl.split('/')[2];

  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);

  return { browser, bgTarget, extId, optionsPage };
}

async function configureOllama(bgCdp) {
  const result = await bgCdp.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.storage.sync.set({
          useOllama: true,
          ollamaModel: 'qwen2.5:latest',
          ollamaUrl: 'http://localhost:11434',
          ollamaTimeout: 120000,
          enableAi: true,
          fallbackToOllama: true,
        }, () => {
          resolve('ok');
        });
      })
    `,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10000,
  });
  return result;
}

async function overrideAutoExecuteThreshold(bgCdp, value = 0) {
  return await bgCdp.send('Runtime.evaluate', {
    expression: `CONFIDENCE_THRESHOLDS.AUTO_EXECUTE = ${value}; true;`,
    awaitPromise: false,
    returnByValue: true,
  });
}

async function restoreAutoExecuteThreshold(bgCdp) {
  return await bgCdp.send('Runtime.evaluate', {
    expression: `CONFIDENCE_THRESHOLDS.AUTO_EXECUTE = 0.75; true;`,
    awaitPromise: false,
    returnByValue: true,
  });
}

async function openTabSet(browser, urls, timeout = 15000) {
  const pages = [];
  for (const url of urls) {
    const p = await browser.newPage();
    pages.push(p);
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      console.warn(`[openTabSet] Slow load for ${url}, continuing`);
    }
  }
  return pages;
}

async function getFirstRealTabId(optionsPage) {
  return await optionsPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const real = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
    return real ? real.id : null;
  });
}

async function sendAiCommandFullPipeline(command, bgCdp, realTabId) {
  const expression = `
    (async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: ${realTabId} },
          func: (cmd) => {
            return new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: "AI_COMMAND", command: cmd }, (response) => {
                resolve(response);
              });
            });
          },
          args: [${JSON.stringify(command)}],
        });
        return JSON.stringify(results[0]?.result || { success: false, message: "No result" });
      } catch (e) {
        return JSON.stringify({ success: false, message: e.message || String(e), errorType: "execution" });
      }
    })()
  `;

  const cdpResult = await bgCdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });

  if (cdpResult.exceptionDetails) {
    return { success: false, message: cdpResult.exceptionDetails.text || 'CDP evaluation error' };
  }
  return JSON.parse(cdpResult.result.value);
}

async function execDirectAiCommand(command, bgCdp) {
  const expression = `
    (async () => {
      try {
        const [currentWindow] = await chrome.windows.getAll({ populate: false });
        const windowId = currentWindow.id;
        const response = await parseAiCommand(${JSON.stringify(command)}, windowId);
        if (!response) {
          return JSON.stringify({ success: false, message: "Could not parse command" });
        }
        if (response.type === 'text') {
          return JSON.stringify({ success: true, text: response.text });
        }
        if (!response.functionCall || !response.functionCall.name) {
          return JSON.stringify({ success: false, message: "No valid tool parsed" });
        }
        const result = await executeToolCall(response.functionCall, windowId);
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ success: false, message: e.message || String(e) });
      }
    })()
  `;

  const cdpResult = await bgCdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });

  if (cdpResult.exceptionDetails) {
    return { success: false, message: cdpResult.exceptionDetails.text || 'CDP evaluation error' };
  }
  return JSON.parse(cdpResult.result.value);
}

async function getTabState(optionsPage) {
  return await optionsPage.evaluate(async () => {
    const groups = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    return {
      groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color })),
      tabs: tabs.map(t => ({
        id: t.id, title: t.title, url: t.url, groupId: t.groupId,
        pinned: t.pinned, audible: t.audible, windowId: t.windowId,
      })),
    };
  });
}

async function resetTabState(optionsPage) {
  await optionsPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const groupedIds = tabs.filter(t => t.groupId !== -1).map(t => t.id);
    if (groupedIds.length > 0) {
      await chrome.tabs.ungroup(groupedIds);
    }
  });
  await sleep(500);
}

async function closeExtraTabs(optionsPage, keepCount) {
  await optionsPage.evaluate(async (keep) => {
    const tabs = await chrome.tabs.query({});
    const realTabs = tabs.filter(t =>
      t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
    );
    const toClose = realTabs.slice(keep).map(t => t.id);
    if (toClose.length > 0) {
      await chrome.tabs.remove(toClose);
    }
  }, keepCount);
  await sleep(500);
}

async function closeAllRealTabs(optionsPage) {
  await optionsPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const toClose = tabs.filter(t =>
      t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
    ).map(t => t.id);
    if (toClose.length > 0) {
      await chrome.tabs.remove(toClose);
    }
  });
  await sleep(500);
}

async function waitForTabCount(optionsPage, expected, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await getTabState(optionsPage);
    const realTabs = state.tabs.filter(t => t.url && !t.url.startsWith('chrome-extension://'));
    if (realTabs.length >= expected) return realTabs;
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Timed out waiting for ${expected} real tabs`);
}

async function seedTabDB(bgCdp, docs) {
  const expression = `
    (async () => {
      const results = [];
      for (const doc of ${JSON.stringify(docs)}) {
        try {
          await TabDB.add(doc);
          results.push({ success: true, id: doc.url });
        } catch (e) {
          results.push({ success: false, id: doc.url, error: e.message });
        }
      }
      return JSON.stringify(results);
    })()
  `;
  const cdpResult = await bgCdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10000,
  });
  return JSON.parse(cdpResult.result.value);
}

async function countIndexedDocs(bgCdp) {
  const result = await bgCdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const count = await TabDB.count();
          return JSON.stringify({ count });
        } catch (e) {
          return JSON.stringify({ count: -1, error: e.message });
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10000,
  });
  return JSON.parse(result.result.value);
}

async function executeInBackground(bgCdp, expression, timeout = 120000) {
  const result = await bgCdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'CDP evaluation error');
  }
  return result.result.value;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function urlMatch(tabUrl, testUrl) {
  if (!tabUrl || !testUrl) return false;
  const slug = testUrl.split('/wiki/')[1];
  return slug ? tabUrl.includes(slug) : tabUrl === testUrl;
}

module.exports = {
  launchWithExtension,
  configureOllama,
  overrideAutoExecuteThreshold,
  restoreAutoExecuteThreshold,
  openTabSet,
  getFirstRealTabId,
  sendAiCommandFullPipeline,
  execDirectAiCommand,
  getTabState,
  resetTabState,
  closeExtraTabs,
  closeAllRealTabs,
  waitForTabCount,
  seedTabDB,
  countIndexedDocs,
  executeInBackground,
  sleep,
  urlMatch,
};
