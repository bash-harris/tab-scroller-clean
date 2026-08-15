# Plans from the research doc

Context: 451 tabs, 1537ms per cross-encoder forward pass measured in-browser,
187 tabs (41%) landing in the ambiguous band, 141s total. Three fixed constants
have now failed at real corpus size (shortlist 30→12, a 25s clock, a fixed
cosine band). The research names three independent levers.

## The three levers attack different multipliers

Total cost = (tabs needing the expensive model) x (cost per model call)

| lever | attacks | effect |
|---|---|---|
| **ColBERT late interaction** | the *number* of calls | N calls -> **1**, structurally |
| **WebGPU via offscreen doc** | the *cost* of a call | 1537ms -> ~20-50ms (claimed) |
| **EM score calibration** | *how many* tabs are ambiguous | fixed band -> per-query fitted |

ColBERT and WebGPU are **alternatives**, not complements. ColBERT makes the
architecture right; WebGPU makes the wrong architecture fast. If ColBERT lands,
WebGPU is unnecessary. EM calibration only matters if a cascade survives at all.

---

## Plan 1 — Measure ColBERT (do this first; it decides everything)

**Why first:** it is the cheapest decisive test in the set. A bench script against
the existing 112-command gold set, in Node, no extension changes, no migration.
Its result eliminates one of the two remaining plans outright.

**Mechanism.** A cross-encoder is accurate because query and document interact
inside the model, which is exactly what makes it un-amortizable. ColBERT keeps
per-token embeddings for the document, computed at index time, and defers the
interaction to **MaxSim** — for each query token, take its best-matching document
token, sum those maxima. The interaction survives; the neural cost does not.

For 451 tabs at ~15 tokens and 48 dims: 451 x 15 x 48 x 4 bytes = **1.3MB**.
Query time: one forward pass for the query (~100ms WASM at 17M params) plus
~325k dot products, which is a few ms in a `Float32Array` loop.

**Projected: ~150ms total, no GPU, no band, no cap.**

**The number that must be measured, not assumed:** the doc's "~87% accuracy" is
not sourced to a task like mine. The cited BEIR average of 0.490 is retrieval
nDCG@10 — *passage ranking*, not topical set-selection. My task scores
cross-encoder 89% / bi-encoder 74% on set-exact. Where ColBERT lands between
those is genuinely unknown, and assuming a benchmark transfers across task and
corpus is the precise mistake I have now made three times.

**Steps**
1. `bench/colbert-bench.js` — load `onnx-community/mxbai-edge-colbert-v0-17m-ONNX`
   via transformers.js, `pipeline('feature-extraction')` **without pooling** to get
   per-token output. Verify the graph actually emits `[tokens x 48]` and not a
   pooled vector — flagged as unverified in the model card.
2. Encode all 15 pool tabs to token matrices; encode each command; MaxSim; score
   set-exact/precision/recall/violations exactly as `bench/llm-nli-integration.js`.
3. Sweep the MaxSim decision threshold the way `bench/expansion-sweep.js` swept
   expansion weight — report the whole curve, not one number, so a flat region is
   visible if it exists.
4. Re-run on a **large pool**, not just the 15-tab set. Every failure so far came
   from a constant validated on 15 clean synthetic tabs.

**Decision**
- **>= 85% set-exact** -> ColBERT replaces the cross-encoder. Plans 2 and 3 become
  unnecessary. Latency problem closed.
- **78-85%** -> ColBERT becomes stage 1 over all tabs; cross-encoder adjudicates a
  much smaller band. Needs Plan 2 for the band.
- **~74%** (no better than cosine) -> dead. Go to Plan 3.

**Cost:** a few hours. **Risk:** low — pure bench work, nothing shipped.

---

## Plan 2 — Replace the band constants with per-query EM calibration

**The failure this fixes.** `BAND_LOW = 0.20` / `BAND_HIGH = 0.45` were calibrated
where the band caught ~2% of tabs. On 451 real tabs it caught **41%**. Clean
synthetic titles give a tight bimodal score distribution; real titles like
"(3) New Message" give a diffuse one. Same constant, different distribution,
catastrophic difference. This is textbook covariate shift.

**Mechanism (Arampatzis & Robertson).** Model the score distribution of the
*current* query's 451 scores as a mixture: a Normal for relevant documents and an
Exponential for non-relevant ones. Fit by Expectation-Maximization at query time,
then take the threshold where posterior relevance crosses the operating point.

Why it survives what fixed thresholds did not: it is fitted to the scores that
actually came back **this time**, so there is no calibration set to drift from and
no constant to transfer. A sharp query separates cleanly and the band tightens
automatically; a vague query overlaps and the band widens. That is the behaviour I
kept trying and failing to hardcode.

EM over 451 scalars is sub-millisecond in JS.

