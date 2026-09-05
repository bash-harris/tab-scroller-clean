// Spot-check 5 pool tabs against the real Chrome backup export
const fs = require('fs');
const pool = JSON.parse(fs.readFileSync(__dirname + '/real-v1.pool.json', 'utf8'));
const backup = JSON.parse(fs.readFileSync('C:/Users/bkh/Downloads/tab-scroller-backup-2026-08-30.json', 'utf8'));
console.log('backup top keys:', Object.keys(backup).join(','));

// collect all backup tabs wherever they live
function collect(o, out) {
  if (Array.isArray(o)) { for (const x of o) collect(x, out); return; }
  if (o && typeof o === 'object') {
    if (typeof o.url === 'string' && (typeof o.title === 'string' || typeof o.name === 'string')) out.push(o);
    for (const k of Object.keys(o)) if (k !== 'windows') collect(o[k], out);
  }
}
const bt = [];
collect(backup, bt);
console.log('backup tab-like entries:', bt.length);

const pickIds = [1, 273, 372, 517, 550];
for (const id of pickIds) {
  const pt = pool.tabs.find(t => t.id === id);
  const hit = bt.find(b => b.url === pt.url);
  const hitTitle = hit ? (hit.title || hit.name) : null;
  const titleMatch = hitTitle !== null && hitTitle === pt.title;
  console.log(`tab ${id}: url-in-backup=${!!hit} title-match=${titleMatch}`);
  console.log('   pool :', pt.title, '|', pt.url);
  if (hit) console.log('   bkp  :', hitTitle, '|', hit.url);
  else console.log('   bkp  : NOT FOUND by exact url');
}
// group check: does backup contain 18 tabs with group name Dev?
const devTabs = bt.filter(b => JSON.stringify(b).includes('"Dev"') || (b.groupName === 'Dev') || (b.group && b.group.name === 'Dev'));
console.log('backup entries mentioning Dev-group membership directly:', devTabs.length);
// count backup tabs matching the 18 pool G1 urls
const g1Urls = new Set(pool.tabs.filter(t => t.groupId === 'G1').map(t => t.url));
const g1Hits = bt.filter(b => g1Urls.has(b.url));
console.log('backup tabs whose url is in pool G1 set:', g1Hits.length, '/ 18');
