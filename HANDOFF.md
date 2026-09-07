# HANDOFF: tab-scroller-clean gauntlet — state & continuation

Repo: C:\Users\bkh\Desktop\tab-scroller-clean | branch main | HEAD 17ae84d
Session context was hitting API body limits — fresh session, continue gauntlet here.

## Where we are

### Committed rounds (all merged & pushed, do not redo)

**Phase 1 gauntlet (original):** 54→181/181 on suite-v3 (synthetic 117-tab/181-cmd). Commits 9231ac9→67cde7b (R1-R6 + gold fixes).

**Phase 2 (gauntlet-v2):**
- suite-v3 stays 181/181; real-v1 (565 real tabs, 157 cmds) + heldout-v1 (SEALED — 90 tabs, 107 paraphrase-heavy cmds, never-open-in-dev gold) added
- R1 parser slots v2 (18ca3cb), R2 slot interpreter (560b81b), R3 clarify loop (e4fb14d), R4 schema v3 + chaining (fa16d45), R5 SW resilience (1804f27), R4.5 chain activation (20e11e6), R6 UX/honesty (93aa041), R7 perf/freshness (4ab1d37)
- Final eval (ff3fb8c): suite-v3 181/181, real-v1 77/157 ceil + 92/157 floor, v2 103/112, heldout 35/107 (33% — paraphrase brittleness confirmed)

**Phase 3 (drawback gauntlet, current):**
- GA-1 abstain honesty (dfb004c): signalCensus + requires[] cues + abstain veto at semantic-fallback exit. real-v1 abstain 28→41/45, ceiling 77→90/157
- GA-2 duplicates (9ebb565): dupClustersOf union-find (links/exact/tolerance-canonical/title-tier) + dupKeeperSplit direction. cat8 1/8→8/8 viol 0. ceiling 90→97/157
- GA-3 metadata slots (17ae84d): meta [{field,op,value}] 12 fields, paraphrase cues, interpreter leg. cat16/20/27 1/14→14/14. ceiling 97/157 viol 8, floor 106/157 viol 6
- GA-4 first attempt FAILED measurement: 14-example few-shot prompt caused parse drift (suite-v3 181→164, real-v1 97→92, v2 103→76; state-noise, selectAll flips, domain narrowing). REVERTED. Measurement record: rank-cluster 95.8→100 was the only real gain; residuals are 3B model walls.

### Current verified state (all at HEAD 17ae84d)
- suite-v3: 181/181, 0 viol | real-v1 ceiling: 97/157, 8 viol | real-v1 floor: 106/157, 6 viol | v2: 103/112, 3 viol
- npm test: 16 suites green | validate-suite: PASS
- Bench harness: bench/suite-runner.js --suite=<name> (suite-v3|real-v1|heldout-v1), result/emb caches keyed codeHash+poolHash, parse cache bench/.llm-query-cache.json keyed MODEL_TAG|command (NO prompt hash yet)
- heldout-v1 gold SEALED: bench/heldout-v1.commands.jsonl must NEVER be opened by dev-loop agents; final eval by fresh agent only

## GA-4 v2 — what to do (the remaining round)

Goal: paraphrase robustness via few-shot + hard negatives, done so it can actually pass measurement. Use the gauntlet loop (builder subagent + critic subagent), NOT inline.

Builder brief (dispatch as general subagent):
1. Re-land infra: PROMPT_HASH export in llm-query.js (SW-safe sync hash of SYSTEM, e.g. djb2 — no node crypto in SW context); key parse caches in bench/suite-runner.js (~L174-176 parseQkey), bench/llm-nli-integration.js (~L94), bench/llm-batch.js with MODEL_TAG|PROMPT_HASH|command. Old cache entries stay (unreachable, history).
2. MINIMAL prompt edit (the first attempt failed from bloat — 15.1k→22.5k chars): append to SLOT_EXAMPLES (llm-query.js L102-105) ONLY ~2-3 compact lines targeting the one measured model miss: rank-vs-time boundary. Example line: "close tabs from the last five minutes" -> {"intent":"close_tabs",...,"time":{"basis":"opened","op":"within","value":"5_minutes"},...,"rank":null...}. NO 14-example block. Keep total SYSTEM growth <1.5k chars. Do NOT reword existing examples (leakage rewording is moot post-revert).
3. Register tests/parser-fewshot.test.js (lean: stamp assertions + leakage grep vs golds) in tests/run-phase0.js.
4. A/B measurement: fresh-parse a ~12-command paraphrase probe (rank/time cluster + directs) BEFORE and AFTER the edit (Ollama qwen2.5-coder-3b-ctx, noCache). Report field-accuracy delta.
5. FULL gates with fresh parses (stamps invalidate — expect ~15-20min): suite-v3 181/181/0 REQUIRED (parse drift = REJECT, revert), real-v1 ceiling >=97/157 viol<=8, floor >=106/157 viol<=6, v2 103/112/3, npm 17 suites, validate-suite PASS.
6. If gates fail from drift: revert the prompt edit (git restore llm-query.js), keep infra, report honestly. Few-shot-on-3B may simply be a dead end — that is an acceptable finding; do NOT force it.

Critic brief: integrity (prompt-only diff in llm-query + bench keying + tests), leakage grep (few-shot strings vs ALL gold files incl. heldout), verify stamp actually invalidates (fresh parse of one command under new key), drift audit (fresh vs cached parse JSON diff on 5 suite-v3 commands), all gates reproduced, PROMPT_HASH determinism.

## After GA-4 (any outcome)

Final eval round: dispatch a FRESH agent (never in dev loop) to run heldout-v1 sealed (--suite=heldout-v1) + all open suites + report the 4-suite scorecard vs baseline (heldout baseline 35/107, 13 viol — bench/.heldout-baseline.txt). Zero regressions vs baseline required; category table; honest transfer verdict.

## Key files
- Gold (read-only for builders): bench/suite-v3.commands.jsonl, bench/real-v1.commands.jsonl
- SEALED: bench/heldout-v1.commands.jsonl + pool (lead authored; dev agents never read gold)
- Pools: bench/suite-v3.pool.json (117 tabs), bench/real-v1.pool.json (565), bench/heldout-v1.pool.json (90)
- Test harness: tests/run-phase0.js (16 suites), bench/validate-suite.js
- Subagent dispatch flaky today (auth timeouts / read body fails) — retry once, then build inline as fallback; NEVER let a dead builder session's half-written code linger (check git diff before redispatch)

## Merge discipline (unchanged)
- Every round: builder → critic → (repair if REJECT) → merge only on zero regressions across all open suites + npm green + validator PASS
- Commit style: "gauntlet GA-x (name): what. numbers. Critic ACCEPT/REJECT->repair."
- Push after every merge
