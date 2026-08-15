// bench/hybrid-bench.js
// Cosine scores every tab for one model call. NLI is accurate but costs one
// model call PER TAB. Neither alone is good enough:
//
//   cosine only   83/112 (74%)  -- covers all 453 tabs, but blunt
//   NLI only     100/112 (89%)  -- but 1423ms/tab means it can only see ~18
//
// The NLI number is a lie in production. 89% of the 18 tabs it managed to scan
// is not 89% of the browser; that is how LeetCode and Codeforces vanished while
// the log still claimed high confidence on everything it did look at.
//
// HYBRID: let cosine score everything (free, complete), then spend the NLI
// budget only where cosine is UNCERTAIN. Tabs cosine is confident about --
// clearly matching or clearly irrelevant -- do not need an expensive opinion.
// Only the ambiguous middle band gets a forward pass.
//
// This measures accuracy against NLI-passes-spent, so the tradeoff is explicit
// rather than assumed. The band edges are swept, not chosen.
//
//   node bench/hybrid-bench.js

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

function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }

(async () => {
  const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const zs = await NliSelect.load();
  const vec = async (s) => Array.from((await embed(s, { pooling: 'mean', normalize: true })).data);

  const tabVecs = new Map();
  for (const c of candidates) tabVecs.set(c.tabId, await vec(NliSelect.tabText(c)));

  const conceptVecs = new Map();
  for (const c of CMDS) {
    const q = qcache[LlmQuery.normalizeCommand(c.command)];
    for (const con of (q?.concepts || [])) {
      if (!conceptVecs.has(con)) conceptVecs.set(con, await vec(con));
    }
  }

  const nliCache = new Map();
  async function nliScore(text, concept) {
    const k = concept + '||' + text;
    if (nliCache.has(k)) return nliCache.get(k);
    const out = await zs(text, [concept], {
      multi_label: true, hypothesis_template: 'This browser tab is about {}.'
    });
    const s = Array.isArray(out.scores) ? out.scores[0] : 0;
    nliCache.set(k, s);
    return s;
  }

  // lo/hi define the UNCERTAIN band in cosine space. Below lo: reject without
  // asking. Above hi: accept without asking. Between: spend one NLI pass.
  async function run(lo, hi) {
    let exact = 0, pSum = 0, rSum = 0, viol = 0, passes = 0;
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
          for (const x of candidates) {
            let cs = 0;
            for (const con of concepts) {
              const cv = conceptVecs.get(con);
              if (cv) cs = Math.max(cs, cos(cv, tabVecs.get(x.tabId)));
            }
            if (cs >= hi) { got.add(x.tabId); continue; }   // confident yes, free
            if (cs < lo) continue;                          // confident no, free
            let ns = 0;                                     // uncertain -> ask NLI
            for (const con of concepts) {
              ns = Math.max(ns, await nliScore(NliSelect.tabText(x), con));
              passes++;
            }
            if (ns >= 0.55) got.add(x.tabId);
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
    return { exact, p: 100 * pSum / n, r: 100 * rSum / n, viol, passes: passes / n };
  }

  console.log('\nHYBRID: cosine scores all, NLI adjudicates only the uncertain band');
  console.log('='.repeat(74));
  console.log('   band        set-exact   prec  recall  viol   NLI passes/cmd   453-tab est');
  console.log('-'.repeat(74));

  const bands = [
    [0.20, 0.90], [0.20, 0.60], [0.20, 0.45], [0.20, 0.40],
    [0.25, 0.45], [0.25, 0.40], [0.30, 0.45]
  ];
  for (const [lo, hi] of bands) {
    const r = await run(lo, hi);
    // Fraction of the 15-tab pool that fell in-band, scaled to 453 tabs, at the
    // measured browser cost of 1423ms/pass.
    const frac = r.passes / candidates.length;
    const est = (frac * 453 * 1.423).toFixed(1);
    console.log(`  ${lo.toFixed(2)}-${hi.toFixed(2)}   ${String(r.exact + '/112').padStart(8)}   ` +
      `${r.p.toFixed(0).padStart(3)}%   ${r.r.toFixed(0).padStart(3)}%   ${String(r.viol).padStart(4)}   ` +
      `${r.passes.toFixed(1).padStart(12)}   ${est.padStart(8)}s`);
  }

  console.log('-'.repeat(74));
  console.log(`  cosine only     83/112    83%    93%     12            0.0        0.0s`);
  console.log(`  NLI only       100/112    92%    95%      3           15.0      644.0s  <- 10.7 min`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
