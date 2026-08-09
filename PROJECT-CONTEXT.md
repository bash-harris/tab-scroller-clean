# Tab Scroller — Project Context for LLMs

## What This Is

Chrome Manifest V3 extension + Django backend for AI-powered tab management. Users type `>` in a hover-activated micro-bar to issue natural language commands like "group all github tabs" or "bookmark my research tabs".

**Core design principle:** The extension pre-selects relevant tabs via local retrieval. The LLM only decides which action to take and its parameters — it never returns tab IDs. This keeps the LLM fast and deterministic.

---

## Architecture

```
content.js (Shadow DOM micro-bar + AI search popup)
    │  sends { type: "AI_COMMAND", command: "group all github tabs" }
    ▼
background.js (service worker)
    │
    ├─ TabService.getAllTabs() ──────────── chrome.tabs.query
    ├─ TabDB.getAllTabCards() ───────────── IndexedDB (TabScrollerSimplified v1)
    │
    ▼
RetrievalService.retrieve(query, tabCards)
    │
    ├─ QueryParser.parse(query)
    │     → { action:"group", domain:"github.com", type:"deterministic" }
    │
    ├─ IF deterministic: DomainRetriever → exact hostname match, score=100
    ├─ IF semantic: TitleRetriever + KeywordRetriever + EmbeddingRetriever
    │
    ├─ CandidateAggregator → merge + dedupe
    └─ RankingEngine → weighted score with breakdown
         → top 20 candidates
    │
    ▼
    ┌──────────────────────────────────────────────┐
    │ IF deterministic && domain && action:         │
    │   SKIP LLM → executeTool directly            │
    │ ELSE:                                        │
    │   ChatService.execute() → POST /api/chat     │
    │   Django → Ollama qwen2.5 → {tool, args}     │
    │   Extension INJECTS tabIds into response      │
    └──────────────────────────────────────────────┘
    │
    ▼
executeTool(toolName, args)
    │
    ├─ group_tabs → TabService.groupTabs()
    ├─ close_tabs → TabService.closeTabs()
    ├─ focus_tab  → TabService.focusTab()
    ├─ bookmark_tabs → TabService.bookmarkTabs()
    └─ pin_tabs   → TabService.pinTabs()
    │
    ▼
Result toast back to content.js
```

---

## Active File Map

These files are loaded by `manifest.json`:

| File | Lines | Role |
|------|-------|------|
| `src/background/background.js` | 523 | Service worker. Entry point. `AI_COMMAND` handler, tab indexing, deterministic fast path. |
| `src/background/executeTool.js` | 77 | Tool dispatch: `group_tabs`, `close_tabs`, `focus_tab`, `bookmark_tabs`, `pin_tabs` |
| `src/ui/content.js` | ~2283 | Content script. Shadow DOM micro-bar, AI search popup, tab cards rendering. |
| `src/services/TabService.js` | 153 | Only module allowed to touch `chrome.tabs`/`tabGroups`/`bookmarks` APIs. |
| `src/services/ChatService.js` | 71 | HTTP wrapper → Django `/api/chat` + `/api/summarize` |
| `src/services/EmbeddingService.js` | 45 | HTTP wrapper → Django `/api/embeddings` |
| `src/services/SearchService.js` | 48 | Cosine similarity search over IndexedDB (legacy, unused by AI_COMMAND now) |
| `src/services/SessionService.js` | 55 | CRUD for browsing sessions via IndexedDB |
| `src/services/retrieval/QueryParser.js` | 134 | NL → `{action, target, type, domain}`. 46 domain keywords. |
| `src/services/retrieval/DomainRetriever.js` | 37 | Exact hostname match, score=100 |
| `src/services/retrieval/TitleRetriever.js` | 52 | Lexical token overlap in titles, score up to 40 |
| `src/services/retrieval/KeywordRetriever.js` | 50 | Matches `TabCard.keywords`, score up to 20 |
| `src/services/retrieval/EmbeddingRetriever.js` | 47 | Cosine similarity, score up to 25 |
| `src/services/retrieval/CandidateAggregator.js` | 79 | Merges + deduplicates from all retrievers |
| `src/services/retrieval/RankingEngine.js` | 54 | Weighted scoring with explainable `scoreBreakdown` |
| `src/services/retrieval/RetrievalService.js` | 61 | Orchestrator: parser → retrievers → aggregate → rank |
| `src/models/TabCard.js` | 36 | Canonical tab representation: `{tabId, url, title, summary, embedding, keywords, contentHash, domain}` |
| `src/models/Workspace.js` | 18 | Workspace model |
| `src/storage/db.js` | 139 | IndexedDB `TabScrollerSimplified` v1 — `tabCards` + `sessions` stores |

