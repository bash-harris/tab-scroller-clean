# Tab Scroller — Claude Code Session Review

**Session ID:** `8ad6b862-acd2-4e17-ba6b-665ccde45e22`
**Size:** 9.72 MB | **Dates:** Aug 9–12, 2026
**Model:** Claude Opus 5 (1M context) — multiple context resets chained

---

## 1. REFACTOR-PLAN.md Review

Read the refactor plan, verified claims against source code. Found 3 real bugs:

- `tab-cards.js:23` injects `vendor/readability.js` but disk has `vendor/readibility.js` → extraction dead
- `background.js:495` strips `.` → domain routing dead
- `db.js:29` `keyPath: 'tabId'` → cards overwrite on navigate

Produced a 6-phase improvement plan (Phase 0–5) covering bug fixes, bench harness, enrichment math, LLM role inversion, learned taxonomy, and perf/storage.

---

## 2. Amazon Interview Demo Prep

Remodeled the plan for a **hiring manager interview round**. Created `INTERVIEW-DEMO-PLAN.md`.

### 3-Act Structure

| Act | Time | Content |
|-----|------|---------|
| **Act 1** — The Silent Failure | 4 min, live demo | Show `extractRichPageData` returning `null`. Show `close youtube.com tabs` → `close youtube com tabs`. Punchline: "every card has empty `mainText` and I shipped it that way." |
| **Act 2** — Refused to Tune Before Measuring | 4 min | `node bench/enrich-bench.js`, show baseline. Point is discipline: "I had 28 review items and no way to tell if any helped." |
| **Act 3** — Pick Exactly Two Changes | 8 min | **D5 LLM inversion** (cost scaled with tab count; moved 120-token call to query, cached 30 days, matched locally) + **perf bundle** (cold start, batching, int8 — MV3 workers die at 30s idle). |

### Key One-Liner

> "Two of TabScroller's flagship AI features had never executed once. I found it reading source, not docs. Fixed in ~2 lines, built a benchmark to prove it, then did the real work with numbers behind every change."

### Cut List

- **Phase 4 entirely** (DP-means, c-TF-IDF, MMR, Dirichlet) → convert to closing line: "A/B'd it, didn't beat baseline at 300 cards. Shipped default-off."
- **Metric sprawl** → present only 3: `false-close`, `tokens/cmd`, `p95`
- **Jargon** → plain terms (RRF = "combine three rankings")

### Blind-Spot Prep

- "Why didn't a test catch it?" → No test asserted `extractionLevel`; catch swallowed the error
- "You wrote a bug that killed your flagship feature?" → Own it flat, pivot to swallowed catch
- "What's riskiest?" → `DB_VERSION 4` one-way migration
- "What did Phase 0 make worse?" → `cloneNode(true)` cost now real; C10 idle-guard is mitigation
- "Numbers?" → Need real ones; nothing landed yet

### Honesty Traps

- If docs were AI-generated, say so unprompted — "I treated the review as a hypothesis, not a spec"
- If no users, don't imply impact — "No users yet — undo-rate telemetry is how I'd validate"

---

## 3. Phase-by-Phase Implementation with Tests

### Phase 0 — Critical Bug Fixes

| Bug | File | Fix |
|-----|------|-----|
| Readability filename typo | `tab-cards.js:23` | `readibility.js` → `readability.js` |
| `sanitizeQuery` strips `.` | `background.js:495` | Preserve `.` and `/` in sanitizer |
| Intent ladder ordering | `command-agent.js` | Anchored negation-aware `INTENT_RULES` |
| `groupName` undefined | `background.js` | Fallback chain for group names |
| `tabId` key causes overwrites | `db.js:29` | Re-key `tabCards` to `urlHash`, DB_VERSION 4 + migration, new indexes |

### Phase 1 — Bench Harness

- ~60 frozen HTML fixtures + goldset
- Extracted `extract-core.js` (shared by prod + bench)
- Puppeteer for extraction, plain node for math
- ~40 command triples with replayed LLM expansions

### Phase 2 — Enrichment Math

- Welford standardization + log-odds fusion + temp-scaled softmax + abstain
- Deleted `other` class (hub)
- Deduped + log-saturated hints
- Fixed `canonicalTag` first-token bug, precompiled alias regexes

### Phase 3 — Architecture Invariants

- Deterministic command pipeline
- Embedding determinism tests
- Architecture invariants suite

### Test Files Created

- `tests/extract-core.test.js` — 25 tests
- `tests/intent.test.js` — intent ladder tests
- `tests/group-name.test.js` — 31 tests
- `tests/executetool.test.js` — tool execution tests
- `tests/db-search.test.js` — database search tests
- `tests/tabservice.test.js` — tab service tests
- `bench/` — extraction bench, enrichment bench, report scripts

