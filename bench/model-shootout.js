// bench/model-shootout.js
// WHY THE SIMD FIX DIDN'T WORK, AND WHAT ACTUALLY WILL
//
// Bundling ort-wasm-simd.wasm moved the browser from 1495ms/pass to 1423ms/pass.
// Confirmed live: simd=true, wasmPaths correct. So the config was genuinely
// broken AND fixing it bought ~5%. The bottleneck is elsewhere.
//
// Inspecting the ONNX graph of nli-deberta-v3-xsmall's "quantized" model:
//
//     MatMulInteger            74     <- quantized (int8)
//     DynamicQuantizeLinear    50
//     MatMul                 1970     <- NOT quantized (fp32)
//
// It is only ~4% quantized by op count. Worse, DeBERTa-v3's disentangled
// attention builds those 1970 fp32 MatMuls into the attention math itself, and
// MatMulInteger has no SIMD kernel in onnxruntime-web 1.14 -- so the SIMD binary
// literally cannot accelerate the ops that dominate this graph. That is the
// whole explanation for "simd=true, no speedup".
//
// DeBERTa was the wrong architecture for a latency-bound browser workload, and
// no amount of configuration fixes an architecture choice. So: measure real
// alternatives on the SAME gold set rather than assume.
//
// Candidates, all zero-shot capable and all far smaller in effective compute:
//   - nli-deberta-v3-xsmall  (current baseline)
//   - bart-large-mnli        (the standard, likely too big -- included as a check)
//   - distilbert / MiniLM cross-encoders trained on MNLI
//
//   node bench/model-shootout.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const { env, pipeline } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const MODELS = [
  'Xenova/nli-deberta-v3-xsmall',
  'Xenova/mobilebert-uncased-mnli',
  'Xenova/distilbert-base-uncased-mnli',
  'Xenova/bart-large-mnli'
];

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

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }

// Count quantized vs float matmuls in whatever onnx file got cached.
function graphProfile(modelId) {
  const dir = path.join(__dirname, '.model-cache', ...modelId.split('/'), 'onnx');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find(x => x.endsWith('.onnx'));
  if (!f) return null;
  const b = fs.readFileSync(path.join(dir, f));
  const count = (s) => { let n = 0, i = 0; const t = Buffer.from(s); while ((i = b.indexOf(t, i)) !== -1) { n++; i++; } return n; };
  return { mb: +(b.length / 1048576).toFixed(1), int8: count('MatMulInteger'), fp32: count('MatMul') - count('MatMulInteger') };
}

(async () => {
  console.log('\nMODEL SHOOTOUT  (112 commands, 15-tab pool, same query parses)');
  console.log('='.repeat(86));
  console.log('  model                          set-exact  prec recall viol   ms/pass   MB   int8/fp32');
  console.log('-'.repeat(86));

  for (const id of MODELS) {
    let zs;
    try {
      zs = await pipeline('zero-shot-classification', id);
    } catch (e) {
      console.log(`  ${id.replace('Xenova/', '').padEnd(30)} UNAVAILABLE (${e.message.slice(0, 30)})`);
      continue;
    }

    const cache = new Map();
    let exact = 0, pSum = 0, rSum = 0, viol = 0, passes = 0, totalMs = 0;

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
            let best = 0;
            for (const con of concepts) {
              const key = con + '||' + x.tabId;
              let s = cache.get(key);
              if (s === undefined) {
                const t = Date.now();
                const out = await zs(NliSelect.tabText(x), [con], {
                  multi_label: true, hypothesis_template: 'This browser tab is about {}.'
                });
                totalMs += Date.now() - t; passes++;
                s = Array.isArray(out.scores) ? out.scores[0] : 0;
                cache.set(key, s);
              }
              if (s > best) best = s;
            }
            if (best >= 0.55) got.add(x.tabId);
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
    const g = graphProfile(id) || { mb: 0, int8: 0, fp32: 0 };
    console.log(`  ${id.replace('Xenova/', '').padEnd(30)} ${String(exact + '/112').padStart(8)}  ` +
      `${(100 * pSum / n).toFixed(0).padStart(4)}% ${(100 * rSum / n).toFixed(0).padStart(5)}% ${String(viol).padStart(4)}   ` +
      `${(totalMs / passes).toFixed(1).padStart(7)}   ${String(g.mb).padStart(5)}   ${g.int8}/${g.fp32}`);
  }

  console.log('-'.repeat(86));
  console.log('  ms/pass is NATIVE onnxruntime-node. The browser ran ~110x slower on');
  console.log('  deberta; a model whose graph is genuinely int8 should close much of');
  console.log('  that gap, because MatMulInteger is what WASM accelerates.\n');
})().catch(e => { console.error(e); process.exit(1); });