---

## AI Pipeline — Full Implementation

### 1. QueryParser — Natural Language → Structured Intent

**File:** `src/services/retrieval/QueryParser.js`

```js
const DOMAIN_KEYWORDS = {
  github: 'github.com', youtube: 'youtube.com', reddit: 'reddit.com',
  linkedin: 'linkedin.com', leetcode: 'leetcode.com', // ... 46 total
};

const ACTION_KEYWORDS = {
  group: 'group', close: 'close', focus: 'focus',
  bookmark: 'bookmark', pin: 'pin', open: 'focus',
};

parse(query) {
  // 1. Extract action from first word: "group all github tabs" → "group"
  // 2. Match domain from any word: "github" → "github.com"
  // 3. Type = domain ? 'deterministic' : 'semantic'
  // 4. Target = remaining words after removing stop words + action + domain
  return { action, target, type, domain, raw: query };
}
```

**Deterministic** = domain keyword recognized (e.g. "github" → `github.com`). Skips LLM.
**Semantic** = no domain keyword (e.g. "tabs about cats"). Uses embeddings.

### 2. RetrievalService — Orchestrator

**File:** `src/services/retrieval/RetrievalService.js`

```js
async retrieve(query, tabCards, embeddingService, activeTabId, topK = 20) {
  const parsed = QueryParser.parse(query);

  if (parsed.type === 'deterministic' && parsed.domain) {
    // Only domain matching — fast, no network
    domainResults = await DomainRetriever.retrieve(tabCards, parsed.domain);
  } else {
    // Full semantic pipeline
    titleResults = TitleRetriever.retrieve(tabCards, parsed.target);
    keywordResults = KeywordRetriever.retrieve(tabCards, parsed.target);
    embeddingResults = await EmbeddingRetriever.retrieve(
      tabCards, parsed.target, embeddingService, 50
    );
  }

  candidates = CandidateAggregator.aggregate(domain, title, keyword, embedding);
  ranked = RankingEngine.rank(candidates, activeTabId);
  return { parsed, candidates: topCandidates, allCandidates: ranked };
}
```

### 3. DomainRetriever — Exact Hostname Match

**File:** `src/services/retrieval/DomainRetriever.js`

Matches tabs where `card.domain === domain` OR `url.includes(domain)` OR `title.includes(bareDomain)`. Score: **100**.

```js
// "github.com" matches:
//   domain.card === "github.com"  ✓
//   url includes "github.com"     ✓
//   title includes "github"       ✓
```

### 4. TitleRetriever — Token Overlap

**File:** `src/services/retrieval/TitleRetriever.js`

Splits query and tab titles into tokens. Counts how many query tokens appear in each title. Score: `(matchCount / queryTokens.length) * 40`, max **40**.

### 5. KeywordRetriever — Stored Keywords Match

**File:** `src/services/retrieval/KeywordRetriever.js`

Matches against `TabCard.keywords` array (extracted during indexing). Score: `(matchCount / queryTokens.length) * 20`, max **20**.

### 6. EmbeddingRetriever — Cosine Similarity

**File:** `src/services/retrieval/EmbeddingRetriever.js`

```js
const queryEmbedding = await embeddingService.getEmbedding(target);
// For each tab: cosineSimilarity(queryEmbedding, card.embedding)
// Score: similarity * 25, max 25
// Returns top 50 by embedding score
```

Uses Ollama's `nomic-embed-text` model via Django backend.

### 7. CandidateAggregator — Merge + Dedupe

**File:** `src/services/retrieval/CandidateAggregator.js`

Merges all retriever results into a single array keyed by `tabId`. Each candidate gets scores from all retrievers: `{ domainScore, titleScore, keywordScore, embeddingScore }`.

### 8. RankingEngine — Weighted Scoring

**File:** `src/services/retrieval/RankingEngine.js`

```js
WEIGHTS = {
  DOMAIN: 100,    // DomainRetriever max
  TITLE: 40,      // TitleRetriever max
  KEYWORD: 20,    // KeywordRetriever max
  EMBEDDING: 25,  // EmbeddingRetriever max
  ACTIVE_TAB: 10, // Bonus if this is the active tab
  PINNED_TAB: 5,  // Bonus if tab is pinned
};

// Final score = domain + title + keyword + embedding + active + pinned
// Sorted descending by score
```

