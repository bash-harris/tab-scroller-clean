// multi-group-assign.js
// User-directed multi-group assignment: sort a fixed set of tabs into
// user-NAMED buckets ("group these into coding / entertainment / gardening").
//
// This is a DIFFERENT decision from NliSelect.select. select answers "does this
// tab match concept X?" one concept at a time against a threshold. Here the
// buckets are MUTUALLY EXCLUSIVE and every selected tab wants exactly one home,
// so the decision is ARGMAX ACROSS BUCKETS, not a per-concept cutoff.
//
// Two stages, mirroring select's cosine-then-NLI economy:
//
//   Stage 1 (free): embed each bucket once, cosine(tab, bucket) for every bucket.
//     The argmax bucket wins. If it beats the runner-up by a decisive MARGIN we
//     accept it with no model call -- the cheap cases are settled for free, same
//     principle as the cosine band in nli-select.js.
//
//   Stage 2 (NLI, only the ambiguous middle): for a tab whose top-two buckets are
//     too close to call by cosine -- or that has no embedding at all -- run ONE
//     zero-shot pass across ALL bucket labels with multi_label:false. false means
//     softmax ACROSS the labels: the buckets compete and the probabilities sum to
//     one, which is exactly right for "pick one bucket". (multi_label:true, which
//     select uses, scores each label independently -- wrong here, it would let a
//     tab win several buckets at once.)
//
// THE ONE BUG THIS MODULE EXISTS TO AVOID:
//   The transformers.js zero-shot pipeline returns { labels, scores } SORTED BY
//   SCORE DESCENDING. So out.scores[i] does NOT correspond to the input label i --
//   out.labels[0] is the winning label's NAME and out.scores[0] its score, but
//   index 0 of the OUTPUT is not bucket 0 of the INPUT. Reading scores[i] as
//   "bucket i's score" silently assigns tabs to the wrong bucket whenever the
//   argmax isn't input-index 0. We map every returned score back to its bucket BY
//   LABEL STRING, never by position. (Verified: nli-select.js inferZeroShot and
//   offscreen.js:148 both forward the full {labels,scores} object unchanged.)

