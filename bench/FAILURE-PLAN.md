# Plan: the 27 remaining failures

Baseline: **85/112 set-exact (76%)**, precision 81%, recall 82%, 0 violations
(`node bench/nli-integration.js bench/commands-v2.jsonl`).

I planned this off measured entailment scores rather than the pass/fail list
(`bench/diagnose-failures.js`). That changed the plan twice — see "What the data
overturned" at the end.

## Root causes, by measured evidence

| # | cause | failures | fix | risk |
|---|---|---|---|---|
| **F1** | concept pollution — junk words in the hypothesis | **~12** | extend FILLER | very low |
| **F2** | no fuzzy matching for typos | 7 | trigram fallback | low |
| **F3** | no set algebra (and / or / both) | 4 | multi-concept parse | medium |
| **F4** | no world knowledge | 4 | cached LLM expansion | medium |
| **F5** | over-selection near threshold | 3 | relative margin | medium |

Counts overlap — the typo cases are also polluted — so F1 must land first, then
everything gets re-measured before the next step is scoped.

---

## F1 — concept pollution (do first)

**Not a model weakness. A bug in `concept-core.js`'s FILLER list.**

The concept becomes the hypothesis: `This browser tab is about {concept}.`
Leftover junk words change the proposition being tested. Measured, same tab,
same model, only the concept string differing:

| command | concept sent | score | cleaned | score |
|---|---|---|---|---|
| "search for the clean energy page" | `search clean energy page` | **0.07** | `clean energy` | **0.93** |
| "bookmark both planning documents" | `both planning documents` | **0.38** | `planning documents` | **0.99** |
| "sort the two Google Docs tabs" | `two google docs` | **0.37** | `google docs` | **0.96** |
| "show me bitcoin tabs" | `show bitcoin` | **0.57** ← false positive | `bitcoin` | **0.10** |

That last row is the one that matters most: the pasta tab was selected for a
bitcoin query at 0.57 purely because `show` was in the hypothesis. Cleaning the
concept fixes a false positive *and* four false negatives.

**Change:** add to `FILLER` in `concept-core.js` — `page`, `pages`, `story`,
`article`, `tutorial`, `guide`, `both`, `two`, `three`, `every`, `each`, `show`,
`search`, `switch`, `instead`, `it`, `them`, `here`, `there`, `stuff`, `thing`.

**Guard:** `search`/`show`/`switch` are verbs in `INTENT_VERBS`. Removing them
from the concept must not change intent detection — the parser reads the action
before stripping filler, but that ordering needs a test, not an assumption.

Expect ~12 cases. Highest value, lowest risk, no new dependency.

---

## F2 — typos (7 cases)

`criket` scores 0.30–0.47 against cricket tabs: the model half-recognises it.
After F1 removes `mut`/`relod`/`bookmrk` from the concept, the signal is cleaner
but still short of 0.55.

**Change:** in `retrieveCandidates`, when a concept word matches no candidate
text, try a trigram-similarity match (Dice coefficient ≥ 0.6) against tab title,
category and tag words; substitute the corrected word. Deterministic, no model.

**Guard — this is the dangerous one.** Fuzzy matching *invents* matches. Two
required properties:
1. Only rewrite a word that matches **nothing** literally. `close` must never
   become `clothes`.
2. The 8 empty-expectation cases (`crypto`, `bitcoin`, `ethereum`) must still
   return `[]`. Correcting `bitcoin` → `britain` would be a serious regression.

Ship only if empty-expectation cases stay at 8/8 and violations stay at 0.

---

## F3 — set algebra (4 cases)

`concept-core.js` returns **one** concept string, so "cricket and YouTube"
becomes the single concept `cricket youtube`, which entails almost nothing —
tab 14 scored **0.00** when it should be selected via YouTube.

| command | want | got |
|---|---|---|
| "close my cricket and YouTube tabs" | 1,2,4,8,14 | 2 |
| "group sports and entertainment tabs" | 1,2,3,4,7,8,14 | 2,3,4,13 |
| "bookmark pages that are both video and cricket" | 2 | 1 |

**Change:** return `concepts: [...]` plus `combine: 'union' | 'intersection'`.
Split on `and`/`or`/`plus`; `both X and Y` and `that are both` signal
intersection, otherwise union. Score each concept separately, then set-combine.

**Interaction with F4:** union/intersection must be decided *before* query
expansion, or expansion terms get merged into the wrong branch.

---

## F4 — world knowledge (4 cases)

The Ashes (0.02), "rate hikes" (0.02), "stock market" (0.02 — and it stays 0.00
even when cleaned, so F1 does **not** fix this one). The model genuinely does not
know these; no threshold change reaches them.

**Change:** the cached LLM expansion from the earlier plan. One call per *concept*
(not per tab), cached in IDB with a 30-day TTL, returning `includes` / `excludes`
/ `domains`. Score the tab against the expansion terms and take the max.

Off the hot path: a repeated command costs zero. Needs `qwen2.5:1.5b-instruct`
(~1GB), not `qwen2.5-coder` — a code model is what produced "LeetCode
entertainment tab".

**Do this last.** It is the only item requiring a model download and a new
cache, and F1–F3 may shift which cases still fail.

---

## F5 — over-selection (3 cases)

Genuinely hard calls, not bugs:

- "close the Premier League table" → Thailand beaches at **0.95** (the model
  reads "table" loosely)
- "group the entertainment tabs" → captions tutorial at **0.97** (defensible —
  it is a video-editing page)
- "pin all renewable-energy pages" → Sprint Notes at **0.62**

**Change:** when the top score is very high (≥0.9), require others to be within
a relative margin of it rather than merely above 0.55.

**Risk: this is the change most likely to backfire.** It trades recall for
precision, and the earlier V2 experiment did exactly that and lost 36 points of
recall. Attempt only after F1–F4, and only if the margin can be tuned without
recall loss on the full 112. If it cannot, **drop it** — 3 cases is not worth a
recall regression.

---

## Order and gates

```
F1 concept pollution   ~12 cases   very low risk   ← start here
   └─ re-measure; F2/F3 scopes will change
F2 typo fuzzy match      7 cases   low risk        gate: empties 8/8, violations 0
F3 set algebra           4 cases   medium risk     gate: no single-concept regression
F4 LLM expansion         4 cases   medium risk     gate: cache hit rate, offline path
F5 relative margin       3 cases   HIGH risk       gate: zero recall loss, else drop
```

After each step: `node bench/nli-integration.js bench/commands-v2.jsonl` plus
`npm test`. Any recall drop or new violation reverts that step.

**Realistic expectation:** F1+F2 should reach roughly 95–100/112 (85–89%). F3–F5
are worth ~11 more but carry real regression risk, so I would not promise them
as a block. 100% on this set is not a goal — some cases are genuinely ambiguous,
and tuning until they pass would be fitting the benchmark rather than the task.

---

## What the data overturned

Two things I had planned to do, that measurement showed were wrong:

1. **I would have built the fuzzy-match layer first.** It was the obvious read
   from the failure list. But the typo cases are also concept-polluted, so
   F1 changes their scores — building F2 first means tuning thresholds against
   numbers that are about to move.

2. **I would have attributed "clean energy" and "planning documents" to missing
   world knowledge.** They are not: cleaned of junk words they score 0.93 and
   0.99. Only 4 cases are genuine knowledge gaps, not the ~8 the failure list
   suggested. The expensive LLM fix is a quarter the size I thought.

Both corrections came from dumping raw entailment scores rather than reading
pass/fail — which is why `bench/diagnose-failures.js` exists.