Returns top 20 candidates with full `scoreBreakdown` for explainability.

### 9. AI_COMMAND Handler — The Full Flow

**File:** `src/background/background.js:360-476`

```js
case "AI_COMMAND": {
  // 1. Get live Chrome tabs
  const currentTabs = await TabService.getAllTabs(WINDOW_ID_CURRENT);
  const currentTabIds = new Set(currentTabs.map(t => t.id));

  // 2. Get IndexedDB tab cards, filter to currently open
  const allTabCards = await TabDB.getAllTabCards();
  const liveTabCards = allTabCards.filter(c => currentTabIds.has(c.tabId));

  // 3. Run retrieval
  const retrievalResult = await RetrievalService.retrieve(
    msg.command, liveTabCards, EmbeddingService, activeTabId, 20
  );

  // 4. Build compact tab list for LLM
  const compactTabs = retrievalResult.candidates.map(c => ({
    id: c.tabId, title: c.title, url: c.url, score: c.score,
  }));

  // 5. FAST PATH: Deterministic queries skip LLM
  if (parsed.type === 'deterministic' && parsed.domain && parsed.action) {
    const toolName = parsed.action === 'focus' ? 'focus_tab' : `${parsed.action}_tabs`;
    const args = { tabIds: compactTabs.map(t => t.id) };
    if (parsed.action === 'group') {
      args.groupName = parsed.domain.replace(/\.\w+$/, '').replace(/^www\./, '');
    }
    const toolResult = await executeTool(toolName, args);
    sendResponse(toolResult);
    return;
  }

  // 6. LLM path: Send to Django → Ollama
  const chatResult = await ChatService.execute(msg.command, compactTabs);

  // 7. Extension INJECTS tabIds into LLM response
  const args = { ...chatResult.arguments };
  switch (chatResult.tool) {
    case 'group_tabs':
    case 'close_tabs':
    case 'pin_tabs':
    case 'bookmark_tabs':
      args.tabIds = compactTabs.map(t => t.id);
      break;
    case 'focus_tab':
      args.tabId = compactTabs[0].id;
      break;
  }

  // 8. Execute
  const toolResult = await executeTool(chatResult.tool, args);
  sendResponse(toolResult);
}
```

### 10. executeTool — Tool Dispatch

**File:** `src/background/executeTool.js`

```js
const VALID_TOOLS = ['group_tabs', 'close_tabs', 'focus_tab', 'bookmark_tabs', 'pin_tabs'];

async function executeTool(tool, args) {
  switch (tool) {
    case 'group_tabs':
      // TabService.groupTabs(tabIds, groupName, color)
      // → ungroup first, then chrome.tabs.group()
      break;
    case 'close_tabs':
      // TabService.closeTabs(tabIds)
      break;
    case 'focus_tab':
      // TabService.focusTab(tabId)
      break;
    case 'bookmark_tabs':
      // TabService.bookmarkTabs(tabs, folderName)
      break;
    case 'pin_tabs':
      // TabService.pinTabs(tabIds, pinned)
      break;
  }
}
```

---

## TabService — Chrome API Wrapper

**File:** `src/services/TabService.js`

Only module allowed to touch Chrome APIs. Wraps:

- `getAllTabs(windowId)` → `chrome.tabs.query({ windowId })`
- `groupTabs(tabIds, groupName, color)` → ungroup first, then `chrome.tabs.group()`, then `chrome.tabGroups.update()`. Handles saved group restrictions by falling back to one-at-a-time grouping.
- `closeTabs(tabIds)` → `chrome.tabs.remove(ids)`
- `focusTab(tabId)` → `chrome.tabs.update(tabId, { active: true })`
- `pinTabs(tabIds, pinned)` → `chrome.tabs.update(id, { pinned })`
- `bookmarkTabs(tabs, folderName)` → `chrome.bookmarks.create()`
- `extractText(tabId)` → `chrome.scripting.executeScript()` (gets `innerText`)

---

## Backend — Django + Ollama

**File:** `backend/api/views.py`

Three endpoints:

| Endpoint | Method | Input | Calls | Returns |
|----------|--------|-------|-------|---------|
| `/api/chat` | POST | `{prompt, tabs}` | Ollama `qwen2.5` generate | `{tool, arguments, message}` |
| `/api/embeddings` | POST | `{text}` | Ollama `nomic-embed-text` | `{embedding: [float]}` |
| `/api/summarize` | POST | `{text}` | Ollama `qwen2.5` generate | `{summary: string}` |