---

## 4. Caveman Skill Removal

Permanently removed the "caveman" skill symlink from `~/.claude/skills/` and updated CLAUDE.md.

---

## 5. Luxury UI Redesign

### First Attempt (Rejected)

Flat/minimalist/sans-serif overhaul. User response: "no elegance whatsoever. I need expensive font, ivory, black and Gold with matte UI with rich components like from an expensive luxury website."

### Palette Decision (Confirmed)

**Ivory (light base):** warm ivory/cream bar and popup, near-black text, gold accents, gold hairline, gold on hover, gold progress.

### Bug Fixes (4 interaction issues)

All rooted in the AI popup living inside the `trigger` element:

| Bug | Root Cause | Fix |
|-----|------------|-----|
| Can't type in AI search | Global `handleKeyDown` capture-phase interceptor | `if (aiPanelOpen) return;` at line 1440 |
| Clicking search collapses extension | Auto-hide `startHideTimer` fires while panel open | `|| aiPanelOpen` guard at line 514 |
| Wheel over AI popup scrolls tab strip | Wheel handler on `trigger` catches popup events | `.closest('.ts-ai-popup')` bail at line 1885 |
| Enter intercepted by extension | `handleKeyDown` `preventDefault()` before popup sees it | Same `aiPanelOpen` guard |

### CSS Conversion (1891 lines)

Full conversion from "Gold on Charcoal" dark → "Editorial luxury — ivory":

- **Token flip:** `:host` variables → ivory `#f0e7d4` bg, near-black `#211c14` text, muted gold `#9c7817` accent
- **45 hardcoded overlays** converted: white `rgba(255,255,255,x)` → warm dark fills, black shadows → soft warm shadows
- **Primary surfaces:** bar, AI button/popup/input/suggestions/progress all restyled as luxury components
- **Gold gradient** on confirm/primary buttons, progress fill
- **Light-theme overrides** rewritten from blue to gold/ivory tokens

### Font Bundling

| Font | File | Size | Purpose |
|------|------|------|---------|
| Playfair Display | `fonts/playfair-display.woff2` | 38,404 bytes | Display serif (headings, UI) |
| Cormorant Garamond | `fonts/cormorant-italic.woff2` | 23,660 bytes | Italic emphasis |

- Registered in `manifest.json` `web_accessible_resources`
- `__TS_EXT__` placeholder in CSS → `chrome.runtime.getURL("")` rewrite in content.js
- Graceful fallback: `"TS Playfair", "Playfair Display", "Bodoni MT", "Didot", Georgia, serif`

### Verification

- `node --check content.js` → OK
- manifest.json validated as OK JSON
- Interaction bug guards confirmed intact (lines 514, 1440, 1885)
- No leftover dark literals (only intentional translucent gold tints)

---

## 6. Final Requests (Completed)

| Task | Status | Description |
|------|--------|-------------|
| #28 | Complete | content.css: flat bg-mode tokens + token audit |
| #29 | Complete | options: add Background (ivory/black) toggle |
| #30 | Complete | content.js: applyBackground wiring + class toggle |
| #31 | Complete | content.js: restyle action-window modals to luxury |
| #32 | Complete | Verify: `node --check` + JSON validation + test suites |

**User's request:** "The colour looks like a gradient starting from ivory till black. Add an option in the options page to make the background either completely black or ivory, not a gradient. Also the action window that shows the selected tabs and unclear items needs to follow the same design." (Delivered)

---

## Files Modified/Created

### Core Extension Files
- `content.js` — CSS injection `__TS_EXT__` rewrite, 3 interaction bug fixes, progress bar wiring
- `content.css` — Full ivory luxury redesign (1891 lines)
- `background.js` — sanitizeQuery fix, intent ladder, groupName fallback
- `command-agent.js` — Intent rules rewrite, exports
- `db.js` — DB_VERSION 4 migration, urlHash re-key, new indexes
- `tab-cards.js` — Readability filename fix, card eviction, extractedAt
- `manifest.json` — Font web_accessible_resources

### Test Files
- `tests/extract-core.test.js`
- `tests/intent.test.js`
- `tests/group-name.test.js`
- `tests/executetool.test.js`
- `tests/db-search.test.js`
- `tests/tabservice.test.js`

### Benchmark Files
- `bench/extract-core.js`
- `bench/enrich-bench.js`
- `bench/report-extraction.js` (multiple iterations)

### Documentation
- `INTERVIEW-DEMO-PLAN.md`
- `CONVERSATION-REVIEW.md` (this file)

### Fonts
- `fonts/playfair-display.woff2`
- `fonts/cormorant-italic.woff2`
