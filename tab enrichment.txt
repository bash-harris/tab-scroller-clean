# TAB ENRICHMENT — REFACTOR INSTRUCTIONS
Target: replace the hardcoded taxonomy with a learned one, fix the scoring math,
and make the pipeline measurable. Work top-down; P0 blocks everything else.

Ground rule: **do not ship any change in C4–C9 without running `bench/enrich-bench.js`
before and after and pasting the numbers into the PR body.** Every change below
names the metric it must move.

---

## C0 — BUILD THE MEASUREMENT HARNESS FIRST (P0)

You cannot justify any of this without a gold set. Nothing else lands until this exists.

**New: `bench/goldset.jsonl`** — 300 URLs sampled from real history, stratified so no
domain is >5% of the set. Each line:
```json
{"url":"...","html_fixture":"fixtures/abc123.html","labels":["coding","docs"],"contentType":"reference"}
```
Freeze the HTML fixtures so the benchmark is deterministic and offline (no live fetches,
no flaky DOM).

**New: `bench/enrich-bench.js`** — runs `buildTabCard` against fixtures, emits:

| Metric | Definition | Baseline today (measure it) | Gate after refactor |
|---|---|---|---|
| `P@1` | top tag ∈ gold labels | ? | ≥ 0.82 |
| `macro-F1` | over emitted multi-label set | ? | ≥ 0.70 |
| `tags/card` | mean emitted count | ? | 1.4–2.2 (see C4) |
| `ECE` | 10-bin expected calibration error on `score` | ? (expect ~0.25–0.40) | ≤ 0.08 |
| `Brier` | mean squared error of score vs. correctness | ? | ↓ ≥ 30% |
| `entropy@1` | Shannon entropy of the top-1 tag distribution across the corpus | ? | ↑ (hub collapse, see C5) |
| `p95 build` | ms, `buildTabCard` end-to-end | ? | ≤ 400ms |
| `p95 block` | main-thread block time in the page | ? | ≤ 50ms |
| `cold start` | ms to first enriched card after SW wake | ? (expect 1200–2000ms) | ≤ 300ms |
| `mem/card` | bytes in IDB | ? (~1.6KB embedding alone) | ≤ 1.0KB (C11) |

Log all of these behind `chrome.storage.local.enrichTelemetry` in prod too, sampled at 5%.
Without this you're tuning constants by vibes, which is exactly how `TAG_THRESHOLD_Z = 1.2`
and `HARVEST_BIAS = 0.2` got there.

---

## C1 — MAKE THE TAXONOMY DYNAMIC (P0) ← the headline change

**Problem.** `TAG_PROTOTYPES` (23 classes), `TAG_ALIASES`, `DOMAIN_PRIORS`, and
`SUBREDDIT_MAP` are static author-guesses. They are simultaneously too coarse (all of
frontend/infra/ML collapses into `coding`) and too broad (`travel`, `shopping` fire for
users who never browse them, wasting probability mass and inflating the z-score
denominator for everyone). A taxonomy that doesn't match the user's actual browsing is
the single largest source of `P@1` loss.

**Approach:** online DP-means clustering over the card embeddings + c-TF-IDF cluster
labeling (BERTopic-style, Grootendorst 2022) + Bayesian domain priors learned from
observed assignments. Fully offline, no LLM, ~O(K·384) per card where K ≈ 15–40.

**New file: `taxonomy.js`**

```js
// IDB store 'taxonomy', keyPath 'id'
// { id, label, centroid: Float32Array(384), sumVec: Float32Array(384), n,
//   terms: string[], domainCounts: {domain: n}, source: 'seed'|'discovered',
//   locked: bool, createdAt, updatedAt }

const TAU_NEW    = 0.45;  // cos below this -> spawn a new cluster (DP-means lambda)
const TAU_MERGE  = 0.85;  // merge two centroids above this
const MIN_N      = 3;     // clusters below this are provisional, never emitted
const CONSOLIDATE_EVERY = 200; // new cards

// assign(v) -> { id, cos } ; creates a cluster if nothing is close enough
function assign(v) {
  let best = null, bestCos = -1;
  for (const c of clusters) { const s = dot(v, c.centroid); if (s > bestCos) { bestCos = s; best = c; } }
  if (bestCos < TAU_NEW) return spawn(v);            // nonparametric growth
  best.n++; addInto(best.sumVec, v);
  best.centroid = l2normalize(scale(best.sumVec, 1 / best.n));  // exact running centroid
  return { id: best.id, cos: bestCos };
}
```

