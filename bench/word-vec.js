// bench/word-vec.js
// Can WORD-LEVEL vector matching replace NLI entirely?
//
// THE IDEA
// The current cosine stage embeds the whole tab into ONE 384-dim vector and
// compares it to the concept. That averages everything together: a LeetCode
// problem page is "binary tree" AND "sign in" AND "cookie policy" AND nav junk,
// all smeared into one point. The signal gets diluted by the boilerplate.
//
// Instead: embed each WORD once, and score a tab by its best-matching word.
// "does any part of this page mean 'programming'" rather than "does the average
// of this page mean 'programming'".
//
// WHY NOT GloVe / word2vec / fastText
// They exist and they are genuinely pretrained word vector databases. But:
//   1. Context-free -- one vector per word forever, so "python" the snake and
//      "python" the language are the same point.
//   2. Wrong vector space -- they cannot be compared against MiniLM query
//      vectors, so adopting them means replacing BOTH sides with a weaker model.
//   3. Large -- GloVe 6B.300d is ~1GB for 400k words.
// Embedding the words with the MiniLM already in the extension avoids all three.
//
// WHY THIS IS CHEAP AT RUNTIME
// The vocabulary is shared and bounded. "programming" appears in 40 tabs and is
// embedded ONCE. A new tab mostly contains words already in the table, so its
// marginal cost approaches zero. Unlike NLI -- where cost is (tabs x concepts)
// forward passes EVERY command -- this is one embed per unseen word, ever.
//
// Scored against the same 112-command gold set as everything else, so the
// numbers are directly comparable to: cosine-whole-doc 83/112, NLI 100/112.
//
//   node bench/word-vec.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const { env, pipeline } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const qcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.llm-query-cache.json'), 'utf8'));
const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const CMDS = recs.filter(r => r.command);
const candidates = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

// Words carrying no topical signal. Embedding them wastes space and they can
// only add noise to a max().
const STOP = new Set(('a an the of in on at to for and or but is are was were be been ' +
  'this that these those it its with from by as if then than so out up down over under ' +
  'com www org net http https html php index page site home new my your our all more ' +
  'about into via per you we they he she i me us them').split(' '));

function words(text) {
  return [...new Set(
    text.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 3 && w.length <= 24 && !STOP.has(w) && !/^\d+$/.test(w))
  )];
}

function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }

(async () => {
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const vecCache = new Map();
  let embedCalls = 0;
  async function vec(s) {
    if (vecCache.has(s)) return vecCache.get(s);
    const v = Array.from((await embedder(s, { pooling: 'mean', normalize: true })).data);
    vecCache.set(s, v);
    embedCalls++;
    return v;
  }

  // ---- Build the word table (this is the "vector DB", built once) ----------
  const tabWords = new Map();
  const vocab = new Set();
  for (const c of candidates) {
    const w = words(NliSelect.tabText(c));
    tabWords.set(c.tabId, w);
    w.forEach(x => vocab.add(x));
  }
  for (const w of vocab) await vec(w);
  const vocabEmbeds = embedCalls;

  // Whole-document vectors, for the baseline comparison.
  const docVec = new Map();
  for (const c of candidates) docVec.set(c.tabId, await vec(NliSelect.tabText(c)));

  console.log(`\nWORD-LEVEL vs WHOLE-DOCUMENT vector matching`);
  console.log('='.repeat(72));
  console.log(`  pool ${candidates.length} tabs -> ${vocab.size} unique words`);
  console.log(`  ${(vocab.size / candidates.length).toFixed(1)} words/tab, embedded ONCE and reused\n`);

  // ---- Scorers -------------------------------------------------------------
  // maxWord : best single word. Sharpest signal, most vulnerable to one fluke.
  // top3    : mean of the 3 best words. Needs corroboration, resists flukes.
  // wholeDoc: the current production behaviour, for reference.
  // hybrid  : maxWord + a weak pull from the whole doc, resists one fluke.
  const SCORERS = {
    wholeDoc: (qv, c) => cos(qv, docVec.get(c.tabId)),
    maxWord: (qv, c) => {
      let best = 0;
      for (const w of tabWords.get(c.tabId)) {
        const s = cos(qv, vecCache.get(w));
        if (s > best) best = s;
      }
      return best;
    },
    top3: (qv, c) => {
      const ss = tabWords.get(c.tabId).map(w => cos(qv, vecCache.get(w))).sort((a, b) => b - a);
      if (!ss.length) return 0;
      return ss.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, ss.length);
    },
    hybrid: (qv, c) => {
      let best = 0;
      for (const w of tabWords.get(c.tabId)) {
        const s = cos(qv, vecCache.get(w));
        if (s > best) best = s;
      }
      return 0.7 * best + 0.3 * cos(qv, docVec.get(c.tabId));
    }
  };

  async function run(scorer, th) {
    let exact = 0, pSum = 0, rSum = 0, viol = 0;
    for (const c of CMDS) {
      const q = qcache[LlmQuery.normalizeCommand(c.command)] || {};
      const det = self.ConceptCore.parseCommand(c.command);
      let got;

      if (q.isSelectAll ?? det.isSelectAll) {
        got = new Set(candidates.map(x => x.tabId));
      } else {
        const domains = (q.domains?.length ? q.domains : det.domains) || [];
        if (domains.length) {
          got = new Set(candidates.filter(x => {
            const h = hostOf(x.url) || (x.domain || '').toLowerCase();
            return domains.some(d => { const b = d.replace(/^www\./, ''); return h === b || h.endsWith('.' + b) || h.includes(b); });
          }).map(x => x.tabId));
        } else {
          const concepts = q.concepts?.length ? q.concepts : (det.concept ? [det.concept] : []);
          got = new Set();
          for (const con of concepts) {
            const qv = await vec(con);
            for (const x of candidates) if (scorer(qv, x) >= th) got.add(x.tabId);
          }
        }
      }

      const exp = new Set(c.expectedTabIds || []);
      const tp = [...got].filter(i => exp.has(i)).length;
      pSum += got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
      rSum += exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
      if (got.size === exp.size && [...exp].every(i => got.has(i))) exact++;
      viol += (c.mustNotSelect || []).filter(i => got.has(i)).length;
    }
    const n = CMDS.length;
    return { exact, p: 100 * pSum / n, r: 100 * rSum / n, viol };
  }

  for (const [name, scorer] of Object.entries(SCORERS)) {
    console.log(`  ${name}`);
    console.log('  ' + '-'.repeat(58));
    let best = null;
    for (const th of [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]) {
      const r = await run(scorer, th);
      if (!best || r.exact > best.exact) best = { ...r, th };
      console.log(`    th=${th.toFixed(2)}   ${String(r.exact + '/112').padStart(8)}   ` +
        `prec ${r.p.toFixed(0).padStart(3)}%   rec ${r.r.toFixed(0).padStart(3)}%   viol ${r.viol}`);
    }
    console.log(`    BEST  ${best.exact}/112 (${(100 * best.exact / CMDS.length).toFixed(0)}%) @ th=${best.th}\n`);
  }

  console.log('  ' + '='.repeat(58));
  console.log(`  reference:  NLI cross-encoder   100/112 (89%)  ~1537ms per tab`);
  console.log(`  reference:  whole-doc cosine     83/112 (74%)  0 model calls`);
  console.log(`\n  vocabulary embeds: ${vocabEmbeds} (one-time, cached forever)`);
  console.log(`  query cost: 1 embed per concept, then pure arithmetic\n`);
})().catch(e => { console.error(e); process.exit(1); });
