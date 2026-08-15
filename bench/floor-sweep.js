// bench/floor-sweep.js
// Removing the absolute MIN_SCORE = 0.3 was forced: the new blended scores live
// on a different scale (a correct "sports" match now tops out at 0.164, so a 0.3
// floor would reject every right answer). But dropping the floor entirely means
// every command ships the full context budget -- ~55 tabs -- to the reranker,
// even when two tabs match.
//
// This sweeps a RELATIVE floor (keep score >= topScore * f) to find the largest
// f that costs no recall, so the shortlist shrinks without repeating V2's
// mistake of trading recall for a smaller list.
//
//   node bench/floor-sweep.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scoreV3Retrieval } = require('./retrieval-scorers');
const { parseCommand } = require('./concept');

const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '.embed-cache.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const emb = (t) => Float32Array.from(cache[sha(t)]);

const recs = fs.readFileSync(path.join(__dirname, 'commands.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const pool = recs.find(r => r._tabPool)._tabPool;
const cmds = recs.filter(r => r.command && !parseCommand(r.command).isSelectAll);
const vecs = pool.map(t => emb(`${t.title} ${t.url} ${t.category} ${(t.tags || []).join(' ')}`));

const CAP = 55; // what fitCandidatesToContext allows at num_ctx 8192

console.log('\nRELATIVE FLOOR SWEEP  (keep score >= top * f, then cap at ' + CAP + ')');
console.log('='.repeat(64));
console.log('     f   recall   avg shortlist   commands losing tabs');
console.log('-'.repeat(64));

for (const f of [0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]) {
  let recSum = 0, sizeSum = 0, lost = 0;
  const losers = [];
  for (const c of cmds) {
    const ranked = scoreV3Retrieval(c.command, pool, emb(c.command), vecs);
    const top = ranked.length ? ranked[0].score : 0;
    const kept = ranked.filter(r => r.score >= top * f).slice(0, CAP);
    const ids = kept.map(r => r.tab.id);
    const exp = c.expectedTabIds || [];
    const found = exp.filter(id => ids.includes(id)).length;
    const rec = exp.length ? found / exp.length : 1;
    recSum += rec; sizeSum += kept.length;
    if (rec < 1) { lost++; losers.push(c.command); }
  }
  const n = cmds.length;
  console.log(
    `  ${f.toFixed(2)}    ${(100 * recSum / n).toFixed(0).padStart(3)}%      ` +
    `${(sizeSum / n).toFixed(1).padStart(5)}         ${lost}` +
    (lost && f > 0 ? `  (${losers.slice(0, 2).map(s => `"${s}"`).join(', ')})` : '')
  );
}
console.log('');
