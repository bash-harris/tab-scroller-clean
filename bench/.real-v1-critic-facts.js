// GOLD CRITIC scratch: leakage scan + pool facts
const fs = require('fs');
const raw = fs.readFileSync(__dirname + '/real-v1.pool.json', 'utf8');
const p = JSON.parse(raw);

// ---- LEAKAGE SCAN ----
const bad = ['openedMinAgo','lastActiveMinAgo','muted','audible','incognito','scrollPct',
  'visitCount','mainText','lastAccessed','favIcon','faviconUrl','openerTabId',
  'autoDiscardable','discarded','scroll','active','saved','bookmark'];
let hits = 0;
for (const k of bad) {
  const re = new RegExp('"' + k + '"', 'g');
  const m = raw.match(re);
  if (m) { console.log('LEAK HIT:', k, 'x' + m.length); hits++; }
}
if (!hits) console.log('LEAKAGE: clean (no forbidden keys)');

// exact key census
const tkeys = new Set(), gkeys = new Set();
for (const t of p.tabs) Object.keys(t).forEach(k => tkeys.add(k));
for (const g of p.groups) Object.keys(g).forEach(k => gkeys.add(k));
console.log('tab keys:', [...tkeys].join(','));
console.log('group keys:', [...gkeys].join(','));
console.log('group raw:', JSON.stringify(p.groups));

// ---- CURRENT TAB ----
const cur = p.tabs.find(t => t.id === p.meta.currentTabId);
console.log('currentTabId:', p.meta.currentTabId, '->', JSON.stringify(cur));

// ---- G1 MEMBERS ----
const g1 = p.tabs.filter(t => t.groupId === 'G1').map(t => t.id);
console.log('G1 n=' + g1.length, 'ids:', g1.join(','));
console.log('G1 id-range check (claim 548-565):', g1[0], '-', g1[g1.length-1]);

// ---- DUP CLUSTERS, exact URL (keep-first semantics) ----
const byFull = {};
for (const t of p.tabs) (byFull[t.url] = byFull[t.url] || []).push(t.id);
const dupsFull = Object.entries(byFull).filter(([, v]) => v.length > 1);
console.log('exact-URL dup clusters:', dupsFull.length);
for (const [k, v] of dupsFull) console.log('  ', v.join(','), '<-', k);

// dup w/ trailing-slash + www normalization
const norm = u => { try {
  const uu = new URL(u);
  let h = uu.hostname.replace(/^www\./, '');
  let path = uu.pathname.replace(/\/+$/, '') || '/';
  return h + path + (uu.search || '');
} catch (e) { return u; } };
const byNorm = {};
for (const t of p.tabs) (byNorm[norm(t.url)] = byNorm[norm(t.url)] || []).push(t.id);
const dupsNorm = Object.entries(byNorm).filter(([, v]) => v.length > 1);
console.log('norm(host+path+search) dup clusters:', dupsNorm.length);
for (const [k, v] of dupsNorm) console.log('  ', v.join(','), '<-', k);
