// bench/command-bench.js
// Scores tab SELECTION against bench/commands.jsonl.
//
// Runs the real retrieval scorer over a frozen 15-tab pool with real MiniLM
// embeddings, and reports the metrics that matter for the product:
//
//   set-exact    selected set === expected set (the honest headline)
//   precision    of selected, how many were right
//   recall       of expected, how many were found
//   violations   tabs listed in mustNotSelect that were selected anyway
//   saturation   how many candidates tie at the top score (ranking is dead
//                when this is high -- the LLM then picks blind)
//
//   node bench/command-bench.js            current scorer
//   node bench/command-bench.js --v2       proposed scorer
//   node bench/command-bench.js --compare  both, side by side
//
// Embeddings cached in bench/.embed-cache.json, so repeat runs need no model.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE = path.join(__dirname, '.embed-cache.json');
const STOPWORDS = new Set([
  'about', 'related', 'with', 'and', 'all', 'tabs', 'the', 'group', 'close',
  'that', 'this', 'them', 'have', 'for', 'open', 'any', 'every', 'not', 'also',
  'their', 'these', 'those', 'into', 'from', 'which', 'what', 'please', 'now'
]);

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }

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

function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

function tabText(t) {
  return `${t.title} ${t.url} ${t.category} ${(t.tags || []).join(' ')}`;
}

// ---------------------------------------------------------------------------
// V1 -- the scorer currently shipping in command-agent.js retrieveCandidates.
// Additive boosts on top of a cosine, then "return everything >= 0.3".
// ---------------------------------------------------------------------------
function scoreV1(cmd, tab, qVec, tVec) {
  let score = cosine(qVec, tVec);

  const tagText = (tab.tags || []).join(' ');
  const text = `${tab.title} ${tab.url} ${tab.category} ${tagText}`.toLowerCase();
  const tokens = cmd.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
  let keywordScore = 0;
  if (tokens.length) {
    let hits = 0;
    for (const tok of tokens) if (text.includes(tok)) hits++;
    keywordScore = hits / tokens.length;
  }
  if (keywordScore > score) score = keywordScore;

  // category-match boost: substring, unbounded
  const cardCategory = (tab.category || '').toLowerCase();
  const cardTags = (tab.tags || []).map(t => t.toLowerCase());
  const cmdWords = cmd.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
  for (const w of cmdWords) {
    if (cardCategory === w || cardCategory.includes(w) || cardTags.some(t => t === w || t.includes(w))) {
      score += 0.4;
      break;
    }
  }
  return score;
}

function selectV1(cmd, pool, qVec, vecs) {
  const scored = pool.map((t, i) => ({ tab: t, score: scoreV1(cmd, t, qVec, vecs[i]) }));
  scored.sort((a, b) => b.score - a.score);
  const qualified = scored.filter(s => s.score >= 0.3);
  // the floor-bypass: if fewer than 5 qualify, hand over the top 5 anyway
  const result = qualified.length >= 5 ? qualified : scored.slice(0, 5);
  return { selected: result.map(s => s.tab.id), scored };
}

// ---------------------------------------------------------------------------
// V2 -- proposed. Same inputs, no new model. Four changes:
//   1. rank-fusion instead of additive boosts, so no term can saturate
//   2. word-boundary category match (kills "port" in "sports")
//   3. relative cutoff against the top score, so a weak field returns few
//   4. no floor-bypass: zero matches is a legal answer
// ---------------------------------------------------------------------------
function selectV2(cmd, pool, qVec, vecs) {
  const cmdLower = cmd.toLowerCase();
  const cmdWords = cmdLower.split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));

  const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');

  const rows = pool.map((t, i) => {
    const vec = cosine(qVec, vecs[i]);

    const hay = `${t.title} ${t.category} ${(t.tags || []).join(' ')}`.toLowerCase();
    let lex = 0;
    for (const w of cmdWords) if (wordRe(w).test(hay)) lex++;
    lex = cmdWords.length ? lex / cmdWords.length : 0;

    // domain match is a separate, precise signal
    let dom = 0;
    for (const w of cmdWords) {
      if (/\./.test(w) && t.url.toLowerCase().includes(w.replace(/^www\./, ''))) dom = 1;
    }
    return { tab: t, vec, lex, dom };
  });

  // Reciprocal-rank fusion over the three signals: scale-free, so a single
  // signal cannot dominate the way the +0.4 additive boost did.
  const rankOf = (key) => {
    const order = [...rows].sort((a, b) => b[key] - a[key]);
    const m = new Map();
    order.forEach((r, i) => m.set(r.tab.id, i + 1));
    return m;
  };
  const rv = rankOf('vec'), rl = rankOf('lex'), rd = rankOf('dom');
  const K = 10;
  for (const r of rows) {
    r.score = 1 / (K + rv.get(r.tab.id)) + 1 / (K + rl.get(r.tab.id)) + 1 / (K + rd.get(r.tab.id));
    // hard evidence overrides fusion: exact domain hit, or a full lexical match
    if (r.dom === 1) r.score += 1;
    if (r.lex >= 0.99) r.score += 0.5;
  }
  rows.sort((a, b) => b.score - a.score);

  // Relative cutoff. If nothing is strong in absolute terms, return nothing.
  const top = rows[0];
  const strong = (r) => r.dom === 1 || r.lex >= 0.5 || r.vec >= 0.35;
  if (!top || !strong(top)) return { selected: [], scored: rows };

  const selected = rows.filter(r => strong(r) && r.score >= top.score * 0.72).map(r => r.tab.id);
  return { selected, scored: rows };
}

