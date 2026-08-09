# TabScroller — Enrichment & AI Command Pipeline Refactor

## Context

`tab enrichment.md` (C0–C14) and `ai command.md` (D0–D13) are two review documents
proposing a rewrite of how TabScroller turns open tabs into `TabCard`s and how it turns
natural-language commands into tab actions. `docs/TAB-ENRICHMENT-AND-AI-COMMANDS.md`
describes the system as designed.

Goal: land those reviews in the real codebase, phased, each phase gated on measurements
so we can prove a change helped rather than tuning constants by vibes.

Two blocking discoveries from reading the actual source — **neither is in either review
document**, and both invalidate any baseline measured before they are fixed:

1. **Extraction has never run.** `tab-cards.js:23` injects `vendor/readability.js`;
   the file on disk is `vendor/readibility.js` (misspelled). `chrome.scripting.executeScript`
   rejects, the `catch` at `tab-cards.js:165` swallows it, and `extractRichPageData`
   returns `null` **for every page**. So today every card has empty `mainText`, no JSON-LD,
   no `harvestTags`, no OpenGraph, no Wikipedia catlinks, and a `pseudoDoc` that is just
   `title + title + domain` (`tab-cards.js:299`). All the multi-signal fusion described in
   the design doc is dead code. This is almost certainly the largest single source of
   `P@1` loss, larger than anything in C1–C14.
2. **Domain routing has never run.** `sanitizeQuery` (`background.js:492`) strips `.` via
   `/[^a-zA-Z0-9\s'-]/g`. `runCommandPipeline` sanitizes first (`command-agent.js:368`),
   then tests `hasDomainPattern` against the sanitized string at `command-agent.js:399`
   (and `classifyCommand` does the same at `:24`). `"close youtube.com tabs"` becomes
   `"close youtube com tabs"`, so both domain regexes are permanently false.

### Corrections to the review documents

Verify these before acting on the docs; three of their claims are wrong for this codebase.

| Claim | Reality |
|---|---|
| **C2** — `vocabInfo`/`isReady` undefined ⇒ `ReferenceError` ⇒ `EnrichMath` never assigned | **False.** Both are defined (`enrich-math.js:170`, `:179`). The module loads. Skip C2. |
| **C12** — `scoreTopics` is a stub, `subTopics` always the keyword fallback | **False.** `scoreTopics` is implemented (`enrich-math.js:193`) and `mathEnrich` computes `topicMatches` internally (`:214`). `subTopics` is real. Keep the field. |
| **D13** — no timeout, no warm-up on Ollama | **Partly done.** `callOllama` already has `AbortController` + `settings.ollamaTimeout` + `keep_alive: -1` (`background.js:1483`). Remaining: no seed, `temperature 0.1`, `format:'json'` instead of a JSON schema. |
| **C8** — ~90 prototype phrases re-embedded per SW wake | **Understated.** 23 tag prototypes × 4–8 phrases (~130) **plus** 100 `TOPIC_PHRASES` (`enrich-math.js:31`) ≈ **230** sequential embeds per wake. |

Everything else in both docs was confirmed against the source.

### Decisions taken

- Phased, full coverage of C0–C14 + D0–D13. Each phase gated; approval between phases.
- Gold sets are **hand-authored synthetic fixtures**, not sampled from real history.
- C1's learned taxonomy ships **behind a setting, default off**, A/B'd against the static
  taxonomy on the same gold set. The static path stays as fallback and rollback.

---

## Phase 0 — P0 correctness (no behavior tuning, no metrics needed)

These are bugs, not design changes. Land them first so the Phase 1 baseline is meaningful.

**`tab-cards.js`**
- `:23` — inject `vendor/readibility.js` (match the file on disk). Do not rename the vendor
  file; `vendor/` is third-party and the typo is harmless once the reference matches.
- After fixing, confirm `extractionLevel === 'full'` on a normal article page. Until this
  is true, nothing else in enrichment is worth measuring.

