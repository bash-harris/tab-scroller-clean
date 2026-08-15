# Plan — trusted tags, adaptive band, real-tab measurement

## Context

Two measured failures drive this, and neither is a model-quality problem.

**1. The band constant did not transfer.** On 451 real tabs, `187 (41%)` fell into
the cosine ambiguity band and went to NLI. On the 15-tab bench pool the same
constants sent ~2%. 84 cold passes x 1537ms is essentially the whole 141s.
`BAND_LOW = 0.20 / BAND_HIGH = 0.45` (`nli-select.js:117-118`) was calibrated on a
pool too small and too clean to falsify it.

**2. "The Ashes" fails at every expansion weight**, and not for lack of knowledge:

```
w=0.4   want [8]  got []            <- expansion discounted into silence
w=1.0   want [8]  got [1,2,4,8]     <- expansion over-generalised to all cricket
```

The parser already returns the correct knowledge —
`"the ashes" -> ["cricket","test match","england australia"]` — and both installed
models score **8/8** on applied world knowledge (`bench/knowledge-probe.js`),
including `qwen2.5-coder:3b`. The defect is the expansion *mechanism*: `max()` over
terms lets the broadest term win, so an instance query ("the Ashes") becomes a
category query ("cricket"). Note that `"england australia"` uniquely identifies
tab 8 while `"cricket"` also matches tabs 1, 2, 4 — the specific expansion is the
one being drowned out.

**Rejected by measurement, not opinion** — do not revisit without new evidence:

| direction | result |
|---|---|
| batched LLM yes/no selection | 36/92 (39%), 21.9s/command, ~11.5 min at 451 tabs |
| bigger local model for knowledge | both installed models already 8/8 |
| Gemma 27B/31B locally | 3.5x weights on 4GB VRAM, slower than the 7.6B |
| multi-key cloud sharding | quotas are per-project not per-key; needs separate accounts |
| word vectors alone | 71/112 (63%), 36-86 forbidden selections |
| ColBERT / WebGPU / QOperator re-export | deferred: see `PLANS.md`, none measured on this task |

## The discipline this time

Three failures so far — the recall@12 cap, the 25s wall-clock budget, and the
fixed band — share one cause: a constant calibrated on 15 clean tabs. So:

- **No band change ships without being measured on real tab cards.**
- **Nothing ships on a spike.** The hybrid word+doc result (73 -> 89 -> 67 across
  three adjacent thresholds) is a spike, not a plateau. Every result that has held
  up in this project sat in a flat region.
- Every phase reports **violations and band fraction**, not just set-exact.

## Phase 0 — real tab pool (prerequisite for Phases 2-3)

The band problem is a **distribution** problem, so it needs **no labels**. That is
what makes this cheap: accuracy stays on the existing 112-command gold set;
only the band fraction needs real data.

- Add an export path that dumps `tabCards` (title, url, category, tags, embedding)
  from IndexedDB to JSON. Reuse the existing DB accessor in `db.js` rather than
  opening a second connection.
- Save as `bench/real-cards.json` (gitignored — it contains real browsing data).
- New `bench/band-fraction.js`: for a list of representative concepts, score every
  real card by cosine and report **what fraction lands in the band** under each
  strategy. No labels, no NLI, runs in seconds.

Deliverable: the real number replacing the assumption that 2% generalises.

## Phase 1 — tag pre-check before any forward pass

`nli-select.js:354` currently sends every term to NLI. Tab 8 carries the tag
`test-match`; the expansion is `"test match"`. Normalising both (lowercase, strip
non-alphanumerics) makes that an exact hit — no forward pass, no fuzziness.

- Add `tagHit(card, term)`: normalise term and each of `card.enrichment.tags` +
  `category`, compare. Reuse `canonicalTag` from `enrich-math.js` if its
  normalisation matches; it currently splits on the first token
  (`"machine learning"` -> `"machine"`), so verify before reusing rather than
  assuming.
- In the term loop, check `tagHit` first. A hit short-circuits the pass.
- **Scoring is the open question, and it gets swept, not chosen.** A tag hit is
  exact evidence, which argues for full weight — but full weight on a *wrong*
  expansion is exactly the football regression (82% -> 56%, 21 violations). So
  sweep the tag-hit weight for expansions across 0.4-1.0 and read violations
  alongside set-exact.
- Add "most specific expansion wins": prefer the expansion matching the fewest
  cards over the one matching the most, so `"england australia"` beats `"cricket"`
  for an instance query. This is the change that addresses the Ashes directly.

Expected: the 4 knowledge-gap failures close; passes/command drop, since tag hits
replace forward passes. Risk: violations rise. That is the number to watch.