function evaluate(name, selectFn, pool, cmds, qVecs, vecs) {
  let exact = 0, precSum = 0, recSum = 0, violations = 0, satSum = 0, n = 0;
  const failures = [];

  for (const c of cmds) {
    const { selected, scored } = selectFn(c.command, pool, qVecs[c.command], vecs);
    const exp = new Set(c.expectedTabIds || []);
    const got = new Set(selected);

    const tp = [...got].filter(id => exp.has(id)).length;
    const precision = got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    const recall = exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
    const isExact = got.size === exp.size && [...exp].every(id => got.has(id));

    const viol = (c.mustNotSelect || []).filter(id => got.has(id)).length;

    // saturation: how many candidates tie within 1e-9 of the top score
    const topScore = scored.length ? scored[0].score : 0;
    const tied = scored.filter(s => Math.abs(s.score - topScore) < 1e-9).length;

    if (isExact) exact++;
    precSum += precision; recSum += recall; violations += viol; satSum += tied; n++;

    if (!isExact || viol) {
      failures.push({
        command: c.command,
        expected: [...exp].sort((a, b) => a - b),
        got: [...got].sort((a, b) => a - b),
        viol
      });
    }
  }

  return {
    name,
    exact, n,
    precision: precSum / n,
    recall: recSum / n,
    violations,
    saturation: satSum / n,
    failures
  };
}

function report(r) {
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`\n${r.name}`);
  console.log('-'.repeat(58));
  console.log(`  set-exact        ${r.exact}/${r.n} (${pct(r.exact / r.n)})`);
  console.log(`  precision        ${pct(r.precision)}`);
  console.log(`  recall           ${pct(r.recall)}`);
  console.log(`  mustNotSelect    ${r.violations} violation(s)`);
  console.log(`  top-score ties   ${r.saturation.toFixed(1)} avg candidates tied at #1`);
}

(async () => {
  const recs = fs.readFileSync(path.join(__dirname, 'commands.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
  const pool = recs.find(r => r._tabPool)._tabPool;
  const cmds = recs.filter(r => r.command);

  const cache = loadCache();
  const embed = await getEmbedder(cache);

  const vecs = [];
  for (const t of pool) vecs.push(await embed(tabText(t)));
  const qVecs = {};
  for (const c of cmds) qVecs[c.command] = await embed(c.command);
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  console.log(`\nCOMMAND BENCH  --  ${cmds.length} commands over a ${pool.length}-tab pool`);
  console.log('='.repeat(58));

  const wantV2 = process.argv.includes('--v2');
  const wantCompare = process.argv.includes('--compare');

  const results = [];
  if (!wantV2 || wantCompare) results.push(evaluate('V1  (currently shipping)', selectV1, pool, cmds, qVecs, vecs));
  if (wantV2 || wantCompare) results.push(evaluate('V2  (proposed)', selectV2, pool, cmds, qVecs, vecs));

  results.forEach(report);

  const last = results[results.length - 1];
  console.log(`\n  failures for ${last.name}:`);
  for (const f of last.failures.slice(0, 12)) {
    console.log(`   "${f.command}"`);
    console.log(`      expected [${f.expected}]  got [${f.got}]${f.viol ? `  ** ${f.viol} FORBIDDEN **` : ''}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