(() => {
  // Local cosine so this module has no dependency on nli-select internals
  // (cosine is not exported there). Same formula.
  function cosine(a, b) {
    if (!a || !b) return 0;
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d ? dot / d : 0;
  }

  // The text that represents a bucket, used identically as the cosine embed input
  // AND the NLI candidate label -- so the label we send is the exact string we map
  // the returned score back through. "name: characteristic" keeps it unique across
  // buckets (names are user-supplied and distinct) while giving NLI the richer
  // characteristic to entail against. Falls back to whichever half is present.
  function bucketText(b) {
    const name = String((b && b.name) || '').trim();
    const ch = String((b && b.characteristic) || '').trim();
    if (name && ch) return `${name}: ${ch}`;
    return name || ch || 'group';
  }

  // Minimal premise builder for when the caller does not inject NliSelect.tabText
  // (e.g. offline tests). Production passes deps.tabText = NliSelect.tabText so the
  // premise is identical to the select path.
  function defaultTabText(card) {
    const title = String((card && card.title) || '').trim();
    let host = '';
    try { host = new URL(card.url).hostname.replace(/^www\./, ''); } catch { /* no url */ }
    return [title, host].filter(Boolean).join(' ').slice(0, 1800);
  }

  /**
   * Assign each card to exactly one of the named buckets (or to `unassigned`).
   *
   * @param {Object}   input
   * @param {Array}    input.buckets  [{ name, characteristic }]  (2..N; 1 => all in it)
   * @param {Array}    input.cards    candidate cards ({ tabId, title, url, embedding?, enrichment? })
   * @param {number}   [input.minConfidence=0]  winning score below this -> unassigned (0 = never)
   * @param {Object}   [deps]
   * @param {Function} [deps.embedFn]         async (text) -> Float32Array   (bucket embeddings)
   * @param {Function} [deps.inferZeroShot]   async (premise, labels[], options) -> { labels, scores }
   * @param {Function} [deps.tabText]         (card) -> premise string       (defaults to a minimal builder)
   * @param {number}   [deps.marginThreshold=0.06]  cosine top1-top2 gap that skips NLI
   * @param {string}   [deps.hypothesisTemplate]    NLI template, default matches the select path
   *
   * @returns {{ buckets:[{name,characteristic,index,tabIds}], unassigned:number[],
   *             perCard:[{tabId,bucketIndex,score,margin,via}], stats:Object }}
   */
  async function assignToBuckets(input, deps = {}) {
    const buckets = Array.isArray(input && input.buckets) ? input.buckets : [];
    const cards = Array.isArray(input && input.cards) ? input.cards : [];
    const minConfidence = Number.isFinite(input && input.minConfidence) ? input.minConfidence : 0;

    const embedFn = typeof deps.embedFn === 'function' ? deps.embedFn : null;
    const inferZeroShot = typeof deps.inferZeroShot === 'function' ? deps.inferZeroShot : null;
    const toText = typeof deps.tabText === 'function' ? deps.tabText : defaultTabText;
    // Provisional, NOT bench-calibrated: how much the best bucket must beat the
    // runner-up (in cosine) before we trust it without a model call. Lower => more
    // tabs go to NLI (safer, slower); higher => more decided for free (faster,
    // more misfiles on near-ties). Tune on a labelled multi-group set before
    // trusting the cosine fast path in production; surfaced in stats.minMargin so a
    // regression is visible rather than silent.
    const marginThreshold = Number.isFinite(deps.marginThreshold) ? deps.marginThreshold : 0.06;
    const hypothesisTemplate = deps.hypothesisTemplate || 'This browser tab is about {}.';

    const B = buckets.length;
    const bucketOut = buckets.map((b, i) => ({
      name: (b && b.name) || `Group ${i + 1}`,
      characteristic: (b && b.characteristic) || '',
      index: i,
      tabIds: [],
    }));

    // Degenerate arities: nothing to decide.
    if (B === 0) {
      return { buckets: bucketOut, unassigned: cards.map(c => c.tabId), perCard: cards.map(c => ({ tabId: c.tabId, bucketIndex: -1, score: 0, margin: null, via: 'unassigned' })), stats: emptyStats(cards.length) };
    }
    if (B === 1) {
      const perCard = cards.map(c => ({ tabId: c.tabId, bucketIndex: 0, score: 1, margin: null, via: 'single' }));
      bucketOut[0].tabIds = cards.map(c => c.tabId);
      return { buckets: bucketOut, unassigned: [], perCard, stats: { ...emptyStats(cards.length), cosineDecided: cards.length } };
    }

    const labels = buckets.map(bucketText);
    // label string -> input bucket index. First-wins if two buckets stringify
    // identically (shouldn't happen with distinct names, but never throw).
    const idxByLabel = new Map();
    labels.forEach((l, i) => { if (!idxByLabel.has(l)) idxByLabel.set(l, i); });

    // ---- Stage 1: embed buckets once, cosine argmax per card ----------------
    const bucketVecs = new Array(B).fill(null);
    let embedCalls = 0;
    if (embedFn) {
      for (let i = 0; i < B; i++) {
        try { const v = await embedFn(labels[i]); if (v && v.length) { bucketVecs[i] = v; embedCalls++; } }
        catch (e) { /* leave null; that bucket just can't win by cosine */ }
      }
    }
    const haveVecs = bucketVecs.some(v => v && v.length);

    const perCard = [];
    const ambiguous = [];
    for (const card of cards) {
      const cv = card && card.embedding && card.embedding.length ? card.embedding : null;
      let top1 = -Infinity, top2 = -Infinity, top1Idx = -1;
      if (cv && haveVecs) {
        for (let i = 0; i < B; i++) {
          const bv = bucketVecs[i];
          if (!bv || !bv.length) continue;
          const s = cosine(bv, cv);
          if (s > top1) { top2 = top1; top1 = s; top1Idx = i; }
          else if (s > top2) { top2 = s; }
        }
      }
      const margin = top1 === -Infinity ? null : (top2 === -Infinity ? top1 : top1 - top2);
      const rec = {
        tabId: card.tabId,
        bucketIndex: top1Idx,
        score: top1 === -Infinity ? 0 : top1,
        margin,
        via: 'cosine',
        _cosTop: top1Idx,
        _card: card,
      };
      perCard.push(rec);
      // Route to NLI when cosine can't decide: no clear winner, or the top two
      // buckets are within marginThreshold of each other.
      if (top1Idx < 0 || margin === null || margin < marginThreshold) {
        rec.via = 'pending';
        ambiguous.push(rec);
      }
    }

    // ---- Stage 2: NLI only for the ambiguous middle -------------------------
    let nliCalls = 0;
    for (const rec of ambiguous) {
      if (inferZeroShot) {
        try {
          const out = await inferZeroShot(toText(rec._card), labels, {
            multi_label: false, // softmax across buckets: they compete, one wins
            hypothesis_template: hypothesisTemplate,
          });
          nliCalls++;
          // Map EVERY returned score back to its bucket BY LABEL. The output is
          // sorted by score, so position is meaningless -- see file header.
          const labelScore = new Map();
          const oLabels = (out && out.labels) || [];
          const oScores = (out && out.scores) || [];
          for (let i = 0; i < oLabels.length; i++) labelScore.set(oLabels[i], oScores[i]);

          let winIdx = -1, winScore = -Infinity, second = -Infinity;
          for (let i = 0; i < B; i++) {
            const s = labelScore.has(labels[i]) ? labelScore.get(labels[i]) : -Infinity;
            if (s > winScore) { second = winScore; winScore = s; winIdx = i; }
            else if (s > second) { second = s; }
          }
          if (winIdx >= 0 && winScore > -Infinity) {
            rec.bucketIndex = winIdx;
            rec.score = winScore;
            rec.margin = second === -Infinity ? winScore : winScore - second;
            rec.via = 'nli';
          } else {
            // NLI returned nothing usable: keep cosine's guess if it had one.
            rec.via = rec._cosTop >= 0 ? 'cosine' : 'unassigned';
            rec.bucketIndex = rec._cosTop;
          }
        } catch (e) {
          rec.via = rec._cosTop >= 0 ? 'cosine' : 'unassigned';
          rec.bucketIndex = rec._cosTop;
        }
      } else {
        // No NLI available: accept cosine's top1, or unassigned if the tab had no
        // embedding to score at all. Degradation must not masquerade as a verdict.
        rec.via = rec._cosTop >= 0 ? 'cosine' : 'unassigned';
        rec.bucketIndex = rec._cosTop;
      }
    }

    // ---- Compose buckets + unassigned, apply the confidence floor -----------
    const unassigned = [];
    for (const rec of perCard) {
      const below = minConfidence > 0 && rec.score < minConfidence;
      if (rec.bucketIndex < 0 || rec.via === 'unassigned' || below) {
        rec.bucketIndex = -1;
        rec.via = 'unassigned';
        unassigned.push(rec.tabId);
      } else {
        bucketOut[rec.bucketIndex].tabIds.push(rec.tabId);
      }
      delete rec._cosTop;
      delete rec._card;
    }

    const margins = perCard.map(p => p.margin).filter(m => Number.isFinite(m));
    const stats = {
      total: cards.length,
      cosineDecided: perCard.filter(p => p.via === 'cosine' || p.via === 'single').length,
      nliDecided: perCard.filter(p => p.via === 'nli').length,
      unassigned: unassigned.length,
      nliCalls,
      embedCalls,
      avgMargin: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0,
      minMargin: margins.length ? Math.min(...margins) : 0,
    };

    return { buckets: bucketOut, unassigned, perCard, stats };
  }

  function emptyStats(total) {
    return { total, cosineDecided: 0, nliDecided: 0, unassigned: 0, nliCalls: 0, embedCalls: 0, avgMargin: 0, minMargin: 0 };
  }

  const MultiGroupAssign = { assignToBuckets, bucketText, cosine };
  if (typeof module !== 'undefined' && module.exports) module.exports = MultiGroupAssign;
  if (typeof self !== 'undefined') self.MultiGroupAssign = MultiGroupAssign;
})();
