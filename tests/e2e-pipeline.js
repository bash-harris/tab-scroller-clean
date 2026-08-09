const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.resolve(__dirname, '.chrome-profile-pipeline');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function callDjango(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 8000, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== E2E: Full pipeline test (search + AI + execute) ===\n');
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch {}

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [`--load-extension=${EXTENSION_PATH}`, '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  const swLogs = [];
  context.serviceWorkers().forEach(sw => {
    sw.on('console', msg => swLogs.push(`[${msg.type()}] ${msg.text()}`));
  });

  await sleep(4000);
  const sw = context.serviceWorkers()[0];
  if (!sw) { console.log('FATAL: No SW'); process.exit(1); }

  // Open diverse tabs
  const urls = [
    'https://www.linkedin.com/feed/',
    'https://www.linkedin.com/jobs/',
    'https://www.linkedin.com/messaging/',
    'https://leetcode.com/problemset/',
    'https://leetcode.com/discuss/',
    'https://leetcode.com/contest/',
    'https://github.com/trending',
    'https://github.com/settings/profile',
    'https://www.youtube.com/',
    'https://old.reddit.com/r/programming/',
    'https://news.ycombinator.com/',
    'https://stackoverflow.com/questions',
  ];

  console.log('--- Opening 12 tabs ---');
  for (const url of urls) {
    const p = await context.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await sleep(1500);
    console.log(`  ${url.split('/')[2]}`);
  }

  console.log('\n--- Waiting 45s for all embeddings ---');
  await sleep(45000);

  // Get DB state
  const dbCards = await sw.evaluate(() => {
    const db = self.TabDB?._db;
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('tabCards', 'readonly');
        const req = tx.objectStore('tabCards').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  });

  console.log(`\n--- Indexed ${dbCards.length} tabs ---`);
  const withEmb = dbCards.filter(c => c.embedding?.length > 0);
  const noEmb = dbCards.filter(c => !c.embedding || c.embedding.length === 0);
  console.log(`  With embeddings: ${withEmb.length}`);
  console.log(`  Without embeddings: ${noEmb.length}`);
  for (const c of dbCards) {
    console.log(`  ${c.embedding?.length > 0 ? '✓' : '✗'} [${c.tabId}] ${(c.title||'').substring(0,45)} → ${c.embedding?.length || 0}-dim`);
  }

  // Step 1: Test search from extension
  console.log('\n--- Step 1: Extension SearchService ---');
  const queries = ['linkedin', 'leetcode', 'github', 'youtube', 'group all linkedin tabs', 'group all github tabs'];
  for (const q of queries) {
    try {
      const results = await sw.evaluate(async (query) => {
        const r = await self.SearchService.searchTabs(query, 5);
        return r.map(x => ({ title: (x.title||'').substring(0,35), score: x.similarity?.toFixed(3) }));
      }, q);
      const top1 = results[0] || { title: 'none', score: 'N/A' };
      console.log(`  "${q}" → #1: ${top1.title} (${top1.score})`);
    } catch (e) {
      console.log(`  "${q}" → ERROR: ${e.message}`);
    }
  }

  // Step 2: Test full pipeline via extension AI_COMMAND
  console.log('\n--- Step 2: Full pipeline via SW evaluate ---');
  
  // Search for "linkedin" and verify results
  try {
    const searchRes = await sw.evaluate(async () => {
      const searchResults = await self.SearchService.searchTabs('group all linkedin tabs', 10);
      const currentTabs = await self.TabService.getAllTabs(chrome.windows.WINDOW_ID_CURRENT);
      const currentTabIds = new Set(currentTabs.map(t => t.id));
      const validResults = searchResults.filter(r => currentTabIds.has(r.tabId));

      let compactTabs;
      if (validResults.length > 0) {
        compactTabs = validResults.map(t => ({
          id: t.tabId, title: t.title || '', url: t.url || '',
        }));
      } else {
        compactTabs = currentTabs.map(t => ({
          id: t.id, title: t.title || '', url: t.url || '',
        }));
      }

      return {
        searchCount: searchResults.length,
        validCount: validResults.length,
        currentTabCount: currentTabs.length,
        compactTabs,
        usedFallback: validResults.length === 0,
        topResults: searchResults.slice(0, 5).map(r => ({
          title: (r.title||'').substring(0,40),
          score: r.similarity?.toFixed(4),
        })),
      };
    });

    console.log(`  Search returned: ${searchRes.searchCount} results`);
    console.log(`  Valid (current tabs): ${searchRes.validCount}`);
    console.log(`  Current tabs in Chrome: ${searchRes.currentTabCount}`);
    console.log(`  Used fallback: ${searchRes.usedFallback}`);
    console.log(`  Tabs sent to AI: ${searchRes.compactTabs.length}`);
    console.log(`  Top search results:`);
    for (const r of searchRes.topResults) {
      console.log(`    ${r.score} ${r.title}`);
    }

    if (searchRes.compactTabs.length > 0) {
      console.log(`\n  Sending to Django AI...`);
      const aiResult = await callDjango('/api/chat', {
        prompt: 'group all linkedin tabs',
        tabs: searchRes.compactTabs,
      });
      console.log(`  AI Response:`);
      console.log(`    Tool: ${aiResult.tool}`);
      console.log(`    TabIDs: ${JSON.stringify(aiResult.arguments?.tabIds)}`);
      console.log(`    Message: ${aiResult.message}`);

      // Check if the AI chose correct tab IDs
      const linkedinTabIds = searchRes.compactTabs
        .filter(t => t.url.includes('linkedin.com'))
        .map(t => t.id);
      const aiTabIds = aiResult.arguments?.tabIds || [];
      const correctIds = aiTabIds.filter(id => linkedinTabIds.includes(id));
      const wrongIds = aiTabIds.filter(id => !linkedinTabIds.includes(id));

      console.log(`\n  VERIFICATION:`);
      console.log(`    LinkedIn tab IDs in search results: ${linkedinTabIds.join(', ')}`);
      console.log(`    AI chose: ${aiTabIds.join(', ')}`);
      console.log(`    Correct: ${correctIds.join(', ')}`);
      console.log(`    Wrong: ${wrongIds.length > 0 ? wrongIds.join(', ') : 'none'}`);
      console.log(`    Result: ${wrongIds.length === 0 ? '✓ CORRECT' : '✗ WRONG TABS SELECTED'}`);
    }
  } catch (e) {
    console.log(`  Pipeline error: ${e.message}`);
  }

  // SW logs
  console.log(`\n--- SW logs (${swLogs.length}) ---`);
  for (const log of swLogs.slice(0, 20)) console.log(`  ${log}`);
  if (swLogs.length > 20) console.log(`  ... +${swLogs.length - 20} more`);

  console.log('\n=== DONE ===');
  await context.close();
  process.exit(0);
})();
