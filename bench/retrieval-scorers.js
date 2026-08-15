// bench/retrieval-scorers.js
// Ranking functions for retrieval-bench.js. Each returns the FULL pool ranked,
// [{tab, score}, ...] descending -- the bench takes the top K itself, so a
// scorer never decides "no answer". That decision belongs to the reranker.

const STOPWORDS = new Set([
  'about', 'related', 'with', 'and', 'all', 'tabs', 'the', 'group', 'close',
  'that', 'this', 'them', 'have', 'for', 'open', 'any', 'every', 'not', 'also',
  'their', 'these', 'those', 'into', 'from', 'which', 'what', 'please', 'now'
]);

function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

// ---------------------------------------------------------------------------
// V1 -- mirrors command-agent.js retrieveCandidates exactly, minus the parts
// that need IndexedDB. Two defects are reproduced deliberately:
//   `if (kw > score) score = kw`   a full keyword hit pins the score to 1.0
//   `score += 0.4`                 flat, so every category member lands on 1.40
// ---------------------------------------------------------------------------
function scoreV1Retrieval(cmd, pool, qVec, vecs) {
  const rows = pool.map((t, i) => {
    let score = cosine(qVec, vecs[i]);
    const hay = `${t.title} ${t.url} ${t.category} ${(t.tags || []).join(' ')}`.toLowerCase();
    const tokens = cmd.toLowerCase().split(/\s+/).filter(x => x.length > 2 && !STOPWORDS.has(x));
    let kw = 0;
    if (tokens.length) {
      let hits = 0;
      for (const tok of tokens) if (hay.includes(tok)) hits++;
      kw = hits / tokens.length;
    }
    if (kw > score) score = kw;

    const cat = (t.category || '').toLowerCase();
    const tags = (t.tags || []).map(x => x.toLowerCase());
    const words = cmd.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
    for (const w of words) {
      if (cat === w || cat.includes(w) || tags.some(x => x === w || x.includes(w))) { score += 0.4; break; }
    }
    return { tab: t, score };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

// ---------------------------------------------------------------------------
// V3 -- proposed. Same inputs, same cost, no new model. The goal is NOT to be
// selective: it is to rank so the reranker can do its job. So, unlike V2 in
// command-bench.js, there is no cutoff and no empty answer -- V2 traded 36
// points of recall for precision it was never asked to provide.
//
// Four changes against V1:
//   1. signals are BLENDED with weights, never max()'d or flat-added, so a
//      single term cannot pin the score to a constant. This is what breaks the
//      1.40 pile-up: two tabs now differ by their cosine even when both are
//      full category matches.
//   2. word-boundary matching, so "sports" no longer contains "port" and
//      "test-match" no longer matches the token "tes".
//   3. the category signal is GRADED by how much of the command it explains,
//      rather than a flat +0.4 awarded on first hit and then `break`.
//   4. an explicit epsilon tie-break on cosine, so equal-evidence tabs still
//      arrive in a meaningful order instead of IndexedDB insertion order.
// ---------------------------------------------------------------------------
function scoreV3Retrieval(cmd, pool, qVec, vecs) {
  const cmdLower = cmd.toLowerCase();
  const words = cmdLower.split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));

  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match on a word boundary that also treats '-' as a separator, so the tag
  // "test-match" is two matchable words rather than one opaque token.
  const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`, 'i');

  const rows = pool.map((t, i) => {
    const vec = cosine(qVec, vecs[i]);

    const title = (t.title || '').toLowerCase();
    const cat = (t.category || '').toLowerCase();
    const tags = (t.tags || []).map(x => x.toLowerCase()).join(' ');
    const url = (t.url || '').toLowerCase();

    // Lexical evidence, split by field so a title hit outranks a URL hit.
    let titleHits = 0, catHits = 0, urlHits = 0;
    for (const w of words) {
      if (wordRe(w).test(title)) titleHits++;
      if (wordRe(w).test(cat) || wordRe(w).test(tags)) catHits++;
      if (url.includes(w)) urlHits++;
    }
    const n = words.length || 1;
    const lex = titleHits / n;
    const catScore = catHits / n;   // graded, not a flat +0.4
    const urlScore = urlHits / n;

    // Exact domain match is hard evidence, not fuzzy similarity.
    let dom = 0;
    for (const w of words) {
      if (/\w\.\w/.test(w)) {
        const host = ((url.match(/\/\/([^/]+)/) || [])[1] || '');
        const bare = w.replace(/^www\./, '');
        if (host === bare || host.endsWith('.' + bare) || host.includes(bare)) dom = 1;
      }
    }

    // Weighted blend. Weights sum below the domain bonus so an exact domain hit
    // always outranks any amount of fuzzy evidence, which is the behaviour a
    // "close all youtube.com tabs" command needs.
    const score =
      0.45 * vec +
      0.25 * lex +
      0.20 * catScore +
      0.10 * urlScore +
      1.00 * dom +
      // epsilon on cosine: breaks exact ties without disturbing real ordering
      0.001 * vec;

    return { tab: t, score, vec, lex, catScore, dom };
  });

  rows.sort((a, b) => b.score - a.score || b.vec - a.vec);
  return rows;
}

module.exports = { scoreV1Retrieval, scoreV3Retrieval, STOPWORDS, cosine };
