// bench/adaptive-bench.js
// The hybrid band (cosine 0.20-0.45 -> ask NLI) recovers full NLI accuracy at
// 1.9 passes/command on a 15-tab pool. But the band is a FRACTION of the corpus:
// on 453 tabs the same fraction is ~57 passes = 81s. Still too slow, and still
// scaling with tab count -- the thing that has to stop.
//
// The failure mode of every previous attempt was a hard constant: shortlist 30,
// then 12, then a 25s clock. All of them truncate an unsorted-by-relevance region
// and silently drop real matches (LeetCode, Codeforces), which is exactly what
// the user reported twice.
//
// The principled version has no constant. Two ideas:
//
// 1. RANK, DON'T THRESHOLD. Sort the uncertain band by cosine descending. NLI
//    then adjudicates the most-likely-uncertain tabs first, so if anything is
//    ever cut, it is the least likely to matter -- rather than whatever order
//    IndexedDB returned.
//
// 2. STOP WHEN IT STOPS MATTERING, not when a clock expires. Walk the ranked
//    band and track how many consecutive NLI verdicts came back negative. Once
//    the model has disagreed with cosine K times in a row, cosine's ordering has
//    stopped producing matches and the remaining tail is not worth paying for.
//    This is data-driven early exit: a dense band keeps going, a sparse one stops
//    immediately. Nothing is hardcoded to the corpus size or the clock.
//
// K itself is swept here rather than assumed.
//
//   node bench/adaptive-bench.js

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

  const LO = 0.20, HI = 0.45;

  async function run(patience) {
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
          const band = [];
          for (const x of candidates) {
            let cs = 0;
            for (const con of concepts) {
              const cv = conceptVecs.get(con);
              if (cv) cs = Math.max(cs, cos(cv, tabVecs.get(x.tabId)));
            }
            if (cs >= HI) { got.add(x.tabId); continue; }
            if (cs < LO) continue;
            band.push({ x, cs });
          }
          // Most-promising first, so an early exit sheds the least likely tail.
          band.sort((a, b) => b.cs - a.cs);
          let misses = 0;
          for (const { x } of band) {
            if (patience && misses >= patience) break;
            let ns = 0;
            for (const con of concepts) {
              ns = Math.max(ns, await nliScore(NliSelect.tabText(x), con));
              passes++;
            }
            if (ns >= 0.55) { got.add(x.tabId); misses = 0; }
            else misses++;
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

  console.log('\nADAPTIVE EARLY EXIT  (band 0.20-0.45, ranked by cosine desc)');
  console.log('Stop after K consecutive NLI rejections -- no clock, no count cap.');
  console.log('='.repeat(72));
  console.log('  patience   set-exact   prec  recall  viol   passes/cmd   453-tab est');
  console.log('-'.repeat(72));

  for (const k of [1, 2, 3, 4, 0]) {
    const r = await run(k);
    const est = ((r.passes / candidates.length) * 453 * 1.423).toFixed(1);
    const label = k === 0 ? 'none' : String(k);
    console.log(`  ${label.padStart(8)}   ${String(r.exact + '/112').padStart(8)}   ` +
      `${r.p.toFixed(0).padStart(3)}%   ${r.r.toFixed(0).padStart(3)}%   ${String(r.viol).padStart(4)}   ` +
      `${r.passes.toFixed(1).padStart(10)}   ${est.padStart(8)}s`);
  }
  console.log('-'.repeat(72));
  console.log('  NLI only        100/112    92%    95%      3         15.0      644.0s\n');
})().catch(e => { console.error(e); process.exit(1); });
