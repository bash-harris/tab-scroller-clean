// bench/cosine-vs-nli.js
// Do we need the NLI model at all?
//
// WHY THIS EXISTS
// Bundling the SIMD wasm did NOT fix per-pass cost: 1495ms -> 1423ms in a real
// browser, with simd=true and wasmPaths confirmed in the log. So the config
// hypothesis is dead, and with it the idea that NLI can ever scan a 453-tab
// window: at 1423ms/pass that is 10.7 MINUTES. No cap, budget, or shortlist
// makes that number acceptable -- they only hide it by scanning less, which is
// exactly the truncation that made LeetCode and Codeforces disappear.
//
// So the question is not "how do we make NLI fast enough". It is "what can score
// EVERY tab for free". There is an obvious candidate already in the codebase:
// every card carries a 384-dim MiniLM embedding computed at index time
// (command-agent.js:450 already does cosineSim against it). Embedding the query
// is ONE forward pass total -- not one per tab -- and cosine over 453 stored
// vectors is arithmetic, microseconds, no model involved.
//
// That is O(1) model calls per command instead of O(tabs). If it is accurate
// enough, the entire latency problem disappears and no cap is needed anywhere.
//
// This measures exactly that, against the same 112-command gold set and the same
// short-circuits (select_all, domain) the NLI path uses, so the numbers are
// directly comparable to NLI's 100/112.
//
//   node bench/cosine-vs-nli.js

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
  const vec = async (s) => Array.from(
    (await embed(s, { pooling: 'mean', normalize: true })).data);

  // Tab vectors: computed once, exactly as the indexer would.
  const tabVecs = new Map();
  for (const c of candidates) tabVecs.set(c.tabId, await vec(NliSelect.tabText(c)));

  // Concept vectors: one per unique concept across the whole gold set. In the
  // extension this is ONE embed call per command, cacheable by concept.
  const conceptVecs = new Map();
  for (const c of CMDS) {
    const q = qcache[LlmQuery.normalizeCommand(c.command)];
    for (const con of (q?.concepts || [])) {
      if (!conceptVecs.has(con)) conceptVecs.set(con, await vec(con));
    }
  }

  console.log('\nCOSINE-ONLY SELECTION vs NLI  (112 commands, 15-tab pool)');
  console.log('Every tab scored with ZERO per-tab model calls.');
  console.log('='.repeat(66));
  console.log('  thresh   set-exact   prec  recall  violations');
  console.log('-'.repeat(66));

  let best = null;
  for (const th of [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]) {
    let exact = 0, pSum = 0, rSum = 0, viol = 0;
    for (const c of CMDS) {
      const q = qcache[LlmQuery.normalizeCommand(c.command)] || {};
      const det = self.ConceptCore.parseCommand(c.command);
      let got;

      // Same short-circuits as nli-select.js, so this is apples-to-apples.
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
          if (concepts.length) {
            for (const x of candidates) {
              let s = 0;
              for (const con of concepts) {
                const cv = conceptVecs.get(con);
                if (cv) s = Math.max(s, cos(cv, tabVecs.get(x.tabId)));
              }
              if (s >= th) got.add(x.tabId);
            }
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
    const row = { th, exact, p: 100 * pSum / n, r: 100 * rSum / n, viol };
    if (!best || exact > best.exact) best = row;
    console.log(`   ${th.toFixed(2)}   ${String(exact + '/' + n).padStart(7)}   ` +
      `${row.p.toFixed(0).padStart(3)}%   ${row.r.toFixed(0).padStart(3)}%   ${String(viol).padStart(6)}`);
  }

  console.log('-'.repeat(66));
  console.log(`  NLI  (1423ms/tab)   100/112    92%    95%        3`);
  console.log(`  best cosine         ${best.exact}/112    ${best.p.toFixed(0)}%    ${best.r.toFixed(0)}%        ${best.viol}   @ ${best.th}`);
  console.log(`\n  Cosine cost: 1 embed call per command, then arithmetic.`);
  console.log(`  NLI cost:    1 model call per TAB. 453 tabs x 1423ms = 10.7 min.\n`);
})().catch(e => { console.error(e); process.exit(1); });