**Notably rejected by the research: conformal prediction.** I flagged it as the
most promising lead in the prompt. The doc's assessment is that standard CP
assumes exchangeability, which my data explicitly violates, and the fix
(Weighted CP, Tibshirani et al.) needs on-device labelled calibration data plus
real-time density-ratio estimation. Too heavy here. Worth stating in the writeup
as a considered-and-rejected alternative rather than an oversight.

**Steps**
1. `em-calibrate.js` — Normal-Exponential mixture, EM, threshold at the crossing.
   Pure function over a score array, no dependencies, unit-testable.
2. `bench/calibration-bench.js` — compare fixed band vs EM on the gold set. Must
   show equal-or-better set-exact **and** a large drop in tabs routed to the
   expensive stage.
3. Test on a deliberately skewed score distribution to confirm it adapts where the
   constant did not — the direct regression test for this class of bug.
4. Only then wire into `nli-select.js`, replacing both constants.

**Cost:** ~half a day. **Risk:** low, and it is self-contained.
**Only needed if a cascade survives Plan 1.**

---

## Plan 3 — Offscreen document + WebGPU

**Only if ColBERT fails.** This keeps the cross-encoder and makes each call cheap
instead of removing the calls. It is the largest engineering lift and the one most
exposed to the host machine.

**Mechanism.** WebGPU is genuinely unavailable in an MV3 service worker — no DOM,
no `navigator.gpu`. `chrome.offscreen.createDocument()` creates a hidden real
document; ONNX Runtime's WebGPU backend runs there, and the worker talks to it by
message passing.

**Verified corrections to the research doc**
- Lifecycle is *better* than the doc claimed. Chrome documents a 30s idle teardown
  for `AUDIO_PLAYBACK` only; **all other reasons set no lifetime limit.** No
  keepalive port needed.
- **`navigator.gpu` in an offscreen document is not documented.** Chrome's
  offscreen page never mentions WebGPU and has no GPU reason value. It should be
  present because the document is a real DOM context, but that is inference.

**Step 0, before anything else is built:** ship a throwaway offscreen document that
logs `typeof navigator.gpu`, requests an adapter, and reports the result. Twenty
lines. If `navigator.gpu` is absent or no adapter is available on this 4GB card,
the entire plan dies and nothing was invested.

**Then**
1. `offscreen.html` + `offscreen.js`, model loaded there with the WebGPU EP.
2. Move NLI scoring out of the worker; `chrome.runtime.sendMessage` both ways.
3. Handle re-creation — documents can vanish across worker restarts. Use the
   documented `getContexts()` guard pattern.
4. Fallback path to WASM when no adapter exists, so machines without WebGPU
   degrade rather than break.

Even at 30ms/pass, 451 tabs is 13.5s — so this **still needs a cascade**, and
therefore still needs Plan 2. That is the strongest argument for trying ColBERT
first: it removes the need for both.

**Cost:** 1-2 days. **Risk:** high — new execution context, IPC, lifecycle, and a
hard dependency on host GPU support.

---

## Plan 4 — QOperator re-export (cheap fallback, insufficient alone)

Explains the 5% SIMD result precisely. The model is QDQ format; when the WASM
execution provider cannot fuse a QDQ triplet it **silently dequantizes to fp32 and
runs scalar** — which is why the graph holds 1896 fp32 `MatMul` against 74
`MatMulInteger`. SIMD only ever accelerated the 4% that fused.

Re-exporting with `quant_format=QOperator` forces integer kernels. Claimed gain:
**2-4x**. That is 1537ms -> ~400-750ms: real, but nowhere near enough on its own.

Worth doing as the no-GPU fallback path. Not worth doing as the primary fix.

---

## Confirmed as already correct — no work needed

**Flat-array brute force beats any ANN index below ~5-10k documents.** HNSW's graph
construction cost per insertion is wrong for a corpus where tabs open and close
constantly, and its memory overhead is 2-3x the raw vectors. 451 x 384 floats is
~692KB in one `Float32Array`; append is O(1), delete is swap-and-pop, and a full
scan is <2ms. Integrating a vector DB here would be misallocated effort.

**Distillation is a dead end for now, but the reasoning is worth keeping.** A
classification head over a fixed taxonomy would bake in the label set and break
open-vocabulary queries. Continuous distillation (Margin-MSE) *does* preserve it,
because the student stays a subword transformer projecting into a continuous
space. But it needs on-device backprop in WASM, and ColBERT gets comparable
benefit with no training at all.

---

## Recommendation

Run **Plan 1** first and let the number decide. It is a few hours of bench work
with nothing shipped, and it eliminates either Plan 3 or itself.

The reason to prefer ColBERT over WebGPU on the merits, not just on cost: the
problem has always been that selection is O(tabs) in model calls. WebGPU divides
that by 50 and leaves it O(tabs) — the same shape that produced every failure so
far, just further from the cliff. ColBERT makes it O(1), which is the property
that stops the next corpus-size surprise from mattering.

And the discipline that has to hold this time: **measure it on a large, messy pool
before believing it.** Every one of the three failures came from a number that was
true on 15 clean tabs.
