// GOLD CRITIC: re-derive expectedTabIds for 15 sampled non-abstain commands.
// Rules implemented INDEPENDENTLY from pool facts only (notes used as spec).
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(__dirname + '/real-v1.pool.json', 'utf8'));
const tabs = p.tabs;
const CUR = p.meta.currentTabId;
const CMDS = fs.readFileSync(__dirname + '/real-v1.commands.jsonl', 'utf8').trim().split('\n')
  .map(l => JSON.parse(l)).filter(r => r.command && !r.abstain);
// samples from seeded run: indexes into non-abstain array
const SAMPLE_IDX = [1, 9, 15, 30, 32, 38, 39, 51, 54, 56, 59, 60, 74, 89, 96];

// ---------- helpers ----------
function hostname(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return null; } }
function pathname(u) { try { return new URL(u).pathname.toLowerCase(); } catch (e) { return ''; } }
function registrable(u) {
  const h = hostname(u); if (!h) return null;
  const bare = h.replace(/^www\./, '');
  const parts = bare.split('.');
  const two = ['co.uk','com.au','co.in','co.jp','com.br','org.uk','co.za','com.mx'];
  if (parts.length <= 2) return bare;
  for (const t of two) if (bare.endsWith('.' + t)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
const host = t => hostname(t.url);
const title = t => t.title || '';
function titleContains(re) { return tabs.filter(t => re.test(title(t))).map(t => t.id); }
function byIndexAsc(a, b) { return a.index - b.index; }
const sortIds = a => [...new Set(a)].sort((x, y) => x - y);

// ---------- per-command derivations ----------
const results = [];
function check(name, derived, cmd) {
  const d = sortIds(derived), g = sortIds(cmd.expectedTabIds || []);
  const missing = g.filter(x => !d.includes(x));
  const extra = d.filter(x => !g.includes(x));
  const ok = missing.length === 0 && extra.length === 0;
  results.push({ name, ok, goldN: g.length, derivedN: d.length, missing, extra, cmd });
}

const deriv = {
  1:  () => tabs.filter(t => registrable(t.url) === 'github.com').map(t => t.id),
  9:  () => tabs.filter(t => registrable(t.url) === 'reddit.com').map(t => t.id),
  15: () => tabs.filter(t => registrable(t.url) === 'neetcode.io').map(t => t.id),
  30: () => tabs.filter(t => registrable(t.url) === 'arxiv.org' && pathname(t.url).startsWith('/pdf/')).map(t => t.id),
  32: () => tabs.filter(t => host(t) === 'colab.research.google.com').map(t => t.id),
  38: () => tabs.filter(t => /amazon/i.test(title(t)) && /interview/i.test(title(t))).map(t => t.id),
  39: () => titleContains(/slowed/i),
  51: () => {
    const curTab = tabs.find(t => t.id === CUR);
    return tabs.filter(t => t.index > curTab.index).map(t => t.id);
  },
  54: () => {
    const byUrl = {};
    for (const t of tabs) (byUrl[t.url] = byUrl[t.url] || []).push(t);
    const closers = [];
    for (const cluster of Object.values(byUrl).filter(v => v.length > 1)) {
      const sorted = [...cluster].sort(byIndexAsc);
      closers.push(...sorted.slice(1).map(t => t.id));
    }
    return closers;
  },
  56: () => {
    const byUrl = {};
    for (const t of tabs) (byUrl[t.url] = byUrl[t.url] || []).push(t);
    for (const cluster of Object.values(byUrl).filter(v => v.length > 1)) {
      if (cluster.every(t => /amazon.*interview|interview.*amazon/i.test(title(t)))) {
        return [...cluster].sort(byIndexAsc).slice(1).map(t => t.id);
      }
    }
    return [];
  },
  59: () => {
    const byUrl = {};
    for (const t of tabs) (byUrl[t.url] = byUrl[t.url] || []).push(t);
    for (const cluster of Object.values(byUrl).filter(v => v.length > 1)) {
      if (cluster.every(t => /hermes/i.test(title(t)) || /hermes/i.test(t.url))) {
        return [...cluster].sort(byIndexAsc).slice(1).map(t => t.id);
      }
    }
    return [];
  },
  60: () => {
    const target = '9WIsvEswZTk'; // video id stated in command context; verified below against titles
    const ytCluster = tabs.filter(t => { try { return new URL(t.url).searchParams.get('v') === target; } catch (e) { return false; } });
    const keep = [...ytCluster].sort(byIndexAsc)[0];
    console.log('  #60 cluster:', ytCluster.map(t => t.id + ' idx' + t.index).join(','));
    console.log('  #60 titles:', ytCluster.map(t => JSON.stringify(title(t)) + ' @' + t.url).join('\n             '));
    return ytCluster.filter(t => t.id !== keep.id).map(t => t.id);
  },
  74: () => titleContains(/backend|microservices|kafka/i),
  89: () => tabs.filter(t => /(^|\.)youtube\.com$/.test(host(t) || '') && pathname(t.url) === '/results').map(t => t.id),
  96: () => tabs.filter(t => registrable(t.url) === 'github.com').sort(byIndexAsc).slice(0, 10).map(t => t.id),
};

for (const i of SAMPLE_IDX) {
  check('sample#' + i + ' "' + CMDS[i].command + '"', deriv[i](), CMDS[i]);
}

// ---------- report ----------
let fails = 0;
for (const r of results) {
  if (r.ok) console.log('PASS', r.name, '(gold n=' + r.goldN + ')');
  else {
    fails++;
    console.log('FAIL', r.name, 'gold n=' + r.goldN, 'derived n=' + r.derivedN);
    if (r.missing.length) console.log('   missing-from-derived (in gold, not derived):', r.missing.join(','));
    if (r.extra.length) console.log('   extra-in-derived (derived, not gold):', r.extra.join(','));
  }
}
console.log(fails === 0 ? '\n>>> ALL 15 RE-DERIVATIONS MATCH GOLD EXACTLY' : '\n>>> ' + fails + ' MISMATCH(ES)');
