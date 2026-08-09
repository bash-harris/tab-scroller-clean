# Tab Enrichment Engine — Design Spec

Date: 2026-08-02
Status: Approved (brainstorming session 2026-08-02)

## 1. Problem

Current enrichment uses an LLM (qwen2.5 via Ollama) to generate summaries/categories/entities per tab. Measured consequences:

- ~4s/tab latency; 15-card batches overflow `num_predict` -> JSON truncates -> parse fails -> **nothing persists** (observed: 0 enriched cards across test runs)
- Ollama dependency on every client — conflicts with production goal (clients without Ollama/API keys)
- Reasoner judges on bare titles -> weak precision/recall in the 6-query suite (sports 0%, ent+sports recall 50%, cooking precision 0%)

## 2. Goal

Replace LLM enrichment with a deterministic, offline, math + structured-harvest cascade. Target: ~50-150ms/tab worst case (one MiniLM embed + µs matvec), 0ms on cache hit, zero LLM/Ollama dependency in the enrichment path. LLM remains only in command-time reasoning (`reasonOverCandidates`).

## 3. Scope (in)

Tier 0 harvest, Tier 1 centroid math, cache, consumer updates, removal of LLM enrichment path, `keep_alive` + instrumentation on the reasoner call.

**Out of scope:** retrieval fixes (mean-centering, z-scores, RRF, multi-vector — Phase 3 of source doc), offline distillation/training (Phase 5), static Model2Vec embedder, LLM refiner tier (Tier 2).

## 4. Data model

`card.enrichment` (v2):

```js
{
  category: 'sports',                        // top tag, for existing consumers
  tags: [{ tag: 'sports', score: 0.91 }, { tag: 'news', score: 0.60 }],  // multi-label, sigmoid-thresholded >= 0.35
  subTopics: ['cricket', 'test cricket'],    // top topic-vocab matches > threshold
  entities: { people: [], orgs: [], works: [] },  // JSON-LD harvest (unchanged shape)
  contentType: 'article',                    // schema @type / OG type
  tier: 'math',
  vecVersion: 2,
  enrichedAt: <ts>
}
```

- `summary` removed from the production path.
- `card.embedding` = `Embed.embed(pseudoDoc)` — **single embed per page**; pseudo-doc is richer than title+summary, so no second re-embed pass.
- `card.pseudoDoc` stored (source of `contentHash`).
- Old cards with `vecVersion !== 2` are re-enriched on next build (tab open/reindex) — no migration job needed; `tier` field lets future re-runs target only old cards.

## 5. Tier 0 — Harvest (in injected function, `tab-cards.js` `extractRichPageData`)

No model. Extend the existing in-page function:

1. **`SCHEMA_TYPE_TO_TAG`** map on JSON-LD `@type`: NewsArticle->news, Recipe->cooking, SportsEvent->sports, Movie/TVSeries/Episode->entertainment, SoftwareSourceCode->coding, Product->shopping, JobPosting->work, VideoObject->video, ScholarlyArticle->science, WebPage->(none). Existing people/keywords collection stays.
2. **`meta[property="og:article:section"]`** (and `article:section`) -> tag.
3. **Wikipedia `#mw-normal-catlinks`** -> append category strings to `structured.keywords` (human-curated topics).
4. **Pseudo-document builder**:

   ```
   title x2 | url-path tokens (split / - _) | og:description | meta description | h1 | h2 (first 3) | first 2 sentences of mainText
   ```

   -> `pseudoDoc` (cap ~800 chars), returned alongside existing fields.

## 6. Tier 1 — Centroid math (`enrich-math.js`, new)

- **Vocab (seeded, extendable):** ~35 tags x 5-10 prototype phrases (sports, entertainment, news, coding, dev, docs, video, social, shopping, cooking, work, learning, science, finance, travel, gaming, music, film, health, education, reference, other...); ~120 topic phrases for `subTopics`.
- **Init (lazy, once):** `initTopicVocab()` embeds all phrases with MiniLM, averages per tag -> L2-normalized centroids `Float32Array[35][384]`; cached in worker memory (~54KB).
- **`mathEnrich(pseudoDoc, structured)` -> enrichment:**
  1. `v = Embed.embed(pseudoDoc)` (single embed, reused as `card.embedding`)
  2. `scores = C . v` (one matvec, ~10µs) -> sigmoid threshold 0.35 -> multi-label `tags` (sorted desc)
  3. `category` = top tag; `subTopics` = top topic matches above threshold (max 4)
  4. `contentType` = schema type if present, else from tag (video->video etc.), else 'other'
- Deterministic, offline, no `enableAi` gate.

## 7. Cache & scheduling

