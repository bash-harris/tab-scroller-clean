// bench/retrieval-bench.js
// Scores retrieveCandidates AS A RETRIEVAL STAGE, which is what it actually is:
// it hands a shortlist to a reranker (LLM today, NLI next), so its job is to put
// every expected tab somewhere in the top K with an ORDERING the reranker can use.
//
// This is why command-bench.js's set-exact is the wrong metric here, and why V2
// scored well on it while being unshippable: V2's relative cutoff returned []
// on 12/25 commands. A retrieval stage that returns nothing has lost the answer
// permanently -- no reranker can recover it. Recall is the constraint; precision
// is the reranker's problem.
//
//   recall@K   fraction of expected tabs present in the top K. THE metric.
//   ties@1     candidates tied at the top score. The 1.40-saturation bug: when
//              this is high the ranking carries no information and the reranker
//              picks blind off insertion order.
//   MRR        mean reciprocal rank of the first expected tab
//   shortlist  mean number of candidates handed downstream (cost)
//
//   node bench/retrieval-bench.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scoreV1Retrieval, scoreV3Retrieval } = require('./retrieval-scorers');

const CACHE = path.join(__dirname, '.embed-cache.json');
const K = 10;

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function tabText(t) { return `${t.title} ${t.url} ${t.category} ${(t.tags || []).join(' ')}`; }
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

async function getEmbedder(cache) {
  let extractor = null;
  return async function embed(text) {
    const key = sha(text);
    if (cache[key]) return Float32Array.from(cache[key]);
    if (!extractor) {
      const { pipeline, env } = require('@xenova/transformers');
      env.cacheDir = path.join(__dirname, '.model-cache');
      extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    cache[key] = vec;
    return Float32Array.from(vec);
  };
}

// Select-all commands ("reload everything") name no concept at all. Ranking is
// the wrong tool for them and both arms fail them identically, so scoring them
// here would just add a constant to both and hide the ranking difference. They
// are short-circuited upstream by parseCommand().isSelectAll and reported apart.
function evaluate(name, scorer, pool, cmds, qVecs, vecs, Ks) {
  const recSums = new Map(Ks.map(k => [k, 0]));
  let tieSum = 0, mrrSum = 0, n = 0;
  const failures = [];

  for (const c of cmds) {
    const ranked = scorer(c.command, pool, qVecs[c.command], vecs);
    const exp = c.expectedTabIds || [];

    for (const k of Ks) {
      const ids = ranked.slice(0, k).map(r => r.tab.id);
      const found = exp.filter(id => ids.includes(id)).length;
      recSums.set(k, recSums.get(k) + (exp.length ? found / exp.length : 1));
    }

    const top = ranked.length ? ranked[0].score : 0;
    tieSum += ranked.filter(r => Math.abs(r.score - top) < 1e-9).length;

    const firstHit = ranked.findIndex(r => exp.includes(r.tab.id)) + 1;
    mrrSum += exp.length ? (firstHit > 0 ? 1 / firstHit : 0) : 1;
    n++;

    const idsK = ranked.slice(0, K).map(r => r.tab.id);
    const missing = exp.filter(id => !idsK.includes(id));
    if (missing.length) failures.push({ cmd: c.command, missing });
  }
  const recall = new Map([...recSums].map(([k, v]) => [k, v / n]));
  return { name, n, recall, ties: tieSum / n, mrr: mrrSum / n, lost: failures.length, failures };
}

function report(r, Ks) {
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`\n${r.name}`);
  console.log('-'.repeat(58));
  for (const k of Ks) console.log(`  recall@${String(k).padEnd(2)}        ${pct(r.recall.get(k))}`);
  console.log(`  commands losing  ${r.lost}/${r.n} tabs before the reranker sees them`);
  console.log(`  MRR              ${r.mrr.toFixed(3)}`);
  console.log(`  ties at #1       ${r.ties.toFixed(1)} avg`);
}

(async () => {
  // Gold set defaults to commands.jsonl; pass a path to score a different one.
  //   node bench/retrieval-bench.js bench/commands-v2.jsonl
  const CMD_FILE = process.argv[2] || path.join(__dirname, 'commands.jsonl');
  const recs = fs.readFileSync(CMD_FILE, 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
  const pool = recs.find(r => r._tabPool)._tabPool;
  const all = recs.filter(r => r.command);

  const { parseCommand } = require('./concept');
  const selectAll = all.filter(c => parseCommand(c.command).isSelectAll);
  const cmds = all.filter(c => !parseCommand(c.command).isSelectAll);

  const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
  const embed = await getEmbedder(cache);
  const vecs = [];
  for (const t of pool) vecs.push(await embed(tabText(t)));
  const qVecs = {};
  for (const c of cmds) qVecs[c.command] = await embed(c.command);
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const Ks = [3, 5, 10];
  console.log(`\nRETRIEVAL BENCH  --  ${cmds.length} ranked commands, ${pool.length}-tab pool`);
  console.log(`(${selectAll.length} select-all commands excluded: ${selectAll.map(c => `"${c.command}"`).join(', ')}`);
  console.log(` -- they name no concept and are short-circuited by isSelectAll, not ranked)`);
  console.log('='.repeat(58));

  const results = [
    evaluate('V1  (currently shipping)', scoreV1Retrieval, pool, cmds, qVecs, vecs, Ks),
    evaluate('V3  (proposed retrieval)', scoreV3Retrieval, pool, cmds, qVecs, vecs, Ks)
  ];
  results.forEach(r => report(r, Ks));

  for (const r of results) {
    if (!r.failures.length) continue;
    console.log(`\n  tabs lost by ${r.name}:`);
    for (const f of r.failures.slice(0, 8)) {
      console.log(`   "${f.cmd}"  missing [${f.missing}]`);
    }
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