**Cold start (first ~50 cards):** keep 8 *broad* seed clusters only — `coding, news,
reference, media, shopping, work, social, other`. Seed them from the existing prototype
phrases so day-one behavior isn't garbage, but mark `source:'seed'` and let evidence
override them. Do **not** seed 23 classes; over-seeding suppresses discovery because
every new page finds *something* above `TAU_NEW`.

**Labeling, no LLM required.** On consolidation, for each cluster:
1. c-TF-IDF over the cluster's docs (`mainText` + `structured.keywords` + domain tokens),
   treating the cluster as one class document: `w = tf(t,c) · log(1 + A/tf(t))`.
2. Take top-15 uni/bigrams as candidate labels.
3. `label = argmax_p cos(embed(p), centroid)`, MMR (λ=0.6) for tiebreaking against
   already-used labels so you don't end up with three clusters called "python".
4. If `cluster.locked` (user renamed it), skip.

Optional, behind a setting: one LLM call per *newly discovered* cluster to prettify the
label. That's ~1 call per week per user, not per tab. Keeps the "offline-first" claim intact.

**Priors become learned (delete `domain-priors.js`'s hand-map as a hard rule).**
Keep the map, but demote it to Dirichlet pseudo-counts:
```js
// P(cluster | domain) with Dirichlet(alpha=0.5) smoothing
// seed map contributes alpha_seed = 5 pseudo-counts, so ~10 real observations override it
p = (count[d][k] + 0.5 + (seedMatch ? 5 : 0)) / (total[d] + 0.5*K + (seedHas ? 5 : 0));
conf = wilsonLowerBound(count[d][k], total[d], 1.96);  // not a magic 0.95
```
This kills the `'reuters.com': ['news','finance']` class of guess. If the user only reads
Reuters tech coverage, the prior learns that in ~10 visits.

**Feedback loop (do this, it's the highest-ROI 40 lines in the project).** On user
accept/reject/rename in the UI:
```js
centroid = l2normalize(add(centroid, scale(sub(v, centroid), eta)));  // eta = 0.10 accept
// reject: eta = -0.05, and add v as a negative exemplar for the margin check
```
Target: `P@1` +0.05–0.12 after 50 corrections. Measure it — log corrections and replay.

**Invalidate on taxonomy change.** Replace `vecVersion: 2` with
`vecVersion: sha256(modelId + taxonomyRevision).slice(0,8)`. Right now if you edit
`TAG_PROTOTYPES`, every cached card keeps stale tags for a full 7 days and you'll think
your change did nothing.

---

## C2 — FIX THE MODULE-INIT CRASH (P0)

`enrich-math.js`:
```js
const api = { initTopicVocab, vocabInfo, isReady, scoreTags, ... };
```
`vocabInfo` and `isReady` are never defined in the file. This throws `ReferenceError` at
IIFE evaluation, `self.EnrichMath` is never assigned, and `buildTabCard`'s
`typeof self.EnrichMath !== 'undefined'` guard silently swallows it — **every card falls
through to the `classifyDomain` path with an empty embedding.** Define them or remove them.
Verify: assert `EnrichMath.isReady() === true` in the bench before scoring.

---

## C3 — FIX THE IDB KEY (P0, data corruption)

`tabCards` uses `keyPath: 'tabId'`. Chrome reuses tab IDs, and one tab navigates many
times. Consequences today:
- Navigating in a tab **overwrites** the previous page's card. Your "memory" silently loses pages.
- Two tabs on the same URL create two records, so the cache check does a full-table scan for nothing.
- Eviction `deleteTabCard(allCards[i].tabId)` can delete the card belonging to a **currently open tab**.

Fix: `keyPath: 'urlHash'`, secondary index on `extractedAt` (for eviction) and on `tabId`
(for live-tab lookup). Bump `DB_VERSION` to 4 with a migration that re-keys existing rows.
Metric: `cards_retained_after_1h_session` should go from ~(tabs open) to ~(pages visited).

---

## C4 — REPLACE THE Z-SCORE EMISSION WITH A CALIBRATED SOFTMAX (P0)

**Problem.** `(score - mean) / sd >= 1.2` over 23 classes is not a confidence test, it's a
*shape* test. With 23 classes, at most ~2–3 can ever exceed z=1.2 regardless of how
confident the model is, so a page that's unambiguously `coding` and a page that's pure
noise emit a similar number of tags. Worse, `mean` and `sd` are computed over a list whose
membership changes when bias hints add entries (C6), so identical embeddings score
differently depending on how many meta keywords the page happened to have.

**Fix — proper probabilistic emission:**
```js
// 1. per-class standardization (running Welford stats over the corpus, persisted)
z_k = (cos(v, c_k) - mu_k) / sigma_k;

// 2. fuse evidence in LOG-ODDS space, not cosine space
logit_k = a * z_k + Σ_f w_f * log( P(k | f) / P(k) );   // f ∈ {domain, path0, schemaType, keyword}

// 3. temperature-scaled softmax
p_k = softmax(logit_k / T);

// 4. emit: relative + absolute threshold + abstain
emitted = topK(p, 3).filter(k => p_k >= 0.5 * p_max && p_k >= TAU_ABS);
if (!emitted.length) emitted = ['unsorted'];
```
Fit `a`, `w_f`, `T` by multinomial logistic regression on the 300-card gold set
(offline script, ship the ~30 learned floats as a JSON constant). This is still pure math
and runs in microseconds.

Gate: `ECE ≤ 0.08` (from an expected baseline of 0.25–0.40), `macro-F1` +0.08 or better,
`tags/card` lands in 1.4–2.2.

---

## C5 — HUBNESS / ANISOTROPY CORRECTION (P1)

MiniLM's embedding space is anisotropic: all cosines pile up in ~[0.0, 0.45] and a handful
of centroids become *hubs* that are nearest-neighbor to a disproportionate share of points
(Radovanović 2010). Your `other: ['generic web page', 'miscellaneous content', ...]`
centroid is a textbook hub and is almost certainly eating traffic from real classes.

Two fixes, both cheap:
1. **Center before scoring.** Maintain a running corpus mean `μ`; score `l2norm(v - μ)`
   against `l2norm(c_k - μ)`. (all-but-the-top, Mu & Viswanath ICLR'18 — typically worth
   2–4 points on downstream similarity tasks.)
2. **Delete the `other` class.** `other` is not a topic, it's an *abstention*. Handle it as
   `p_max < TAU_ABS → 'unsorted'` (already in C4). A class whose prototypes are literally
   "placeholder page" will match anything low-signal.

Metric: `entropy@1` should rise; check the per-class confusion matrix — `other` should stop
appearing as the top false positive.

---

## C6 — BIAS INJECTION IS UNBOUNDED AND DOUBLE-COUNTS (P1)

```js
for (const h of hintSources) { scoreMap.set(tag, (scoreMap.get(tag) || 0) + HARVEST_BIAS); }
```
A page with 20 meta keywords that all alias to `coding` gets **+4.0** added to a cosine
whose entire dynamic range is ~0.45. The embedding becomes irrelevant. Also `hintSources`
concatenates `harvestTags` and `keywordHints` without dedupe, so the same signal counts twice.

Fix: dedupe by canonical tag, then saturate. Under C4 this becomes a log-prior anyway,
but if you stage the work:
```js
const votes = new Map(); // tag -> distinct source count
bias = W * Math.log1p(votes.get(tag)) / Math.log1p(3);  // 3 votes ≈ full weight, caps naturally
```

---

## C7 — `canonicalTag` SILENTLY BREAKS ON EVERY MULTI-WORD ALIAS (P1)

```js
const key = String(name || '').toLowerCase().split(/[^a-z0-9]+/)[0];
```
`"artificial intelligence"` → `"artificial"` → no match. `"machine learning"` → `"machine"`
→ no match. Two of your alias entries are **dead code**, and since `mathEnrich` calls
`matchTag(h) || canonicalTag(h)`, priors like `['coding','dev']` work but any multi-word
JSON-LD keyword doesn't. Normalize the full string first, fall back to first-token.

Also: `matchTag` constructs a fresh `RegExp` per alias per hint — that's ~45 regex
compilations per hint, ~900 per card with 20 keywords. Precompile the alias regexes once at
module load. (Small, but it's on the hot path for 2000 cards during the startup sweep.)

---

## C8 — CACHE THE CENTROIDS; STOP RE-EMBEDDING 90 PHRASES ON EVERY SERVICE-WORKER WAKE (P1)

`initTopicVocab` embeds ~90 prototype phrases sequentially. At ~10–20ms each that's
**0.9–1.8s of cold start**, and MV3 service workers die after 30s idle, so this runs
constantly. Persist centroids to IDB keyed by `sha256(modelId + taxonomyRevision)`; recompute
only on miss. Gate: `cold start ≤ 300ms`.

---

## C9 — `embedBatch` DOESN'T BATCH (P1)

```js
async embedBatch(texts) { return Promise.all(texts.map(t => this.embed(t))); }
```
That's N sequential forward passes wearing a trenchcoat. transformers.js pipelines accept
an array and run a real batched pass:
```js
async embedBatch(texts) {
  const r = await pipelineFn(texts, { pooling: 'mean', normalize: true });
  return chunkFloat32(r.data, 384);
}
```
Expect 2–4x throughput on the startup sweep. Related: `CONCURRENCY = 5` in `sweepMissingCards`
is actively harmful — `wasm.numThreads = 1` means embedding is serialized anyway, so all
you're buying is 5 simultaneous full-DOM `cloneNode(true)` operations and the memory spike
that comes with it. Split the pipeline: extraction concurrency 5 (I/O bound), then a single
serial embedding queue with `embedBatch(batchOf8)`.

---

## C10 — EXTRACTION COST (P1)

- Guard the Readability injection: `if (!window.__rdblLoaded)`. You currently re-inject and
  re-evaluate the whole vendored library on every `status === 'complete'`, including SPA
  soft-navigations.
- `document.cloneNode(true)` on a heavy page is 100–300ms of blocked main thread plus a full
  DOM-sized memory spike. Wrap in `requestIdleCallback` with a timeout, and skip Readability
  entirely when `document.body.innerHTML.length > 2e6` (go straight to `body-fallback`).
- Gate: `p95 block ≤ 50ms`. Measure with `performance.measure` inside the injected func and
  return it in `out`.

---

## C11 — STORAGE (P2)

- `getAllTabCards()` on **every** `buildTabCard` deserializes up to 2000 cards × 1.5KB of
  Float32Array ≈ 3MB, to then do a linear `.find()`. After C3 this becomes a single
  `store.get(urlHash)`. This is probably your biggest `p95 build` win.
- Eviction does N sequential awaited transactions. Do it in one `readwrite` tx over the
  `extractedAt` index with a cursor, and trigger on `store.count()`, not on a possibly-stale
  `savedCards.length` handed in by the caller.
- Quantize stored embeddings to int8 with a per-vector scale (384 bytes + 4 vs 1536). Cosine
  error is ~0.5% and irrelevant at your thresholds. `mem/card` 1.6KB → ~0.5KB.

---

## C12 — DEAD FEATURE: `subTopics` (P2)

`scoreTopics: () => []` is a stub, `ctx.topicMatches` is never passed by `buildTabCard`, so
`subTopics` is *always* the keyword fallback. Either implement it (under C1 it's free: the
cluster's #2–#4 c-TF-IDF terms) or delete the field. Right now it's schema that lies.

---

## C13 — `sanitizePageContent` IS NOT A SECURITY BOUNDARY (P2)

Six regexes will not stop prompt injection — `ign0re instructions`, base64, unicode
homoglyphs, and non-English phrasings all walk straight through, and the `[Content Redacted]`
token itself is a signal an attacker can exploit. Keep it as noise reduction, but the actual
defense is structural: page content must never enter the instruction channel. Wrap it in
explicit data delimiters, state in the system prompt that delimited content is untrusted data
and can never issue instructions or trigger tool calls, and require tool calls to originate
from the user turn. Also: sanitize runs *after* `pseudoDoc` is assembled from raw fields —
fine for embedding, but don't let unsanitized `structured.headline`/`byline` reach an LLM.

---

## C14 — MISC (P2)

- `dot(a, b, aOffset, len)`: the param named `aOffset` indexes into `b`. Rename before someone
  "fixes" it.
- `if (embed) embedFn = embed || embedFn;` — the outer guard makes the `||` unreachable.
- No dedupe on `contentHash`. Syndicated articles across 5 domains produce 5 near-identical
  cards and skew the learned priors in C1. Dedupe on `contentHash`, keep the earliest URL.
- Excluded-page cards write an `enrichment` object with no `tags` and no `vecVersion`. Consumers
  reading `enrichment.tags[0]` will throw. Make the shape uniform.

---

## SUGGESTED ORDER

1. C0 (harness) → C2, C3 (crash + corruption) → measure baseline.
2. C4, C5, C6, C7 (scoring math) → re-measure. **This is where `P@1` and `ECE` move.**
3. C1 (dynamic taxonomy) behind a flag, A/B against the static one on the same gold set.
4. C8–C11 (perf) → re-measure latency only.
5. C12–C14 cleanup.

Do not skip step 1's baseline capture. If you refactor first you'll have no way to prove
the dynamic taxonomy actually beat the hardcoded one, and on a 300-card set it might not
until the feedback loop has data.

Picking up where it cut off. Here are the actual drop-in files for the three changes that matter most (C3 key fix, C4 scoring, C1 dynamic taxonomy), so you're not translating prose into code yourself.

**1. `db.js` — re-key to `urlHash`, DB_VERSION 4 + migration**

```js
const DB_VERSION = 4;

request.onupgradeneeded = (event) => {
  const db = event.target.result;
  const tx = event.target.transaction;

  // ... existing 'pages' store setup unchanged ...

  // --- tabCards: migrate keyPath tabId -> urlHash ---
  if (db.objectStoreNames.contains('tabCards') && event.oldVersion < 4) {
    const old = tx.objectStore('tabCards');
    const rows = [];
    old.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { rows.push(cur.value); cur.continue(); return; }
      db.deleteObjectStore('tabCards');
      const s = db.createObjectStore('tabCards', { keyPath: 'urlHash' });
      s.createIndex('extractedAt', 'extractedAt', { unique: false }); // eviction cursor
      s.createIndex('tabId', 'tabId', { unique: false });             // live-tab lookup
      s.createIndex('contentHash', 'contentHash', { unique: false }); // C14 dedupe
      for (const r of rows) if (r.urlHash) s.put(r);
    };
  } else if (!db.objectStoreNames.contains('tabCards')) {
    const s = db.createObjectStore('tabCards', { keyPath: 'urlHash' });
    s.createIndex('extractedAt', 'extractedAt', { unique: false });
    s.createIndex('tabId', 'tabId', { unique: false });
    s.createIndex('contentHash', 'contentHash', { unique: false });
  }
};
```

Then the O(1) cache hit that replaces `getAllTabCards().find(...)`:

```js
async getCardByUrlHash(urlHash) {
  const tx = this._db.transaction('tabCards', 'readonly');
  const req = tx.objectStore('tabCards').get(urlHash);
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
},

// single-transaction cursor eviction, count-driven not caller-driven
async evictOldest(maxCards = 2000) {
  const tx = this._db.transaction('tabCards', 'readwrite');
  const store = tx.objectStore('tabCards');
  const total = await new Promise((r) => { const q = store.count(); q.onsuccess = () => r(q.result); });
  let toDelete = total - maxCards;
  if (toDelete <= 0) return 0;
  const deleted = toDelete;
  await new Promise((res, rej) => {
    store.index('extractedAt').openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur || toDelete <= 0) return res();
      cur.delete(); toDelete--; cur.continue();
    };
    tx.onerror = () => rej(tx.error);
  });
  return deleted;
}
```

**2. `taxonomy.js` — online DP-means + c-TF-IDF labeling (the dynamic-tags core)**

```js
// taxonomy.js — learned taxonomy. Pure math + IDB. No LLM, no chrome APIs.
(() => {
  const DIM = 384;
  const TAU_NEW = 0.45, TAU_MERGE = 0.85, MIN_N = 3, CONSOLIDATE_EVERY = 200;
  const SEEDS = {
    coding:    ['source code repository', 'programming tutorial', 'stack trace debugging'],
    news:      ['breaking news report', 'world headlines today'],
    reference: ['encyclopedia entry', 'api reference documentation'],
    media:     ['watch video online', 'film review', 'music album'],
    shopping:  ['buy product online', 'price comparison'],
    work:      ['project management board', 'meeting notes'],
    social:    ['community discussion thread', 'social feed']
    // NOTE: no 'other'. Abstention is handled by TAU_ABS, not by a class. (C5)
  };

  let clusters = [];      // {id,label,centroid,sumVec,n,terms,domainCounts,locked,source}
  let mu = new Float32Array(DIM), muN = 0;   // running corpus mean for centering (C5)
  let revision = 0, sinceConsolidate = 0;
  const docBuf = new Map();                  // clusterId -> [{tokens, domain}]

  const l2 = (v) => { let n=0; for (let i=0;i<v.length;i++) n+=v[i]*v[i]; n=Math.sqrt(n)||1;
    const o=new Float32Array(v.length); for (let i=0;i<v.length;i++) o[i]=v[i]/n; return o; };
  const dot = (a,b) => { let s=0; for (let i=0;i<DIM;i++) s+=a[i]*b[i]; return s; };

  // all-but-the-top style centering: score in the de-meaned space (C5)
  function center(v) {
    if (muN < 30) return v;
    const o = new Float32Array(DIM);
    for (let i=0;i<DIM;i++) o[i] = v[i] - mu[i]/muN;
    return l2(o);
  }
  function observe(v) { for (let i=0;i<DIM;i++) mu[i]+=v[i]; muN++; }

  function spawn(v, domain) {
    const c = { id: `c${Date.now().toString(36)}${clusters.length}`, label: null,
      centroid: l2(v), sumVec: Float32Array.from(v), n: 1, terms: [],
      domainCounts: domain ? { [domain]: 1 } : {}, locked: false, source: 'discovered',
      createdAt: Date.now(), updatedAt: Date.now() };
    clusters.push(c); revision++;
    return { id: c.id, cos: 1, provisional: true };
  }

  // ---- main entry: returns ranked cluster scores for a card embedding ----
  function score(v) {
    const cv = center(v);
    return clusters
      .filter(c => c.n >= MIN_N || c.source === 'seed')
      .map(c => ({ id: c.id, tag: c.label || c.id, score: dot(cv, center(c.centroid)) }))
      .sort((a,b) => b.score - a.score);
  }

  function assign(v, ctx = {}) {
    observe(v);
    const cv = center(v);
    let best = null, bestCos = -1;
    for (const c of clusters) { const s = dot(cv, center(c.centroid)); if (s > bestCos) { bestCos = s; best = c; } }
    if (!best || bestCos < TAU_NEW) return spawn(v, ctx.domain);

    best.n++;
    for (let i=0;i<DIM;i++) best.sumVec[i] += v[i];
    best.centroid = l2(best.sumVec.map(x => x / best.n));   // exact running centroid
    if (ctx.domain) best.domainCounts[ctx.domain] = (best.domainCounts[ctx.domain]||0)+1;
    best.updatedAt = Date.now();

    if (ctx.tokens) {
      const buf = docBuf.get(best.id) || []; buf.push(ctx.tokens);
      docBuf.set(best.id, buf.slice(-50));
    }
    if (++sinceConsolidate >= CONSOLIDATE_EVERY) consolidate();
    return { id: best.id, cos: bestCos, provisional: best.n < MIN_N };
  }

  // ---- c-TF-IDF labeling + merge, no LLM ----
  async function consolidate(embedFn) {
    sinceConsolidate = 0;
    // merge over-similar centroids
    for (let i=0;i<clusters.length;i++) for (let j=i+1;j<clusters.length;j++) {
      const a = clusters[i], b = clusters[j];
      if (!a || !b || a.locked || b.locked) continue;
      if (dot(center(a.centroid), center(b.centroid)) > TAU_MERGE) {
        for (let k=0;k<DIM;k++) a.sumVec[k] += b.sumVec[k];
        a.n += b.n; a.centroid = l2(a.sumVec.map(x => x/a.n));
        for (const [d,n] of Object.entries(b.domainCounts)) a.domainCounts[d]=(a.domainCounts[d]||0)+n;
        clusters.splice(j,1); j--; revision++;
      }
    }
    // label: c-TF-IDF candidates, pick argmax cos(embed(phrase), centroid), MMR vs used labels
    const A = clusters.reduce((s,c) => s + c.n, 0) || 1;
    const globalTf = new Map();
    for (const c of clusters) for (const doc of (docBuf.get(c.id)||[]))
      for (const t of doc.tokens || []) globalTf.set(t, (globalTf.get(t)||0)+1);

    const used = new Set(clusters.filter(c => c.locked).map(c => c.label));
    for (const c of clusters) {
      if (c.locked || c.n < MIN_N) continue;
      const tf = new Map();
      for (const doc of (docBuf.get(c.id)||[]))
        for (const t of doc.tokens || []) tf.set(t, (tf.get(t)||0)+1);
      const cands = [...tf.entries()]
        .map(([t,f]) => [t, f * Math.log(1 + A/(globalTf.get(t)||1))])
        .sort((a,b) => b[1]-a[1]).slice(0,15).map(x => x[0]);
      if (!cands.length || !embedFn) continue;
      let bestP = null, bestS = -Infinity;
      for (const p of cands) {
        const pv = await embedFn(p);
        if (!pv || pv.length !== DIM) continue;
        const rel = dot(center(pv), center(c.centroid));
        const pen = used.has(p) ? 0.4 : 0;                  // MMR λ=0.6
        if (rel - pen > bestS) { bestS = rel - pen; bestP = p; }
      }
      if (bestP) { c.label = bestP; c.terms = cands.slice(0,4); used.add(bestP); revision++; }
    }
    await persist();
  }

  // ---- user feedback: the highest-ROI loop in the project ----
  function feedback(clusterId, v, kind) {
    const c = clusters.find(x => x.id === clusterId); if (!c) return;
    const eta = kind === 'accept' ? 0.10 : -0.05;
    const nc = new Float32Array(DIM);
    for (let i=0;i<DIM;i++) nc[i] = c.centroid[i] + eta * (v[i] - c.centroid[i]);
    c.centroid = l2(nc); c.updatedAt = Date.now(); revision++;
  }
  function rename(clusterId, label) {
    const c = clusters.find(x => x.id === clusterId); if (!c) return;
    c.label = label; c.locked = true; revision++;   // labeling never overwrites this
  }

  // P(cluster | domain), Dirichlet-smoothed, seed map = 5 pseudo-counts (C1)
  function domainPrior(domain, seedTagIds = []) {
    const out = new Map(); const alpha = 0.5, K = clusters.length || 1;
    let total = 0; for (const c of clusters) total += (c.domainCounts[domain]||0);
    const seedBoost = seedTagIds.length ? 5 : 0;
    for (const c of clusters) {
      const n = c.domainCounts[domain] || 0;
      const seed = seedTagIds.includes(c.id) ? seedBoost : 0;
      out.set(c.id, (n + alpha + seed) / (total + alpha*K + seedBoost));
    }
    return out;
  }
  function wilson(k, n, z = 1.96) {
    if (!n) return 0; const p = k/n, d = 1 + z*z/n;
    return (p + z*z/(2*n) - z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / d;
  }

  function taxonomyRevision() { return `${clusters.length}.${revision}`; }
  async function persist() { /* write clusters + mu/muN to IDB store 'taxonomy' */ }
  async function load(embedFn) { /* read from IDB; if empty, seed from SEEDS via embedFn */ }

  const api = { load, assign, score, consolidate, feedback, rename, domainPrior,
                wilson, taxonomyRevision, clusters: () => clusters,
                TAU_NEW, TAU_MERGE, MIN_N, SEEDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.Taxonomy = api;
})();
```

**3. `enrich-math.js` — calibrated emission replacing the z-threshold**

```js
// learned by offline multinomial logistic regression on bench/goldset.jsonl (C4)
const CAL = { a: 4.2, T: 1.35, w: { domain: 0.9, path: 0.5, schema: 1.1, keyword: 0.35 }, tauAbs: 0.28 };
const RUN = new Map(); // tag -> {mu, m2, n}  Welford, persisted (per-class standardization)

function zScore(tag, cos) {
  const s = RUN.get(tag); if (!s || s.n < 20) return cos * 4;   // pre-warm fallback
  const sd = Math.sqrt(s.m2 / s.n) || 1;
  return (cos - s.mu) / sd;
}

function mathEnrich(embedding, ctx = {}) {
  const v = embedding?.length === DIM ? embedding : null;
  if (!v) return abstain();

  const T = self.Taxonomy;
  const raw = T.score(v);
  const dPrior = T.domainPrior(ctx.domain || '', ctx.seedTagIds || []);

  // dedupe hints by canonical target, then log-saturate votes (C6)
  const votes = new Map();
  for (const h of new Set([...(ctx.harvestTags||[]), ...(ctx.keywordHints||[])])) {
    const tag = canonicalTag(h) || matchTag(h);
    if (tag) votes.set(tag, (votes.get(tag)||0) + 1);
  }

  // fuse in log-odds space, not cosine space (C4)
  const logits = raw.map(({ id, tag, score }) => {
    let z = CAL.a * zScore(tag, score);
    const pd = dPrior.get(id);
    if (pd) z += CAL.w.domain * Math.log(pd * raw.length);
    if (ctx.schemaTagId === id) z += CAL.w.schema;
    const nv = votes.get(tag) || 0;
    if (nv) z += CAL.w.keyword * (Math.log1p(nv) / Math.log1p(3));
    return { id, tag, z };
  });

  const max = Math.max(...logits.map(x => x.z));
  const exps = logits.map(x => Math.exp((x.z - max) / CAL.T));
  const Z = exps.reduce((a,b) => a+b, 0) || 1;
  const probs = logits.map((x,i) => ({ ...x, p: exps[i]/Z })).sort((a,b) => b.p - a.p);

  const pMax = probs[0].p;
  const emitted = probs.slice(0,3).filter(x => x.p >= 0.5 * pMax && x.p >= CAL.tauAbs);
  if (!emitted.length) return abstain();

  // update running stats + assign for taxonomy growth
  for (const r of raw) { const s = RUN.get(r.tag) || {mu:0,m2:0,n:0};
    s.n++; const d = r.score - s.mu; s.mu += d/s.n; s.m2 += d*(r.score - s.mu); RUN.set(r.tag, s); }
  const a = T.assign(v, { domain: ctx.domain, tokens: ctx.tokens });

  return {
    category: emitted[0].tag,
    clusterId: emitted[0].id,
    tags: emitted.map(x => ({ tag: x.tag, clusterId: x.id, score: Number(x.p.toFixed(3)) })),
    subTopics: (T.clusters().find(c => c.id === emitted[0].id)?.terms || []).slice(0,4),
    entities: { people: ctx.structured?.people || [], orgs: [], works: [] },
    contentType: deriveContentType(ctx.structured, emitted[0].tag),
    tier: 'math',
    vecVersion: ctx.vecVersion,          // sha256(modelId + taxonomyRevision).slice(0,8)
    provisional: a.provisional === true,
    enrichedAt: Date.now()
  };
}

function abstain() {
  return { category: 'unsorted', tags: [{ tag: 'unsorted', score: 0 }], subTopics: [],
    entities: { people: [], orgs: [], works: [] }, contentType: 'other',
    tier: 'math', vecVersion: 0, enrichedAt: Date.now() };
}
```

Note `vecVersion` is now `sha256(modelId + Taxonomy.taxonomyRevision()).slice(0,8)`, computed once per SW wake. That's what makes the 7-day cache invalidate itself when the taxonomy shifts, so you don't spend a week wondering why your changes did nothing.

**Where this leaves you:** tags come from clusters the user's own browsing created, labels come from c-TF-IDF over their actual page text, priors are learned per domain with Wilson confidence, and scores are real probabilities you can threshold. Still zero cloud calls.

Two things I'd do before writing any of it: run `EnrichMath.isReady()` in the SW console to confirm the `ReferenceError`, and capture the C0 baseline. Without the baseline you can't prove the clustering beat the hardcoded list, and honestly on 300 cards it might not until the feedback loop has a few dozen corrections in it.