**`background.js:492` `sanitizeQuery`** — preserve `.` and `/` in the character class so
domain patterns survive. Keep the 500-char cap and the ReDoS guard. Then dedupe the two
divergent `hasDomainPattern` regexes (`command-agent.js:24` lists `html|htm` as TLDs,
`:399` does not) into one exported constant — D12's "one source of truth".

**C3 — `db.js` re-key `tabCards` from `tabId` to `urlHash`.** `keyPath: 'tabId'`
(`db.js:29`) means navigating in a tab overwrites the previous page's card, and eviction
(`tab-cards.js:336`) can delete a live tab's card. Bump `DB_VERSION` to 4 with the
migration from `tab enrichment.md`; add indexes `extractedAt`, `tabId`, `contentHash`.
Add `getCardByUrlHash(urlHash)` and cursor-based `evictOldest(max)` — both drop-in from
the doc.

**C3 fallout — must land in the same change or retrieval silently returns nothing:**
- `tab-cards.js:243` — replace the `savedCards.find(c => c.urlHash === ...)` full-table
  scan with `TabDB.getCardByUrlHash`.
- `tab-cards.js:331` — replace caller-driven eviction with `TabDB.evictOldest(2000)`.
- `command-agent.js:61` — `allCards.filter(c => openTabIds.has(c.tabId))` reads `tabId`,
  which after the re-key is stale metadata. Replace with one indexed `urlHash` get per
  open tab; build the "missing" set from a `Set`, not the O(n·m) `candidates.some(...)`
  at `:65`.
- `background.js:4600` `sweepMissingCards` — same `cardTabIds` staleness.

**D1 — intent ladder.** `command-agent.js:375` tests `pin` before `unpin` and `mute`
before `unmute`, so `unpin_tabs`/`unmute_tabs` are unreachable; `close` is tested first of
all, so `"group my closed caption tabs"` resolves to the one destructive intent. Replace
with the anchored, negation-aware `INTENT_RULES` + `parseIntent` from `ai command.md` D1.
`ambiguous: true` must force a preview regardless of confidence.

**D4 — `sender.tab` undefined.** `background.js:2977` reads `sender.tab.windowId` outside
the `try`, so any non-content-script sender throws before `sendResponse` and the caller's
promise never settles. Use the `sender.tab?.windowId ?? getLastFocused()` fallback and
move the dedupe-key construction inside the `try`. Same fix at the `EXECUTE_PLAN` and
`EXECUTE_CONFIRMED_TOOL_CALL` cases (`background.js:3096`, `:3163`).

**D3 — preview state dies with the service worker.** `pendingPlans` is an in-memory `Map`
(`background.js:31`) with a 5-minute `expiresAt` it cannot honor across an MV3 restart.
Move to `chrome.storage.session` via `stashPlan`/`takePlan` (drop-in from D3). Store
`urlHash` alongside each `tabId` and re-validate at confirm time in `EXECUTE_PLAN` —
Chrome recycles tab IDs, so a stale ID can point at a different page.

**D11 — `groupName` is always undefined.** `background.js:3068` builds
`args: { tabIds }` only; `handleGroupTabs` destructures `groupName` at `:2226` and passes
`undefined` to `chrome.tabGroups.update`. Every group is untitled and the toast prints
`Grouped 5 tabs into "undefined"`. Add the local fallback chain now
(`dominantTag → titleCase(stripped cmd) → 'Tabs'`); the LLM-supplied `groupName` arrives
with D5 in Phase 3. Also:
- `background.js:3070` passes 4 args to the 3-arg `executeToolCall` (`:2545`) — the 4th is
  silently dropped. Remove it or widen the signature.
- `handleGroupTabs:2231` rejects `< 2` tabs *after* the user confirmed the preview.
  Validate before showing the dialog.