## Phase 2 — adaptive band (this is the 141 seconds)

Replace the two fixed constants with a band derived from the scores that actually
came back for *this* command. Candidate strategies, all cheap over a few hundred
floats:

| strategy | adapts to | risk |
|---|---|---|
| fixed `[0.20, 0.45]` (current) | nothing | measured: 41% on real tabs |
| z-score band | spread | a fixed z-band still catches a fixed fraction |
| percentile band | shape, bounded count | a count cap in disguise |
| largest-gap split | the actual distribution | no real gap = splits on noise |
| EM mixture (Normal + Exponential) | shape, principled | needs a sane fallback |

**Do not pre-commit to one.** New `bench/band-sweep.js` runs all five and reports
three columns: **set-exact** (gold set), **violations** (gold set), and **band
fraction** (real cards from Phase 0). The last column is the one that failed to
transfer last time, so it is the one that decides.

One distinction worth keeping straight: a percentile band is not the same failure
as the old recall@12 cap. The cap **removed tabs from consideration entirely**, so
recall could never recover them. A band still scores every tab — it only decides
which get a second opinion. Tabs outside the band are decided by cosine, not
dropped. It does share the risk that a genuinely ambiguous query gets under-served,
which is why band fraction is reported per strategy rather than assumed.

Target: **5-10% to NLI instead of 41%**, at unchanged set-exact.

## Phase 3 — hybrid word+doc cosine, only if the plateau is real

Measured 89/112 (79%) vs whole-doc 83/112 (74%) — but across thresholds
0.50/0.55/0.60 it scored 73 / **89** / 67. A 16-point spike that collapses 22
points one step later is fitting the 15-tab pool.

- Re-run `bench/word-vec.js` at a finer threshold granularity. **Ship only if 0.55
  sits in a flat region**, the way `EXPANSION_WEIGHT` did (flat across 0.0-0.5).
- If it is a spike, the finding is still worth keeping in `ARCHITECTURE.md` as a
  measured near-miss with the reason it was not shipped.
- If it holds, blend into `cosScores` at `nli-select.js:313-326`. Word vectors are
  built from the same embedder already loaded, cached per unique word, so query
  cost stays at one forward pass.

## Phase 4 — parallel NLI, only if Phases 1-3 leave it too slow

Web Workers in an offscreen document, one ORT session each. A service worker cannot
spawn workers (whatwg/html#8362), so the offscreen document is required as the host
— for threads only, not WebGPU, and with no undocumented API dependency.

Bounded by RAM, not cores: 12 logical cores but **2.2GB free** with 451 tabs open,
so 3-4 workers. Measure per-worker footprint before choosing N; oversubscribing
into swap is slower than staying serial.

Skip this phase entirely if Phase 2 gets the band to ~30 tabs — 30 x 1537ms is
~12s serial, and 4x parallelism on top is optimisation, not a fix.

## Verification

```bash
node bench/band-fraction.js                      # Phase 0: real distribution
node bench/tag-sweep.js                          # Phase 1: tag weight vs violations
node bench/band-sweep.js                         # Phase 2: five strategies, three columns
node bench/word-vec.js --fine                    # Phase 3: plateau or spike
npm run verify                                   # full suite must stay green
```

`npm run verify` already chains units, gold-set integrity, offline smoke, hybrid
test, wasm config, retrieval, selection and the full LLM pipeline. Every phase must
leave it green, including `bench/smoke-mvp.js` — the tag pre-check and the adaptive
band must both degrade cleanly when there is no embedder and no NLI.

End-to-end, the number that matters is the one from the user's own browser: reload
the extension, run `group all entertainment tabs` on the real profile, and read the
telemetry line. Success is `nliTabs` in the tens rather than 187, and `latency_ms`
in single-digit seconds.

## What would falsify each phase

- **Phase 1** — set-exact rises but violations rise with it. Then tag matching is
  buying recall with precision, same trade as the football regression, and the
  most-specific rule is not enough on its own.
- **Phase 2** — a strategy that looks best on the gold set has the worst band
  fraction on real cards. That is the exact shape of the original failure and means
  the gold set is still too clean to choose with.
- **Phase 3** — no flat region exists. Then the +6 was pool-fitting and word
  vectors stay out of the shipping path.
- **Phase 4** — per-worker RAM makes 3 workers unsafe. Then parallelism is off the
  table on this machine and Phase 2 has to carry the whole latency budget.

## Not in scope

Instance-level queries stay partially unreachable even with the most-specific rule:
"pin the Q3 roadmap" vs "switch to the sprint notes" have identical tags and
category. That needs title-level matching and a query-type router, and it is
already documented as a known limitation in `ARCHITECTURE.md`.

