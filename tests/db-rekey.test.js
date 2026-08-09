// A5: tabCards must be keyed by urlHash, not tabId.
// Standalone node test (the jest suites in this repo target a src/ layout that
// does not exist). Run: node tests/db-rekey.test.js
require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok:', name); }
  else { fail++; console.log('  FAIL:', name, extra !== undefined ? '->' + JSON.stringify(extra) : ''); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// db.js is an IIFE that assigns self.TabDB. Give it a self and run it.
function loadTabDB() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const sandbox = { indexedDB, IDBKeyRange, console, Float32Array, Math, Promise, JSON };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.self.TabDB;
}

// Seed a v3 store keyed by tabId, the way the old schema wrote it.
function seedV3(rows) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TabScrollerRAG', 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('category', 'category', { unique: false });
      }
      if (!db.objectStoreNames.contains('tabCards')) {
        const cs = db.createObjectStore('tabCards', { keyPath: 'tabId' });
        cs.createIndex('urlHash', 'urlHash', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('tabCards', 'readwrite');
      const store = tx.objectStore('tabCards');
      for (const r of rows) store.put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

(async () => {
  console.log('\n--- v3 -> v4 re-key migration ---');

  await seedV3([
    { tabId: 11, urlHash: 'hash-a', title: 'A old', extractedAt: 100 },
    { tabId: 22, urlHash: 'hash-b', title: 'B', extractedAt: 200 },
    // Duplicate tabs of the same page: must collapse to the newest row.
    { tabId: 33, urlHash: 'hash-a', title: 'A new', extractedAt: 300 },
    // Predates urlHash: cannot be re-keyed, must be dropped not invented.
    { tabId: 44, title: 'no hash', extractedAt: 400 },
  ]);

  const TabDB = loadTabDB();
  await TabDB.init();

  const all = await TabDB.getAllTabCards();
  eq('migrated row count (dedup + drop unkeyable)', all.length, 2);

  const hashes = all.map(c => c.urlHash).sort();
  eq('rows keyed by urlHash', hashes, ['hash-a', 'hash-b']);

  const a = await TabDB.getCardByUrlHash('hash-a');
  eq('duplicate collapse keeps newest', a && a.title, 'A new');

  const missing = await TabDB.getCardByUrlHash('nope');
  eq('absent hash -> null', missing, null);

  console.log('\n--- urlHash is the primary key ---');

  // Same page, new tabId after a restart: must update in place, not duplicate.
  await TabDB.storeTabCard({ urlHash: 'hash-b', tabId: 999, title: 'B restarted', extractedAt: 500 });
  const afterRestart = await TabDB.getAllTabCards();
  eq('re-store same page does not duplicate', afterRestart.length, 2);
  const b = await TabDB.getCardByUrlHash('hash-b');
  eq('enrichment survives a tabId change', b && b.title, 'B restarted');
  eq('tabId tracks the live tab', b && b.tabId, 999);

  console.log('\n--- tabId lookup still works for live-tab callers ---');
  const byTab = await TabDB.getTabCard(999);
  eq('getTabCard finds row via tabId index', byTab && byTab.urlHash, 'hash-b');
  const byStaleTab = await TabDB.getTabCard(4242);
  eq('unknown tabId -> null', byStaleTab, null);

  // Two rows sharing a tabId: index must return the most recent.
  await TabDB.storeTabCard({ urlHash: 'hash-c', tabId: 999, title: 'C', extractedAt: 900 });
  const shared = await TabDB.getTabCard(999);
  eq('non-unique tabId returns newest', shared && shared.urlHash, 'hash-c');

  console.log('\n--- delete + evict operate on urlHash ---');
  await TabDB.deleteTabCard('hash-c');
  const afterDelete = await TabDB.getCardByUrlHash('hash-c');
  eq('deleteTabCard(urlHash) removes the row', afterDelete, null);

  await TabDB.storeTabCard({ urlHash: 'e1', tabId: 1, title: 'e1', extractedAt: 10 });
  await TabDB.storeTabCard({ urlHash: 'e2', tabId: 2, title: 'e2', extractedAt: 20 });
  await TabDB.storeTabCard({ urlHash: 'e3', tabId: 3, title: 'e3', extractedAt: 30 });
  await TabDB.evictOldest(2);
  const kept = (await TabDB.getAllTabCards()).map(c => c.urlHash).sort();
  eq('evictOldest keeps exactly max rows', kept.length, 2);
  ok('evictOldest drops oldest first', !kept.includes('e1'), kept);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('THREW:', e && e.stack || e);
  process.exit(1);
});