**C14 quick wins:** uniform `enrichment` shape on excluded-page cards (`tab-cards.js:215`
omits `tags`/`vecVersion`, so consumers reading `enrichment.tags[0]` throw); rename the
`dot(a, b, aOffset)` param that actually indexes `b` (`enrich-math.js:117`); drop the
unreachable `||` in `if (embed) embedFn = embed || embedFn` (`:124`).

**Exit:** existing `tests/*.test.js` still pass; a manual load-unpacked run shows
`extractionLevel: 'full'`, a titled tab group, and a working `unpin all tabs`.

---

## Phase 1 — Measurement harness (C0 + D0)

Nothing in Phases 2–5 ships without before/after numbers pasted into the change summary.

**`bench/fixtures/*.html`** — ~60 hand-authored pages, frozen and offline: article with
JSON-LD `NewsArticle`, recipe with `Recipe`, GitHub-style repo page, Stack Overflow-style
Q&A, Wikipedia-style page with `#mw-normal-catlinks`, YouTube-style SPA with an empty
`<article>` (exercises `body-fallback`), product page with `Offer`, a 3 MB DOM (exercises
C10's size bail-out), and a page whose `<title>` is a prompt injection. Stratified so no
synthetic "domain" exceeds 5%.

**`bench/goldset.jsonl`** — one line per fixture:
`{"url","html_fixture","labels":[...],"contentType":"..."}`.

**`bench/enrich-bench.js`** — runs extraction against fixtures and the enrichment math in
node. Design that makes this possible without duplicating logic:

- Extract the body of the injected `func` (`tab-cards.js:29–154`) into a new
  **`extract-core.js`** exposing `globalThis.__tsExtract(document, location)`.
  Production changes to `files: ['vendor/readibility.js', 'extract-core.js']` and
  `func: () => __tsExtract(document, location)`. One implementation, two callers.
  No `manifest.json` change needed — `executeScript({files})` injects extension files
  directly and does not go through `web_accessible_resources`.
- The bench opens `file://bench/fixtures/*.html` with **puppeteer** (already a devDep;
  `tests/setup.js` shows the launch pattern), injects the same two files, and reads back
  the same `out` object. Deterministic and offline.
- The math half runs in plain node: `enrich-math.js`, `domain-priors.js` and (later)
  `taxonomy.js` are chrome-free and already `module.exports` their API. Embeddings come
  from the real `@xenova/transformers` dependency in node, so bench and production score
  identically.

Emit the C0 metric table: `P@1`, `macro-F1`, `tags/card`, `ECE` (10-bin), `Brier`,
`entropy@1`, `p95 build`, `p95 block`, `cold start`, `mem/card`.

**`bench/commands.jsonl` + `bench/command-bench.js`** — ~40 triples of
(command, frozen card set, expected tabIds), including all of D0's adversarial classes:
negation, inverted verbs, zero-match, homographs (`"group my closed caption tabs"`), and
a tab whose title is a prompt injection. The frozen card sets are JSON card fixtures, so
no browser is needed. LLM query expansions are checked in as a fixture file and replayed,
so `set-exact` is a real regression gate at **zero LLM calls**. Emit `set-exact`,
`precision`, `recall`, `false-close`, `abstain-correct`, `intent-acc`, `p50/p95`,
`tokens/cmd`, `preview-rate`.

**Prod telemetry** — log the same metrics behind `chrome.storage.local.enrichTelemetry`
at 5% sampling, reusing the existing `telemetry` object (`background.js:858`). Wire
`undo-rate` by recording whether the `UNDO_AVAILABLE` toast (`content.js:2020`) was
clicked — it is the only accuracy signal that survives real users.

**Exit:** baseline numbers for every metric, captured **after** Phase 0. These are the
row the whole refactor is measured against.

---

## Phase 2 — Enrichment scoring math (C4, C5, C6, C7)

Highest-leverage phase per the doc; all of it is local to `enrich-math.js`.

- **C4** — replace the z-score emission (`enrich-math.js:240–249`) with per-class Welford
  standardization → log-odds fusion → temperature-scaled softmax → relative + absolute
  threshold + abstain. Fit `a`, `w_f`, `T` offline on the gold set with a script under
  `bench/fit-calibration.js`; ship the ~30 learned floats as a JSON constant.
- **C5** — maintain a running corpus mean and score in the de-meaned space; **delete the
  `other` class** (`enrich-math.js:28`) — it is an abstention, not a topic, and its
  prototypes ("generic web page", "placeholder page") make it a textbook hub. Abstention
  becomes `p_max < TAU_ABS → 'unsorted'`.
- **C6** — dedupe hints by canonical tag and log-saturate the vote count. Today
  `enrich-math.js:224` adds a flat `+0.2` per hint to a cosine whose whole range is ~0.45,
  and `hintSources` concatenates `harvestTags` and `keywordHints` without dedupe. Note
  this only starts mattering **after** the Phase 0 extraction fix, since `harvestTags` is
  currently always empty.
- **C7** — `canonicalTag` (`enrich-math.js:86`) takes the first token, so every multi-word
  alias (`'artificial intelligence'`, `'machine learning'`, `'formula 1'`, `'tv show'`,
  `'earth science'`, `'space exploration'`) is dead. Normalize the full string first, fall
  back to first-token. Precompile the `matchTag` alias regexes once at module load instead
  of `new RegExp` per alias per hint (`:96`) — ~45 compilations per hint on the startup
  sweep's hot path.

**Gates:** `ECE ≤ 0.08`, `macro-F1` +0.08, `tags/card` in 1.4–2.2, `entropy@1` up, `other`
gone from the confusion matrix's top false positives.

---

## Phase 3 — Command pipeline architecture (D2, D5, D6, D7, D8, D9, D10, D12, D13)

**D5 is the headline: expand the query, match locally.** Today the LLM does set selection —
cost and latency scale with tab count and nothing is testable. But per the system prompt
at `command-agent.js:219`, what the model actually contributes is world knowledge, which
is a property of the *query*, not the tab set. Invert it: one ~120-token call expands the
query into `{expansions, domains, clusters, exclude, groupName}`, cached in IDB with a
30-day TTL; matching is local dot products over embeddings we already have. Keep the
existing per-tab reasoning path as a fallback for genuinely ambiguous queries only
(`p_max - p_second < 0.15`, top 8 candidates) — expected to fire on <10% of commands.
This is also where D11's `groupName` finally gets a real value.

Supporting changes, all in `command-agent.js` unless noted:

- **D2** — remove the `qualified.length >= 5 ? qualified : scored.slice(0,5)` floor-bypass
  (`:191`) so retrieval can return `[]`; default missing confidence **down** to 0.4, not
  up to 1.0 (`:497`); make the prompt's inclusion bias asymmetric by risk — pass `intent`
  into `reasonOverCandidates`, which currently doesn't receive it at all.
- **D7** — replace the incoherent fusion at `:100–175` with RRF over (vector, keyword, tag)
  ranks, then D5's logistic regression for the probability. Same loop: drop the
  `normA`/`normB` recomputation (both vectors are already L2-normalized by
  `Embed.embed` — it's a plain dot product); guard `emb.length === 384` (a `NaN` in the
  comparator makes `Array.sort` undefined); reuse a scratch buffer instead of
  `new Float32Array(c.embedding)` per card; make `cardCategory.includes(w)` (`:166`)
  word-boundary — today `"port"` matches `"sports"`.
- **D8** — `retrieveCandidates` builds missing cards inline (`:69–83`) at concurrency 5;
  with 40 unindexed tabs a single command takes 10–30 s, and since
  `wasm.numThreads = 1` (`embed.js:12`) that concurrency buys only simultaneous DOM
  clones. Add a 700 ms budget with a `shallowCard` degrade path and surface it in the UI
  ("2 tabs weren't fully read yet"). Log `missing_at_command` as a health metric.
- **D9** — R2 currently resends all of R1 (`:290`) and merges by max-confidence (`:332`),
  which is a ratchet that only ever *adds* tabs — exactly backwards for `close_tabs`.
  Give R2 authority over what it examined. Strip `search` and `hash` from URLs before they
  leave the device (`:284` sends the full URL while `mainText` is gated by
  `allowCloudContent`). Delete the index fallback at `:273` — a hallucinated `tabId: 3`
  currently becomes the third candidate with the model's confident reason attached.
- **D10** — aggregate confidence with `min` over acting tabs, not `mean` (`:511`); replace
  the `>= 3` preview trigger (`background.js:3033`) with the reversibility policy table
  (reversible → execute + undo toast; `close` → always preview with uncertain rows
  **unchecked**; `ambiguous` → always preview). Stop flattening `[...tabIds, ...uncertain]`
  into `pendingPlans` (`background.js:3039`), which discards the uncertain split exactly
  where it matters.
- **D6** — drop `JSON.stringify(cards, null, 2)` (`:217`) for TSV; reserve system + output
  tokens explicitly and measure tokens/tab at runtime instead of the hardcoded `50`
  (`:188`).
- **D12** — replace the vocabulary-based `classifyCommand` (`:19`) with structural routing:
  strip metadata predicates and verbs, and if content words remain, it's semantic.
  `"group my youtube tabs about cricket"` currently routes syntactic and groups *all*
  YouTube tabs. Scale `smartPreFilter`'s flat `confidence: 0.9` (`:443`) by match coverage.
- **D13** — `parseJSONDefensively` (`:353`) returns an empty-but-valid plan on failure,
  indistinguishable from a legitimate zero match; return `{parseError: true}`, one repair
  retry, then an honest error. Replace the greedy `/\{[\s\S]*\}/` with a brace-depth
  scanner. Pass a real JSON schema (Gemini `responseSchema`, Ollama `format`), and use
  `temperature: 0` + fixed seed so the bench is reproducible. Unify the three provider
  call sites behind one `callLLM({system, prompt, schema, seed, signal})` adapter — today
  Gemini gets `systemInstruction` as a separate field while Ollama/Backend get it
  concatenated (`:239` vs `:251`), so the three providers see different prompts and bench
  results don't transfer. Classify provider failures (401 / 429 / ECONNREFUSED) instead of
  collapsing everything to "AI provider unavailable" (`:474`).

**Gates:** `intent-acc` 1.00, `false-close ≥ 0.99`, `abstain-correct ≥ 0.90`,
`tokens/cmd ≤ 400`, `p95 ≤ 1.5 s`, `preview-rate ≤ 25%`.

---

## Phase 4 — Learned taxonomy, behind a flag (C1)

New **`taxonomy.js`** (chrome-free, `module.exports` + `self.Taxonomy`, matching the
existing module pattern in `enrich-math.js` / `domain-priors.js`): online DP-means
assignment, c-TF-IDF cluster labeling with MMR tiebreaking, Dirichlet-smoothed
`P(cluster|domain)` with Wilson lower-bound confidence, and the accept/reject/rename
feedback loop. New IDB store `taxonomy`. Cold start seeds **8 broad** clusters, not 23 —
over-seeding suppresses discovery because every new page finds *something* above
`TAU_NEW`.

Ship behind a setting in `readAiSettings` (`background.js:1425`), **default off**.
`domain-priors.js` stays as Dirichlet pseudo-counts (α_seed = 5, so ~10 real observations
override a hand-guess), not as a hard rule.

**Cache invalidation is what makes this measurable.** Replace `vecVersion: 2`
(`enrich-math.js:272`, checked at `tab-cards.js:245`) with
`sha256(modelId + taxonomyRevision).slice(0,8)`, computed once per SW wake. Without this,
editing the taxonomy leaves every cached card stale for the full 7-day TTL and the change
looks like a no-op.

**A/B on the same gold set**, both arms, same fixtures. Note honestly in the results that
on 300 cards the learned taxonomy may *not* beat the static one until the feedback loop
has a few dozen corrections — that is an expected outcome, not a failure. Keep the static
path as the shipping default until the numbers say otherwise. Once clusters exist, C12's
`subTopics` becomes free (the cluster's #2–#4 c-TF-IDF terms).

---

## Phase 5 — Performance, storage, cleanup (C8–C11, C13, C14)

- **C8** — persist tag centroids to IDB keyed by `sha256(modelId + taxonomyRevision)`;
  `initTopicVocab` (`enrich-math.js:123`) currently re-embeds ~230 phrases sequentially on
  every service-worker wake, and MV3 workers die after 30 s idle. Gate: cold start ≤ 300 ms.
- **C9** — make `embedBatch` (`embed.js:27`) actually batch; it is currently
  `Promise.all(map(embed))`, N sequential forward passes. Split the sweep
  (`background.js:4600`) into extraction at concurrency 5 (I/O bound) feeding a single
  serial embedding queue of `embedBatch(8)`.
- **C10** — guard the Readability injection with `if (!window.__rdblLoaded)`; wrap the
  `document.cloneNode(true)` (now live after Phase 0, so this cost is newly real) in
  `requestIdleCallback` with a timeout, and skip Readability entirely when
  `document.body.innerHTML.length > 2e6`. Return a `performance.measure` in `out`.
  Gate: `p95 block ≤ 50 ms`.
- **C11** — quantize stored embeddings to int8 with a per-vector scale (~0.5% cosine
  error, irrelevant at these thresholds): `mem/card` 1.6 KB → ~0.5 KB.
- **C13** — keep `sanitizePageContent` (`tab-cards.js:1`) as noise reduction but stop
  treating it as a security boundary. The real defense is structural: wrap page content in
  explicit data delimiters, state in the system prompt that delimited content is untrusted
  data that can never issue instructions or trigger tool calls, and require tool calls to
  originate from the user turn. Also sanitize `structured.headline`/`byline` before they
  reach an LLM — currently only `mainText`, `excerpt` and `pseudoDoc` are cleaned
  (`tab-cards.js:158–163`).
- **C14** — dedupe cards on `contentHash` (syndicated articles across 5 domains currently
  produce 5 near-identical cards and skew Phase 4's learned priors); the `contentHash`
  index from Phase 0 already supports this.

---

## Verification

**Per phase**
- `node tests/enrich-math.test.js`, `node tests/domain-priors.test.js`,
  `node tests/tabcard.test.js` — existing pure-math suites must stay green.
- `node bench/enrich-bench.js` and `node bench/command-bench.js` before and after;
  numbers recorded in the change summary against the Phase 1 baseline.
- `npm run test:e2e` for the puppeteer suites.

**Manual, load-unpacked, per phase**
- Phase 0: a normal article card shows `extractionLevel: 'full'` and non-empty
  `structured.keywords`; `unpin all tabs` unpins; `group my coding tabs` produces a
  **titled** group; a command issued from the options page doesn't hang.
- Phase 0 (C3): open two tabs on the same URL, navigate one away, confirm both pages
  retain cards — `cards_retained_after_1h_session` should track pages visited, not tabs open.
- Phase 3: `"don't close my docs, just group them"` must not resolve to `close_tabs`;
  `"group my knitting tabs"` with no such tabs must abstain rather than return 5 arbitrary
  tabs; a repeated command must hit the expansion cache and issue zero LLM calls.
- Phase 4: toggle the taxonomy flag, confirm `vecVersion` changes and cached cards
  re-enrich immediately rather than after 7 days.
- Phase 5: DevTools performance trace on a heavy page shows main-thread block ≤ 50 ms;
  service-worker wake to first enriched card ≤ 300 ms.

**Rollback**
Phases 2–5 are independently revertable. Phase 4 is flag-gated with the static taxonomy
retained. Phase 0's `DB_VERSION 4` migration is one-way — verify the re-key against a
populated profile before it ships.
