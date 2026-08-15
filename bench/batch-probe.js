// bench/batch-probe.js
// The zero-shot pipeline in transformers.js scores ONE premise per forward pass:
//
//     for (const premise of texts) { for (const hypothesis of hypotheses) {
//         const inputs = this.tokenizer(premise, { text_pair: hypothesis, ... })
//         const outputs = await this.model(inputs)          // <- one call per tab
//
// Passing it an array of tabs does not batch; it loops. So a 30-candidate command
// issues 30+ separate ONNX invocations, each paying fixed per-call overhead. In
// WASM single-thread that overhead is most of the cost.
//
// This measures whether padding the candidates into ONE batched forward pass is
// faster, and asserts the batched scores match the sequential ones.
//
//   node bench/batch-probe.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const N = require(path.join(__dirname, '..', 'nli-select.js'));
const { env, AutoTokenizer, AutoModelForSequenceClassification, softmax } =
  require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const cards = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

const HYP = 'This browser tab is about gaming.';

(async () => {
  const tokenizer = await AutoTokenizer.from_pretrained(N.MODEL_ID);
  const model = await AutoModelForSequenceClassification.from_pretrained(N.MODEL_ID);
  const l2i = Object.fromEntries(
    Object.entries(model.config.label2id).map(([k, v]) => [k.toLowerCase(), v]));
  const E = l2i['entailment'], C = l2i['contradiction'] ?? l2i['not_entailment'];

  // A real command sees ~30 candidates; the pool is 15, so duplicate to 30.
  const all = [];
  while (all.length < 30) all.push(...cards.map(c => N.tabText(c)));
  const prem = all.slice(0, 30);

  let t = Date.now();
  const seqScores = [];
  for (const p of prem) {
    const i = tokenizer(p, { text_pair: HYP, padding: true, truncation: true });
    const o = await model(i);
    seqScores.push(softmax([o.logits.data[C], o.logits.data[E]])[1]);
  }
  const seq = Date.now() - t;

  const rows = [];
  let batchScores = null;
  for (const B of [30, 15, 8]) {
    t = Date.now();
    const got = [];
    for (let s = 0; s < prem.length; s += B) {
      const chunk = prem.slice(s, s + B);
      const i = tokenizer(chunk, { text_pair: chunk.map(() => HYP), padding: true, truncation: true });
      const o = await model(i);
      const d = o.logits.dims;
      for (let r = 0; r < d[0]; r++) {
        got.push(softmax([o.logits.data[r * d[1] + C], o.logits.data[r * d[1] + E]])[1]);
      }
    }
    rows.push([B, Date.now() - t]);
    if (B === 30) batchScores = got;
  }

  console.log('\nBATCHED vs SEQUENTIAL  (30 candidates, 1 hypothesis)');
  console.log('='.repeat(56));
  console.log(`  sequential   ${String(seq).padStart(5)}ms   ${(seq / 30).toFixed(1)}ms/tab`);
  for (const [B, el] of rows) {
    console.log(`  batch=${String(B).padStart(2)}     ${String(el).padStart(5)}ms   ` +
      `${(el / 30).toFixed(1)}ms/tab   ${(seq / el).toFixed(1)}x faster`);
  }

  const maxDelta = Math.max(...batchScores.map((s, i) => Math.abs(s - seqScores[i])));
  console.log(`\n  score agreement: max delta ${maxDelta.toExponential(2)} ` +
    `${maxDelta < 1e-3 ? '-- batching is numerically safe' : '-- WARNING: padding changed scores'}`);
  console.log('');
  if (maxDelta >= 1e-3) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