**System prompt** tells the LLM: "The extension has ALREADY selected the relevant tabs. You ONLY decide which action to take. NEVER return tab IDs."

**Prompt format:**
```
Command: group all github tabs

The extension has pre-selected these tabs as the relevant candidates (ranked by relevance score):
12345 | My GitHub Repo | https://github.com/user/repo [score=100]
12346 | GitHub Actions Docs | https://docs.github.com/actions [score=100]

Choose the appropriate tool and its parameters for these tabs.
```

**Config:** Ollama at `localhost:11434`. Django CORS_ALLOW_ALL_ORIGINS=True.

---

## Data Model — TabCard

**File:** `src/models/TabCard.js`

```js
{
  tabId: Number,        // Chrome tab ID
  url: String,          // Tab URL
  title: String,        // Tab title
  summary: String,      // LLM-generated summary (optional)
  embedding: [Float],   // Vector embedding from nomic-embed-text
  keywords: [String],   // Extracted keywords for KeywordRetriever
  contentHash: String,  // Hash to detect content changes
  domain: String,       // Extracted domain (e.g. "github.com")
}
```

Stored in IndexedDB `TabScrollerSimplified` v1, `tabCards` store.

Tab indexing happens on:
- `chrome.runtime.onInstalled` (batch index all existing tabs)
- `chrome.tabs.onCreated` (index new tab)
- `chrome.tabs.onUpdated` (re-index if title/url changed)

---

## Chrome Permissions

```json
"permissions": ["tabs", "storage", "tabGroups", "activeTab",
                "scripting", "history", "bookmarks", "alarms"]
```

---

## Known Issues

1. **Chrome saved tab groups** — `groupTabs` fails with "Tabs can only be moved to and from normal windows" when tabs are in Chrome 120+ saved groups. Workaround: ungroup first, fall back to one-at-a-time.
2. **Ollama latency** — 3-10s per embedding, 30-40s per LLM call. Deterministic fast path skips LLM for domain commands.
3. **No preview/confirm flow** — Commands execute immediately. No confirmation dialog.
4. **Inactivity handling** — No special handling. Inactive/discarded tabs are treated identically to active tabs. `TabService.isDiscardable()` exists but isn't called in the AI pipeline.
5. **Pinned tab safety** — Pinned tabs get a +5 ranking bonus but are not excluded from close/group operations.

---

## Dead Code (Root-Level Legacy)

These files are NOT loaded by `manifest.json` — they are legacy from an earlier architecture:

| File | What it was |
|------|-------------|
| `background.js` | Old 893-line service worker with full pipeline, undo, telemetry, session-memory |
| `content.js` | Old content script |
| `command-agent.js` | classifyCommand → retrieveCandidates → reasonOverCandidates |
| `tab-cards.js` | Readability-based page extraction + prompt injection sanitization |
| `db.js` | Old IndexedDB `TabScrollerRAG` v3 |
| `embed.js` | Client-side embedding via @xenova/transformers |
| `indexer.js` | classifyDomain, snippet extraction |
| `recall-tabs.js` | Semantic search with time-range filtering |
| `session-memory.js` | Persistent session tracking engine |
| `session-manager.*` | Session manager panel UI |
| `bookmarks.*` | Bookmark organizer UI |
| `options.*` | Settings UI |

---

## Test Files

| File | Coverage |
|------|----------|
| `tests/background.test.js` | AI_COMMAND flow: getAllTabs → ChatService → executeTool |
| `tests/background-rag.test.js` | Hybrid retrieval: QueryParser, DomainRetriever, TitleRetriever, domain/semantic paths |
| `tests/chatservice.test.js` | HTTP wrapper: POST to /api/chat |
| `tests/executetool.test.js` | Tool dispatch for all 5 tools |
| `tests/tabservice.test.js` | Chrome API wrapper (14 tests) |
| `tests/db.test.js` | IndexedDB operations |
| `tests/tabcard.test.js` | TabCard model |
| `tests/ai-prompt.test.js` | Puppeteer E2E: opens 15 Wikipedia tabs, sends AI commands |
| `tests/run-ai-test.js` | Puppeteer E2E: 3 test cases with accuracy scoring |
| `tests/e2e-pipeline.js` | Playwright E2E: opens 12 tabs, tests search + full pipeline via Django |
| `backend/test_ollama.py` | Python: validates Ollama returns valid JSON for 5 tool types |
