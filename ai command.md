Batch 1 of 2, D0 through D6. Say the word and I'll drop D7-D13.

````markdown
# AI COMMAND PIPELINE - LATENCY + ACCURACY REFACTOR (BATCH 1: D0-D6)
Same rule as Part 1: nothing in D4+ ships without before/after numbers from
`bench/command-bench.js`. Fix D1 first, it's a data-loss bug.

---

## D0 - THE EVAL HARNESS (P0)

**New: `bench/commands.jsonl`** - 100 triples of (command, frozen tab set, expected tabIds).
Include 20 adversarial cases: negations ("don't close my docs"), inverted verbs ("unpin
everything"), zero-match queries ("group my knitting tabs"), homographs ("group my closed
caption tabs"), and one tab whose *title* is a prompt injection.

| Metric | Why it matters | Measure today | Gate |
|---|---|---|---|
| `set-exact` | plan == expected set | ? | >= 0.75 |
| `precision` | wrong tabs acted on | ? | >= 0.95 |
| `recall` | tabs missed | ? | >= 0.85 |
| **`false-close`** | precision on `close_tabs` only | ? | **>= 0.99** |
| `abstain-correct` | zero-match queries returning zero | ? (expect ~0.0, see D2) | >= 0.90 |
| `intent-acc` | verb -> intent correctness | ? (expect ~0.85, see D1) | 1.00 |
| `p50 / p95 latency` | command -> action | ? | <= 600ms / <= 1.5s |
| `tokens/cmd` | in + out | ? (expect ~2000) | <= 400 |
| `$/cmd` | unit economics | ? | <= $0.00005 |
| `preview-rate` | % commands forcing a dialog | ? (expect >80%) | <= 25% |
| `undo-rate` | prod regret signal | ? | <= 3% |

`undo-rate` is the only accuracy metric that survives contact with real users. Wire it now:
you already fire `UNDO_AVAILABLE`, so log whether it was clicked.

---

## D1 - INTENT PARSING IS BROKEN FOR INVERTED VERBS (P0, data loss)

```js
cmdLower.includes('pin')   ? 'pin_tabs'   :
cmdLower.includes('unpin') ? 'unpin_tabs' :
cmdLower.includes('mute')  ? 'mute_tabs'  :
cmdLower.includes('unmute')? 'unmute_tabs':
```
`"unpin all tabs"` contains `"pin"`, and `pin` is tested first. **`unpin` and `unmute` are
unreachable.** Every unpin command pins. Every unmute command mutes.

Worse: `cmdLower.includes('close')` is tested first of all, so `"group my closed caption
tabs"` and `"don't close anything, just group them"` both resolve to **`close_tabs`**, the
one destructive intent. There is no negation handling anywhere in the pipeline.

Replace the ladder with ordered, anchored, negation-aware matching:

```js
const INTENT_RULES = [
  // longest/most-specific first; \b anchors; explicit negation handling below
  [/\bun-?pin\b/,                           'unpin_tabs'],
  [/\bun-?mute\b|\bunsilence\b/,            'unmute_tabs'],
  [/\bpin\b/,                               'pin_tabs'],
  [/\b(mute|silence)\b/,                    'mute_tabs'],
  [/\b(close|kill|remove|dismiss)\b/,       'close_tabs'],
  [/\b(bookmark|save)\b/,                   'bookmark_tabs'],
  [/\b(reload|refresh)\b/,                  'reload_tabs'],
  [/\b(sort|reorder|arrange)\b/,            'sort_tabs'],
  [/\b(find|search|switch|jump)\b/,         'search_and_switch'],
  [/\b(group|cluster|organi[sz]e|bundle)\b/,'group_tabs'],
];

const NEGATION = /\b(don'?t|do not|never|except|excluding|but not|other than|avoid)\b/;

function parseIntent(cmd) {
  const c = cmd.toLowerCase();
  const hits = INTENT_RULES.filter(([re]) => re.test(c));
  if (!hits.length) return { intent: 'group_tabs', ambiguous: false };

  // negated destructive verb => never auto-resolve to the destructive intent
  const negated = NEGATION.test(c);
  const destructiveHit = hits.find(([, i]) => i === 'close_tabs');
  if (destructiveHit && negated) {
    const alt = hits.find(([, i]) => i !== 'close_tabs');
    return { intent: alt ? alt[1] : 'group_tabs', ambiguous: true, note: 'negated close' };
  }
  // two non-negated verbs ("close duplicates and pin the rest") => ask, don't guess
  if (hits.length > 1 && !negated) {
    return { intent: hits[0][1], ambiguous: true, note: 'multi-verb' };
  }
  return { intent: hits[0][1], ambiguous: false };
}
```
`ambiguous: true` must force a preview regardless of confidence. Gate: `intent-acc` = 1.00
on the D0 adversarial set.

---

## D2 - RETRIEVAL CANNOT ABSTAIN, AND THE PROMPT IS BIASED TOWARD INCLUSION (P0, data loss)

Two lines that combine badly:

```js
const result = qualified.length >= 5 ? qualified : scored.slice(0, 5);
```
```
Be inclusive - if a tab is plausibly related, include it with lower confidence
rather than excluding it.
```
When nothing matches, retrieval hands the model **5 arbitrary tabs anyway**, and the prompt
instructs it to be generous. Then:

```js
const confidence = (Number.isFinite(rawConf) && rawConf > 0) ? rawConf : 1.0;
```
A model that omits `confidence` gets **1.0**, the most dangerous possible default.

Composed failure mode: `"close my crypto tabs"` with zero crypto tabs -> 5 random tabs -> model
nudged to include them -> missing confidence -> 1.0 -> high plan confidence -> destructive, so it
previews, but the preview shows 5 confidently-reasoned wrong tabs and users confirm previews.

Fixes, all three required:
```js
// 1. no floor-bypass. abstention is a valid answer.
const qualified = scored.filter(s => s.fused >= MIN_SCORE);
if (!qualified.length) return [];               // let the caller say "nothing matched"

// 2. default missing confidence DOWN, not up
const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.4;

// 3. prompt: inclusion bias is asymmetric by risk
//   destructive intent -> "When uncertain, EXCLUDE. Prefer missing a tab over closing a wrong one."
//   reversible intent  -> "When uncertain, include with confidence < 0.5."
```
Pass the intent into `reasonOverCandidates` so the prompt can flip. Right now it doesn't
receive it at all, which is why one prompt has to serve both `group_tabs` and `close_tabs`.

Gate: `abstain-correct >= 0.90`, `false-close >= 0.99`.

---

## D3 - PREVIEW STATE DIES WITH THE SERVICE WORKER (P0)

`pendingPlans` is an in-memory `Map`. MV3 workers terminate after ~30s idle. The user reads a
preview listing 12 tabs, thinks for 40 seconds, clicks Confirm, and **nothing happens** because
the plan is gone. Your `expiresAt: Date.now() + 5*60*1000` implies a 5-minute TTL you cannot
actually honor. Nothing sweeps expired entries either.

```js
// chrome.storage.session survives SW restarts, is memory-backed, cleared on browser close
async function stashPlan(planId, plan) {
  const { _plans = {} } = await chrome.storage.session.get('_plans');
  _plans[planId] = { ...plan, expiresAt: Date.now() + 5*60*1000 };
  for (const [k, v] of Object.entries(_plans)) if (v.expiresAt < Date.now()) delete _plans[k];
  await chrome.storage.session.set({ _plans });
}
async function takePlan(planId) {
  const { _plans = {} } = await chrome.storage.session.get('_plans');
  const p = _plans[planId];
  delete _plans[planId];
  await chrome.storage.session.set({ _plans });
  return (p && p.expiresAt > Date.now()) ? p : null;
}
```
Also: **re-validate tab IDs at confirm time.** Between preview and confirm the user may have
closed or navigated tabs, and Chrome recycles IDs, so a stale ID can now point at a *different
page*. Store `urlHash` alongside `tabId` and drop any tab whose current URL no longer matches.
That's a wrong-tab-closed bug waiting to happen.

---

## D4 - `sender.tab` IS UNDEFINED FROM POPUP / SIDE PANEL (P0)

```js
const windowId = sender.tab.windowId;   // line 1, outside the try
```
Throws for any sender that isn't a content script. The exception escapes before `sendResponse`,
so the message port closes silently and the caller's promise **never settles**: the UI spins
forever with no error. Fix:
```js
const windowId = sender.tab?.windowId
  ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
if (!windowId) { sendResponse({ success:false, message:'No active window' }); return; }
```
And move everything, including the dedupe-key construction, inside the try.

---

## D5 - THE ARCHITECTURE FIX: EXPAND THE QUERY, MATCH LOCALLY (P0 for latency)

**This is the answer to "latency and accuracy" and the thing to lead with in an interview.**

Today the LLM performs *set selection*: you serialize N tabs into the prompt and ask which
match. Cost and latency scale with tab count, results are nondeterministic, and you cannot
unit-test it. But look at what the model is actually contributing. Per your own system prompt,
it's **world knowledge**: "entertainment includes Netflix, Spotify, IMDb", "is this actor also
a sports celebrity". That knowledge is a property of the *query*, not of the tab set.

So invert it. One tiny LLM call expands the query into a semantic target; matching happens
locally against embeddings you already have.

```js
// ONE call, ~120 tokens in / ~60 out, independent of tab count, cacheable per query
const EXPAND_SYS = `Expand a tab-management query into matching criteria. JSON only:
{"expansions":["<4-8 concrete phrases a matching page would contain>"],
 "domains":["<likely hostnames>"],
 "clusters":["<0-3 labels from the provided list>"],
 "exclude":["<phrases that must NOT match>"],
 "groupName":"<2-3 word title>"}`;

async function expandQuery(cmd, clusterLabels) {
  const key = await sha256(`v1|${cmd}|${clusterLabels.join(',')}`);
  const hit = await ExpansionCache.get(key);          // IDB, 30-day TTL
  if (hit) return hit;                                 // 0 tokens, ~2ms
  const r = await callLLM({ system: EXPAND_SYS,
    prompt: `Query: "${cmd}"\nKnown clusters: ${clusterLabels.join(', ')}`,
    temperature: 0, seed: 7, schema: EXPANSION_SCHEMA });
  const exp = parseJSONDefensively(r.text);
  await ExpansionCache.put(key, exp);
  return exp;
}

// then match locally, deterministically, in ~5ms for 200 tabs
async function matchLocally(exp, cards) {
  const qs = await self.Embed.embedBatch([...exp.expansions]);   // batched, one pass
  const ex = exp.exclude?.length ? await self.Embed.embedBatch(exp.exclude) : [];
  return cards.map(c => {
    const v = c.embedding;
    const pos = v?.length ? Math.max(...qs.map(q => dot(q, v))) : 0;   // max-pool over expansions
    const neg = (v?.length && ex.length) ? Math.max(...ex.map(q => dot(q, v))) : 0;
    const dom = exp.domains?.some(d => c.domain?.endsWith(d)) ? 1 : 0;
    const clu = exp.clusters?.includes(c.enrichment?.clusterId) ? 1 : 0;  // Part 1 taxonomy
    return { card: c, score: LR({ pos, neg, dom, clu, kw: kwScore(c, exp) }) };
  });
}
```

`LR` is a 5-feature logistic regression fit offline on the D0 gold set. Ship ~6 floats. It
outputs a **calibrated probability**, which is what your preview threshold actually needs
(the LLM's self-reported `confidence` is famously uncalibrated, and you currently average it).

What this buys, all measurable:
- **tokens/cmd: ~2000 -> ~180**, and **0 on any repeated query** (cache hit). ~10x cost cut.
- **p95: one ~400ms call instead of R1+R2 at 2-6s**, and cache hits are pure local math.
- **Determinism.** Same command + same tabs = same plan, always. You can now unit-test the
  matcher with zero LLM calls, which is what makes `set-exact` a real regression gate.
- Scales to 200 tabs at flat cost. Your current `maxTabs` math (D6) doesn't.

Keep the current per-tab reasoning path as a **fallback for genuinely ambiguous queries only**
(`p_max - p_second < 0.15`), capped at the top 8 candidates. Expect it to fire on <10% of
commands. That's the escape hatch, not the default.

---

## D6 - CONTEXT BUDGET MATH IS WRONG (P1)

```js
let contextSize = 8192; if (!useOllama && !useBackend) contextSize = 1000000;
const maxTokensPerTab = 50;
const maxTabs = Math.floor((contextSize / maxTokensPerTab) * 0.9);
```
- Gemini: `maxTabs = 18000`. Not a cap.
- Ollama: `maxTabs = 147` -> 7350 tokens of candidates in an 8192 window, leaving nothing for
  the ~250-token system instruction *or* the output. Guaranteed overflow.
- `50` tokens/tab is wrong regardless, because you send
  `JSON.stringify(compactCards, null, 2)`. Pretty-printing burns **30-40% of your prompt on
  indentation and newlines**. Real cost is 80-120 tokens/tab.

Fix: drop the indent (`JSON.stringify(cards)`), better yet send TSV
(`idx\ttitle\tdomain\tcat\ttags`) which is roughly half the tokens of JSON. Reserve output +
system explicitly:
```js
const maxTabs = Math.floor((ctx - sysTokens - maxOutTokens - 256) / measuredTokensPerTab);
```
And *measure* `measuredTokensPerTab` at runtime instead of hardcoding it.
````

# AI COMMANDS — D7 to D10

## D7 — SCORE FUSION IS INCOHERENT (P1, accuracy)
```js
if (keywordScore > score) score = keywordScore;         // max() across two scales
if (overlap > 0) score += 0.3 * Math.min(overlap, 2);   // +0.6
if (entityMatch)  score += 0.15;
if (categoryBoost) score += 0.4;
```
Cosine lives in ~[0, 0.55]; keyword score is a clean [0,1] hit ratio. `max()` means **one incidental
token hit (0.33) beats a strong semantic match (0.29)** and clears `MIN_SCORE=0.3`. Then +1.15 of
unbounded additive boosts swamps the embedding: the "semantic" path is keyword search wearing an
embedding costume.

Fix with RRF (scale-free, nothing to tune), then D5's logistic regression for the probability:
```js
const K = 60;
const rank = (arr, key) => {
  const s = [...arr].sort((a,b) => b[key]-a[key]); const m = new Map();
  s.forEach((x,i) => m.set(x.card.urlHash, i+1)); return m;
};
const rv = rank(scored,'vec'), rk = rank(scored,'kw'), rt = rank(scored,'tag');
for (const s of scored) s.fused =
  1.0/(K+rv.get(s.card.urlHash)) + 0.7/(K+rk.get(s.card.urlHash)) + 0.5/(K+rt.get(s.card.urlHash));
```
Four bugs in that same loop:
- `normA`/`normB` recomputed every iteration though **both vectors are already L2-normalized** by
  `Embed.embed`. It's a plain dot product. ~3x faster for free.
- No `emb.length === 384` guard → `NaN`, and `NaN` in a comparator makes `Array.sort`
  **order-dependent and undefined**.
- `new Float32Array(c.embedding)` copies 1.5KB per card per command. Reuse a scratch buffer.
- `cardCategory.includes(w)` is a substring test: `"port"` matches `"sports"`, `"art"` matches
  `"article"`. Word boundaries only.

`MIN_SCORE = 0.3` is a raw-cosine threshold applied to a score that now reaches 1.15. Meaningless.
Threshold the calibrated probability instead.

---

## D8 — INLINE INDEXING IS YOUR #1 p95 (P1, latency)
`retrieveCandidates` builds missing cards inline: Readability injection + `cloneNode(true)` + MiniLM,
concurrency 5. With 40 unindexed tabs (the normal state after a session restore) one command takes
**10–30s**. And `wasm.numThreads = 1` means that concurrency buys nothing but simultaneous DOM
clones and a memory spike.

Hard deadline, degrade instead of block:
```js
const BUDGET_MS = 700, t0 = Date.now();
for (const tab of missingTabs) {
  if (Date.now() - t0 > BUDGET_MS) { candidates.push(await shallowCard(tab)); continue; } // ~15ms
  candidates.push(await self.buildTabCard(tab, allCards));
}
```
Flag degraded cards and say so ("2 tabs weren't fully read yet") rather than silently scoring them
low, which makes them invisible to the plan for no stated reason. Log `missing_at_command` as a
health metric: p50 > 5 means Part 1's startup sweep is broken.

Also: `getAllTabCards()` deserializes ~3MB **per command**, then filters on `c.tabId` — which after
Part 1's re-key to `urlHash` is stale metadata, so the filter silently returns **nothing**. Replace
with one indexed `urlHash` get per open tab (~10ms, single transaction). And `candidates.some(...)`
inside the `openTabs` loop is O(n·m); build a Set once.

---

## D9 — ROUND 2 IS EXPENSIVE AND ITS MERGE IS BACKWARDS (P1)
`promptR2 = \`${promptR1}\n\n...\`` resends all of R1, so two rounds cost ~2.3x one. Send only the
requested tabs plus a one-line restatement of the task.

The merge is the real bug:
```js
if (!existing || (m.confidence||0) > (existing.confidence||0)) byTabId.set(m.tabId, m);
```
R2 exists to **correct** R1 with better evidence. Max-confidence means if R2 read the page content
and decided a tab does *not* match, R1's optimistic guess survives anyway. You built a ratchet that
only ever adds tabs — exactly wrong for `close_tabs`.
```js
const examined = new Set(detailsTabs);          // tabs R2 actually saw content for
const merged = new Map(round1Matches.map(m => [m.tabId, m]));
for (const id of examined) merged.delete(id);   // R2 has authority over what it examined
for (const m of round2Matches) merged.set(m.tabId, m);
```
Plus:
- **Privacy leak:** `detailedContext` sends the full `url`. `mainText` is gated by
  `allowCloudContent`; the URL isn't. URLs carry doc IDs, session tokens, search queries, email
  subjects. Strip `search` and `hash` before it leaves the device.
- **Index fallback is a correctness hazard:** `if (!card && ref <= candidates.length) card =
  candidates[ref-1]` turns a hallucinated `tabId: 3` into the third candidate — an unrelated tab,
  arriving with the model's confident reason attached. Delete it. Either the ID is in the candidate
  set or it's dropped.

Under D5 this becomes a rare fallback: cap at one round, 8 tabs.

---

## D10 — CONFIDENCE AGGREGATION + PREVIEW POLICY (P1, commercial)
```js
const finalConfidence = totalConfidence / matchesCount;                  // mean
const needPreview = plan.destructive || candidateIds.length >= 3 || plan.confidence < 0.75;
```
The mean hides the outlier that hurts you: five tabs at 0.95 plus one at 0.50 averages 0.87, clears
the 0.75 gate, and the 0.50 tab gets closed with full confidence. Gate per-tab instead:
```js
const act = matches.filter(m => m.p >= (destructive ? 0.80 : 0.60));
plan.confidence = act.length ? Math.min(...act.map(m => m.p)) : 0;   // min, not mean
```
Commercially, `>= 3` means **almost every real command opens a confirm dialog**. You built a semantic
tab agent and shipped a permission-prompt generator; users learn the product is "two clicks to do a
thing." You already have `transactionLog`, `captureBeforeState`, and `UNDO_AVAILABLE`. Ship trust
through reversibility:

| Action | Reversible | Policy |
|---|---|---|
| group / pin / mute / reload / sort | fully | **execute now** + undo toast |
| bookmark | additive | execute + undo toast |
| close | session-restore only | always preview, uncertain **unchecked** |
| `ambiguous` intent (D1) | n/a | always preview |

`preview-rate` >80% → ~15–25%, while `false-close` goes *up* because friction concentrates on the one
action that earns it. Guardrail: `undo-rate` > 3% on reversible actions ⇒ tighten thresholds.

Two bugs here: `pendingPlans` flattens `[...tabIds, ...uncertain]`, so confirming acts on both
identically — the uncertain split you carefully computed is discarded exactly where it matters. And
`candidateIds = tabIds.length ? tabIds : uncertain` lets a 2-tab *uncertain* plan skip preview
(2 < 3); low confidence should raise friction, not dodge the count check.

# AI COMMANDS — D11 to D13

## D11 — `groupName` IS NEVER SET, SO EVERY GROUP IS UNTITLED (P1)
```js
const functionCall = { name: plan.intent, args: { tabIds: plan.tabIds } };
```
```js
const { groupName, color = 'blue' } = args;     // undefined
await chrome.tabGroups.update(groupId, { title: groupName, color });
```
`args` only ever contains `tabIds`, so `groupName` is always `undefined`. Your flagship demo command
("group entertainment tabs") produces an **unnamed group** and the success toast literally prints
`Grouped 5 tabs into "undefined"`. This is the first thing anyone watching a demo notices.

Have D5's query expansion return `groupName` (free, one more field in the same JSON), with a local
fallback chain so it works even on cache-miss failure:
```js
args.groupName = exp.groupName
  || dominantClusterLabel(matched)                       // Part 1 taxonomy label
  || titleCase(cmd.replace(/\b(group|tabs|all|my|the)\b/gi,'').trim()).slice(0,20)
  || 'Tabs';
args.color = COLOR_BY_CLUSTER[dominantClusterId] || 'blue';   // stable colors per topic
```
Stable per-topic colors are a disproportionate polish win: users recognize their groups at a glance
and it costs you nothing.

Three more issues in this path:
- `executeToolCall(functionCall, windowId, msg.command, plan.tabIds)` passes **4 args to a 3-arg
  function**. The 4th is silently dropped. Either it's dead or something downstream expected it.
- `handleGroupTabs` rejects single-tab results *after* the user already confirmed the preview.
  Validate `tabs.length >= 2` before showing the dialog.
- `resolveTabsForAction` re-resolves post-confirm and can exclude the active tab, so a user confirms
  5 tabs and gets 4 acted on with no explanation. Resolve once, preview exactly what you'll execute,
  execute exactly that list.

---

## D12 — CLASSIFIER IS OVERFIT TO THE DEMO (P2)
```js
const syntacticKeywords = [..., 'reddit','youtube','github','google','twitter', ...];
const semanticIndicators = [..., 'web series','mortgage','science','housing', ...];
```
`"group my youtube tabs about cricket"` hits `youtube` → syntactic; `cricket` isn't in
`semanticIndicators` → rule-based grouping → groups **all** YouTube tabs and ignores the topic
entirely. And `semanticIndicators` containing `'mortgage'` and `'housing'` is a visible tell that the
list grew one demo bug at a time. An interviewer will clock that instantly.

Route on structure, not vocabulary. Syntactic = the command references only tab **metadata** (domain,
pinned, audible, age, duplicate, position). Semantic = it references **content**. Detect it by
stripping metadata predicates and verbs, then checking what's left:
```js
const META_PREDICATES = [
  /\bduplicate/, /\bpinned\b/, /\baudible\b/, /\bplaying\b/,
  /\binactive\b|\bstale\b|\bold\b|\bunused\b/, /\bby (domain|host|site)\b/,
  /\b[a-z0-9-]+\.(com|org|net|io|dev|edu|gov|co)\b/
];
function route(cmd) {
  let r = cmd.toLowerCase();
  for (const re of META_PREDICATES) r = r.replace(re, ' ');
  const words = r.replace(VERB_RE, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  return words.length ? 'semantic' : 'syntactic';   // leftover content words ⇒ semantic
}
```
"youtube tabs about cricket" leaves `["cricket"]` → semantic, correctly. Zero hardcoded topics, and
it generalizes to words you've never seen. Gate on the D0 routing cases.

Two structural notes on the surrounding flow:
- `hasDomainPattern` is computed twice with **different regexes**. `classifyCommand`'s version lists
  `html|htm` as TLDs, so `"close index.html tabs"` reads as a domain match. One source of truth.
- `smartPreFilter` returning `> 0` tabs is trusted at a flat `confidence: 0.9` with no check on *why*
  it matched. A filter that hit 1 of 40 tabs deserves less confidence than one that hit 12. Scale
  confidence by match coverage.

---

## D13 — SILENT PARSE FAILURE + PROVIDER PLUMBING (P2)
```js
catch (e) { return { decision: 'final', matches: [], needDetails: [] }; }
```
`parseJSONDefensively` returns an empty-but-valid plan on failure, which is **indistinguishable from
a legitimate zero-match**. Your handler then tells the user "No matching tabs found, try different
keywords" when the model actually emitted garbage. You get support tickets you cannot triage, and
your `abstain-correct` metric looks great for entirely the wrong reason.

- Return `{ parseError: true }` and handle it separately: one repair retry, then an honest "the AI
  response was malformed" plus a telemetry event.
- `/\{[\s\S]*\}/` is greedy — first `{` to **last** `}` — so any trailing prose breaks the parse. Use
  a brace-depth scanner, or better, constrain the output so it can't happen.
- Gemini: pass `responseSchema` alongside `responseMimeType`. Ollama: pass the JSON schema to
  `format`, not just `'json'`. Constrained decoding takes parse failures to ~0.
- `temperature: 0.1` with **no seed** means identical commands can produce different plans. Reads as
  flakiness to users and makes your bench non-reproducible. Use `temperature: 0` + a fixed seed.

**Provider plumbing, same call site:**
- **No timeout.** `callOllama` on a cold model can hang 60s+ with no abort. Every provider call needs
  `AbortSignal.timeout(8000)` and a visible "still thinking" state at 2s.
- **No warm-up.** Ollama unloads models after ~5 min idle, so the first command after a break pays
  full load time (2–10s). Send a 1-token ping with `keep_alive: '30m'` when the popup opens. Free
  perceived-latency win, and it's the first impression every session.
- **Prompt prefix reuse.** `systemInstruction` is ~250 tokens and identical every call. Keep it first
  and byte-stable so Gemini implicit caching and Ollama prefix caching can hit it. Right now you
  concatenate `${systemInstruction}\n\n${promptR1}` for Ollama/Backend but pass it as a separate
  field for Gemini, so your three providers see **different prompts** and bench results won't
  transfer between them. Unify behind one `callLLM({ system, prompt, schema, seed, signal })` adapter.
- `safeLlmCall` collapses every failure into `{providerError}`, which `runSemanticPipeline` re-throws
  as a generic Error. A 401 (bad key), a 429 (rate limit), and ECONNREFUSED (Ollama not running) are
  three completely different user actions but all surface as "AI provider unavailable." Classify by
  status and state the actual fix.