- Keep existing `urlHash` + `contentHash` logic (tab-cards.js:291): reuse enriched card if content unchanged; add **7-day TTL** on `enrichedAt` (beyond TTL -> re-enrich).
- `contentHash` now derives from `pseudoDoc` (not raw mainText) — dedupes `?utm_source` variants and SPA re-renders.
- Enrichment runs **eagerly** in `buildTabCard` (synchronous within the existing `tabs.onUpdated` flow; the embed is already async). The 30s debounce queue is removed with the LLM path.
- Path-template inheritance: only via capture-group path priors (no separate mechanism).
- 2000-card LRU eviction stays.

## 8. Domain/path priors (`domain-priors.js`, new)

- `DOMAIN_PRIORS`: ~100 hand-seeded entries: github.com->[coding,dev], stackoverflow.com->[coding], espncricinfo.com->[sports,cricket], letterboxd.com->[entertainment,film], allrecipes.com->[cooking], youtube.com->[video], reddit.com->(path), en.wikipedia.org->(path/catlinks), news sites->[news]...
- `PATH_PRIORS`: regex list with optional capture->tag mapping: `/r/(\w+)` (subreddit map ~40 entries), `/sport(s)?/`, `/film|movies|tv/`, `/recipes?/`, `/watch/` (video)...
- Applied first; priors with `conf >= 0.9` seed the tag list; prior-matched tags get +0.15 to their centroid scores (priors bias, math confirms).

## 9. Consumer changes (`command-agent.js`)

- `retrieveCandidates`:
  - Replace single-category boost (line 106) with **tag-overlap boost**: query->tags via same centroid matvec on the query embedding (threshold 0.35); for each candidate, `overlap = |qTags ∩ cTags|`; `score += 0.3 * overlap` (cap 0.6).
  - Keep entity boost and keyword fallback.
- `reasonOverCandidates` `compactCards`: keep `category`; add `tags` (top 4 names); **remove `summary`** from the payload; keep `subTopics`, `people`.
- `runCommandPipeline`: unchanged.

## 10. Removals & unblock

- Delete: `queueCardForEnrichment`, `flushEnrichmentQueue`, `pendingEnrichmentCards`, `enrichmentTimeout` (background.js:4581-4624), `enrichTabCards` + `ENRICHMENT_SYSTEM_INSTRUCTION` + `buildEnrichmentPrompt` (tab-cards.js:120-221), `enableAi` gate on enrichment, enrichment-related exports.
- `buildTabCard`: remove `queueCardForEnrichment` call; add `mathEnrich` step (skip if `vecVersion === 2` and within TTL).
- `callOllama` (now reasoner-only): add `keep_alive: -1`; log prompt/output char counts + elapsed ms on every call (replaces missing observability).
- `enrichTabCards` removal means `enableAi` no longer controls enrichment — cards enrich for everyone.

## 11. Error handling

- `mathEnrich` failure (embed throws): card keeps title-only defaults (`category:'other'`, `tags:[]`), `tier:'none'`, logged once per card — never blocks tab open.
- Malformed harvest (null richData): existing minimal-card path; tags from priors+domain only.
- Matvec is pure math — no parse-failure mode.
- `initTopicVocab` failure: enrichment degrades to priors+structured only; retried lazily on next build.

## 12. Testing

Extend `tests/run-ai-test.js`:

- Same 6 queries (sports, entertainment, entertainment+sports, tech, cooking-negative, close-astronomy) — scoring unchanged (precision/recall vs slug sets)
- New metrics: enrichment coverage (cards with >=2 tags / total), per-card enrichment latency p50/p95 (timed inside worker via direct-CDP eval), cache-hit path (re-open same URL -> 0ms, assert no re-embed)
- Baselines to beat (2026-08-02 session): sports recall 0%, entertainment 0%, ent+sports recall 50%, tech 0%, cooking precision 0%, astronomy recall 33%
- Also verify: enrichment works with `enableAi: false` (proves offline independence)

## 13. Risks

- **Vocab quality** — hand-seeded centroids; mitigated by suite measurement + easy iteration on the data file
- **MiniLM similarity cone** — known; deferred to Phase 3 (retrieval) per scope decision
- **Wikipedia-heavy test bias** — catlinks/JSON-LD advantage; acceptable (test set is also the acceptance set), general sites still get priors+centroids
- **Worker single-thread contention** — embeds are async wasm; builds already staggered by tab-load timing; no new blocking work added (matvec is µs)

## 14. Deliverables

- `enrich-math.js` (new): vocab, initTopicVocab, mathEnrich
- `domain-priors.js` (new): DOMAIN_PRIORS, PATH_PRIORS, applyPriors
- `tab-cards.js`: harvest extension, pseudo-doc, mathEnrich integration, removals
- `background.js`: queue-engine removal, keep_alive + logging
- `command-agent.js`: tag-overlap retrieval, compactCards change
- `tests/run-ai-test.js`: extended metrics
- Spec + implementation plan docs
