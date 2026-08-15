// bench/warmup-probe.js
// Is 1495ms/pass the steady-state cost, or is it one huge first pass averaged in?
//
// The browser log reported "12 passes in 17942ms = 1495ms/pass". That is a MEAN,
// and a mean over 12 samples hides its own outlier. ONNX Runtime does graph
// optimization and allocator warmup on the first inference, so pass #1 can cost
// many seconds while passes #2..N are cheap.
//
// This distinction decides the entire optimization plan:
//   - if warmup dominates  -> pay it ONCE at startup, per-command cost collapses
//   - if steady-state is slow -> the model/runtime itself must change
//
//   node bench/warmup-probe.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const N = require(path.join(__dirname, '..', 'nli-select.js'));
const { env, pipeline } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const cards = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

(async () => {
  const tLoad = Date.now();
  const zs = await pipeline('zero-shot-classification', N.MODEL_ID);
  const loadMs = Date.now() - tLoad;

  const texts = [];
  while (texts.length < 24) texts.push(...cards.map(c => N.tabText(c)));

  const per = [];
  for (let i = 0; i < 24; i++) {
    const t = Date.now();
    await zs(texts[i], ['programming'], {
      multi_label: true, hypothesis_template: 'This browser tab is about {}.'
    });
    per.push(Date.now() - t);
  }

  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\nWARMUP PROFILE  (native onnxruntime-node)`);
  console.log('='.repeat(58));
  console.log(`  pipeline load        ${loadMs}ms`);
  console.log(`  pass #1              ${per[0]}ms   <- includes graph warmup`);
  console.log(`  pass #2              ${per[1]}ms`);
  console.log(`  pass #3              ${per[2]}ms`);
  console.log(`  passes #4-24 mean    ${mean(per.slice(3)).toFixed(0)}ms  <- steady state`);
  console.log(`  naive mean of all    ${mean(per).toFixed(0)}ms`);
  console.log(`  warmup inflation     ${(mean(per) / mean(per.slice(3))).toFixed(2)}x on a 24-pass run`);
  console.log(`\n  On a 12-pass command the same inflation would be larger still,`);
  console.log(`  because the one expensive pass is divided among fewer cheap ones.\n`);
})().catch(e => { console.error(e); process.exit(1); });
