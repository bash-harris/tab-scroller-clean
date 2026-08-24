# RAG → NLI Implementation Plan

**Target repo:** `C:\Users\bkh\Desktop\tab-scroller-clean`
**Written:** 2026-08-19
**Audience:** an implementing agent working task-by-task. Follow tasks in numeric order.

---

## 0. How to use this document

1. Work tasks **in order**. Each task is self-contained and ends with an **Acceptance check** you must run before moving on.
2. Every task names the **exact file** and the **exact anchor text** to find. Line numbers are given as *hints* — they will drift as you edit. **Always locate code by the quoted anchor text, not by line number.**
3. If an anchor string is not found, **stop and report**. Do not guess a location.
4. Do not "improve" code outside the stated scope. Section 9 lists things you must NOT change.
5. After every task that touches JS, run `node tests/run-phase0.js`. It must stay green.

**Prerequisite — is the vector DB running?**
```bash
curl -s http://localhost:8000/api/v2/version     # expect "1.0.0"
```
If this fails, start ChromaDB first (see Task 12) — several acceptance checks need it.

---

## 1. Current state (verified, not assumed)

These facts were measured against the live system. Trust them.

**What already works — do not rebuild:**

| Component | Status |
|---|---|
| `background.js:21` imports `chroma-client.js`, `rag-chunker.js`, `rag-retriever.js` into the service worker | correct |
| `command-agent.js:1043-1057` retrieves chunks and passes `relevantChunksByTabId` to `NliSelect.select` | correct |
| `nli-select.js:526-527` consumes it per tab and calls `formatDeepPremise` | correct |
| `manifest.json:7` `host_permissions: ["<all_urls>"]` permits the `localhost:8000` fetch | correct |
| Chunk ingestion | works — **2252 chunks, 384-dim, 809 tabIds** live in Chroma |
| Offline fallback to IndexedDB | works |
| NLI hypothesis truncation | safe — transformers.js pair-tokenizes `longest_first`, so the premise is clipped, never the hypothesis |
| `card.sections` persisted at `tab-cards.js:261` | correct, so `chunkDocument` receives real sections |

**The pipeline is fully wired and still contributes nothing.** It fails silently: tests pass, no error logs, and NLI quietly uses the old title-only premise.

### Measured evidence

Real short queries, embedded with the same MiniLM, against the live 2252-chunk index:

| query | top cosine | chunks kept (shipped) | chunks kept (correct math) |
|---|---|---|---|
| programming | 0.653 | **1** | 30 |
| graph algorithms | 0.526 | **0** | 30 |
| machine learning | 0.464 | **0** | 30 |
| cricket | 0.290 | **0** | 30 |
| music | 0.483 | **0** | 30 |
| recipes for dinner | 0.470 | **0** | 30 |

Candidate-tab coverage, measured with correct cosine so the above bug cannot mask it:

| query | tabs covered (shipped) | tabs covered (with `where` push-down) |
|---|---|---|
| programming | 1 | 11 |
| graph algorithms | 0 | 23 |
| machine learning | 1 | 18 |
| music | 0 | 11 |

Stale identity, measured on the live index: **50 tabIds carry chunks from more than one page.** Worst case one tabId owns chunks from **18 different pages**.

---

## 2. Root causes

### RC-1 — the collection is L2, the code assumes cosine

`tab_chunks` reports `"hnsw":{"space":"l2"}` and `"metadata":null`. `chroma-client.js:232` does:

```js
const similarity = Math.max(0, 1 - dist);
```

That is only valid for cosine distance. Chroma's `l2` returns **squared** L2, and because `embed.js:30` uses `normalize: true`, `dist = 2 - 2·cos`. So `minSimilarity: 0.15` silently means **cos ≥ 0.575** instead of cos ≥ 0.15 — a threshold almost nothing clears.

**Important:** the creation payload at `chroma-client.js:99-105` is *not* the bug. A fresh collection created with that exact payload **does** get cosine on this Chroma build (verified). `tab_chunks` is L2 because it was created before that setting existed, and `get_or_create:true` returns the pre-existing collection while discarding the requested config. HNSW space is immutable after creation.

**Chosen fix:** make the client **space-aware** (read the collection's real space and convert correctly). This works with the existing 2252 chunks, needs no migration, and cannot silently break again. Recreating the collection is offered as optional cleanup in Task 12, not as the fix.

### RC-2 — the candidate set is never pushed into the query

`rag-retriever.js:74-78` asks Chroma for the **global** top-30 and only filters to candidates afterwards at `:114`. The IndexedDB path does the opposite and pushes candidates into the scan (`db.js:394`), so the fallback has strictly better recall than the primary path.

### RC-3 — chunks are addressed by an unstable key

`chunkId` is `${urlHash}_c${n}` (`rag-chunker.js:84`) — keyed by *page*. But `tabId` is stored as a mutable tag (`chroma-client.js:151`) and retrieval filters on it (`rag-retriever.js:114`, `db.js:394`). Nothing ever refreshes it:

- `tab-cards.js:167-177` — a cache hit updates `tabId` on the **card** and returns early, **skipping the chunking block** at `:267`. Chunks keep the old tabId.
- `background.js:5300` — skips any URL whose hash already has chunks, so it never rewrites tabId either.

Net effect: a chunk's `tabId` is *whichever tab first indexed that URL, forever*. This breaks in both directions — a tab that navigated away still owns its old page's chunks, and the same page reopened in a new tab retrieves nothing. **This is also the real reason the index appears to be lost on extension reload.**

RC-1 currently masks RC-3. Fixing RC-1 alone would *activate* RC-3, and its failure mode is worse than "no chunks": a different page's text enters a tab's premise, so NLI answers confidently about the wrong page. **Fix them together.**

**Chosen fix:** stop filtering chunks by `tabId` entirely. `urlHash` is stable and already on every chunk. Resolve `tabId → urlHash` from the live candidate cards, query by `urlHash`, then map results back to live tabIds.

### RC-4 — the console looks empty because the logs are in a different console

There is no logging gate or verbose flag in this codebase; `console.log` is called directly and unconditionally. Nothing is suppressed. In Manifest V3 the output is split across three separate consoles:

| Code | Where its logs appear |
|---|---|
| `background.js`, `db.js`, `chroma-client.js`, `rag-retriever.js`, `nli-select.js`, `command-agent.js` | **service worker console** — `chrome://extensions` → Tab Scroller → *Inspect views: service worker* |
| `offscreen.js` | the offscreen document's own console |
| `content.js` | the web page's console (the one normally open) |

All RAG/Chroma/NLI logging lives in the first bucket. Worse, the service worker is **terminated when idle (~30 s)** and its console is wiped on restart, so evidence disappears.

**Chosen fix:** a shared logger that writes a numbered, timed step trace, keeps a ring buffer in `chrome.storage.local` (survives worker restart and extension reload), and mirrors steps into the page console so they are visible where you are already looking.

---

## 3. Design decisions (rationale — read before coding)

- **D1. Space-aware conversion, not collection recreation.** Zero data loss, no migration trap, and it self-corrects if a collection is ever recreated with a different space.
- **D2. `urlHash` is the join key; `tabId` is resolved at query time.** Content belongs to a page, not to a tab. This makes the index reload-durable by construction.
- **D3. `minSimilarity` always compares true cosine.** Both retrieval paths must return the same scale, or one shared threshold means two different things.
- **D4. Retrieval must never silently return nothing.** Every stage logs its count. A zero is logged loudly with the reason.
- **D5. Chunk text is stop-word filtered before entering a premise**, matching what `nli-select.js:292` already does for the title path. Denser premise, cheaper forward pass.
- **D6. Sections must be sanitized.** `tab-cards.js:43-46` sanitizes `mainText`/`excerpt`/`pseudoDoc` but **not** `sections` — and sections are exactly what now reaches the NLI. Close that hole.

---

## 4. Workstream A — make chunks actually reach the NLI

### Task 1 — Create `logger.js`

**New file:** `logger.js` (project root). Everything downstream logs through this, so build it first.

```js
// logger.js
// One step-trace for the whole pipeline. MV3 splits console output across the
// service worker, the offscreen document and the page, and the service worker's
// console is wiped every time it idles out (~30s). So every step is ALSO kept in
// a ring buffer in chrome.storage.local (survives worker restart AND extension
// reload) and mirrored to the page console via a broadcast.
(() => {
  const BUFFER_KEY = 'ts_trace_buffer';
  const MAX_ENTRIES = 600;
  const FLUSH_MS = 800;

  let seq = 0;
  let pending = [];
  let flushTimer = null;
  let runLabel = 'boot';

  function nowIso() {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      if (!batch.length) return;
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
        const got = await chrome.storage.local.get(BUFFER_KEY);
        const buf = Array.isArray(got[BUFFER_KEY]) ? got[BUFFER_KEY] : [];
        const next = buf.concat(batch);
        await chrome.storage.local.set({
          [BUFFER_KEY]: next.slice(Math.max(0, next.length - MAX_ENTRIES))
        });
      } catch (e) { /* logging must never break the pipeline */ }
    }, FLUSH_MS);
  }

  // Mirror into the active tab's console so steps are visible in the console you
  // already have open. Best-effort: no receiver is not an error.
  function mirror(line) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
      chrome.runtime.sendMessage({ type: 'TS_TRACE_LINE', line }).catch?.(() => {});
    } catch (e) { /* ignore */ }
  }

  const TSLog = {
    // Start a named run; resets the step counter so a command's steps read 1..N.
    run(label) {
      runLabel = String(label || 'run');
      seq = 0;
      this.step('RUN', `===== ${runLabel} =====`);
      return runLabel;
    },

    step(phase, msg, data) {
      seq += 1;
      const n = String(seq).padStart(3, '0');
      const line = `[TS ${n}] [${nowIso()}] [${phase}] ${msg}`;
      if (data !== undefined) {
        console.log(line, data);
      } else {
        console.log(line);
      }
      pending.push({ seq, t: Date.now(), run: runLabel, phase, msg, data: safe(data) });
      scheduleFlush();
      mirror(data !== undefined ? `${line} ${safe1(data)}` : line);
    },

    // Loud, always-visible failure. Use when a stage yields nothing.
    fail(phase, msg, data) {
      this.step(phase, `!! ${msg}`, data);
    },

    // Returns a function that logs the elapsed time when called.
    timer(phase, msg) {
      const t0 = Date.now();
      return (extra) => {
        const ms = Date.now() - t0;
        this.step(phase, `${msg} in ${ms}ms`, extra);
        return ms;
      };
    },

    async dump() {
      try {
        const got = await chrome.storage.local.get(BUFFER_KEY);
        return Array.isArray(got[BUFFER_KEY]) ? got[BUFFER_KEY] : [];
      } catch (e) { return []; }
    },

    async clear() {
      try { await chrome.storage.local.remove(BUFFER_KEY); } catch (e) {}
      pending = [];
      seq = 0;
    }
  };

  function safe(d) {
    if (d === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(d)); } catch { return String(d); }
  }
  function safe1(d) {
    try { return typeof d === 'string' ? d : JSON.stringify(d); } catch { return ''; }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { TSLog };
  if (typeof self !== 'undefined') self.TSLog = TSLog;
})();
```

**Then register it.** In `background.js`, find this exact line:

```js
importScripts('chroma-client.js', 'rag-chunker.js', 'db.js', 'embed.js', 'indexer.js', 'rag-retriever.js', 'recall-tabs.js', 'nli-select.js');
```

Replace with (`logger.js` must be **first** so later modules can use it):

```js
importScripts('logger.js', 'chroma-client.js', 'rag-chunker.js', 'db.js', 'embed.js', 'indexer.js', 'rag-retriever.js', 'recall-tabs.js', 'nli-select.js');
```

**Acceptance check:** `node -e "require('./logger.js')"` exits 0. Reload the extension, open the service worker console, confirm no `importScripts` error.

---

### Task 2 — Mirror the trace into the page console

**File:** `content.js`. Add this near the other `chrome.runtime.onMessage` handling (search for `onMessage.addListener`). Add as a **separate** listener; do not modify existing ones.

```js
// Mirror of the service-worker step trace. MV3 puts service-worker logs in a
// console you have to open separately (chrome://extensions -> Inspect views),
// so the pipeline looked completely silent. These lines are informational only.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'TS_TRACE_LINE' && typeof msg.line === 'string') {
    console.log('%c' + msg.line, 'color:#6b8afd');
  }
});
```

**Acceptance check:** reload the extension, open any normal page's console, run a tab command. Blue `[TS 001] ...` lines appear.

> If they do not appear, that is expected only when no content script is loaded on the active page (e.g. a `chrome://` page). Test on a normal `https://` page.

---

### Task 3 — Make `chroma-client.js` space-aware (fixes RC-1)

**File:** `chroma-client.js`

**3a.** In `getOrCreateCollection`, record the collection's real space. Find:

```js
        const data = await res.json();
        this._collectionCache.set(name, data);
        return data;
```

Replace with:

```js
        const data = await res.json();
        // The collection's ACTUAL distance space. `get_or_create` returns a
        // pre-existing collection and silently discards the requested config,
        // and HNSW space is immutable after creation -- so the space we asked
        // for is not necessarily the space we got. Read it back and convert
        // distances accordingly (see _toCosine).
        const space = data?.configuration_json?.hnsw?.space
          || data?.metadata?.['hnsw:space']
          || 'l2';
        data._space = String(space).toLowerCase();
        if (typeof self !== 'undefined' && self.TSLog) {
          self.TSLog.step('Chroma', `collection "${name}" space=${data._space} dim=${data.dimension ?? '?'}`);
        }
        this._collectionCache.set(name, data);
        return data;
```

**3b.** Add a conversion helper. Insert immediately **before** `async query(queryEmbedding, options = {}) {`:

```js
    // Convert a Chroma distance into a TRUE cosine similarity in [0, 1].
    //
    // Embeddings are unit-normalised (embed.js uses normalize:true), so:
    //   cosine space -> distance = 1 - cos          => cos = 1 - d
    //   l2 space     -> distance = ||a-b||^2 = 2-2cos => cos = 1 - d/2
    //   ip space     -> distance = -dot = -cos      => cos = -d
    //
    // The old code hardcoded `1 - d` for every space. Against this l2-indexed
    // collection that turned a 0.15 threshold into an effective cos >= 0.575,
    // which almost nothing clears -- so retrieval returned nothing and the NLI
    // silently fell back to the title-only premise.
    _toCosine(dist, space) {
      const d = Number(dist);
      if (!Number.isFinite(d)) return 0;
      switch (space) {
        case 'cosine': return Math.max(0, Math.min(1, 1 - d));
        case 'ip':     return Math.max(0, Math.min(1, -d));
        case 'l2':
        default:       return Math.max(0, Math.min(1, 1 - d / 2));
      }
    }
```

**3c.** Use it in `query`. Find:

```js
        for (let i = 0; i < ids.length; i++) {
          const dist = distances[i] != null ? distances[i] : 1;
          const similarity = Math.max(0, 1 - dist);
```

Replace with:

```js
        const space = collection._space || 'l2';
        for (let i = 0; i < ids.length; i++) {
          const dist = distances[i] != null ? distances[i] : 2;
          const similarity = this._toCosine(dist, space);
```

**3d.** Log the real numbers. Find:

```js
        const dur = Date.now() - t0;
        console.log(`⏱️ [ChromaDB] HNSW Vector query returned ${results.length} chunks from collection "${collectionName}" in ${dur}ms (where=${JSON.stringify(where || {})})`);
        return { results, success: true, durMs: dur };
```

Replace with:

```js
        const dur = Date.now() - t0;
        const top = results.length ? results[0].similarity.toFixed(3) : 'n/a';
        const msg = `query -> ${results.length} chunks (space=${space}, topCos=${top}) in ${dur}ms where=${JSON.stringify(where || {})}`;
        if (typeof self !== 'undefined' && self.TSLog) {
          if (results.length === 0) self.TSLog.fail('Chroma', `${msg} -- NO CHUNKS`);
          else self.TSLog.step('Chroma', msg);
        } else {
          console.log(`⏱️ [ChromaDB] ${msg}`);
        }
        return { results, success: true, durMs: dur, space };
```

**3e.** Fix the mixed-embeddings payload. Find:

```js
        if (embeddings.some(e => e.length > 0)) {
          payload.embeddings = embeddings;
        }
```

Replace with:

```js
        // All-or-nothing: a batch containing even one `[]` is a dimension
        // mismatch and Chroma rejects the whole upsert.
        if (embeddings.length && embeddings.every(e => e.length > 0)) {
          payload.embeddings = embeddings;
        } else if (embeddings.some(e => e.length > 0)) {
          const dropped = embeddings.filter(e => e.length === 0).length;
          if (typeof self !== 'undefined' && self.TSLog) {
            self.TSLog.fail('Chroma', `upsert: ${dropped}/${embeddings.length} chunks missing embeddings; sending documents only`);
          }
        }
```

**3f.** Add a count method, needed by Task 10. Insert before `async deleteByUrlHash`:

```js
    async count(collectionName = COLLECTION_CHUNKS) {
      const online = await this.isOnline();
      if (!online) return -1;
      try {
        const collection = await this.getOrCreateCollection(collectionName);
        const res = await this._fetchWithTimeout(
          `${this._getCollectionApiPrefix()}/${collection.id}/count`, { method: 'GET' });
        if (!res.ok) return -1;
        return Number(await res.json()) || 0;
      } catch (e) { return -1; }
    }
```

**Acceptance check:** `node tests/run-phase0.js` green, then:
```bash
node bench/chroma-query-probe.js
```
The `keptByChroma` column must now be large (tens), not 0/1.

---

### Task 4 — Retrieve by `urlHash`, push the filter down (fixes RC-2 + RC-3)

**File:** `rag-retriever.js`. Replace the **whole** `retrieveRelevantChunks` function (from `async retrieveRelevantChunks(query, candidateTabIds = null, options = {}) {` through its closing `},` just before `/**` of `formatDeepPremise`) with:

```js
    /**
     * Retrieve the most relevant chunks for a query, scoped to candidate tabs.
     *
     * Chunks are addressed by urlHash, NOT tabId. A chunk belongs to a PAGE;
     * tabId is an unstable tag that is only correct for whichever tab first
     * indexed that URL (tab-cards.js returns early on a cache hit and
     * background.js skips already-hashed URLs, so it is never refreshed). Fifty
     * tabIds in the live index owned chunks from more than one page, one of them
     * from eighteen. Joining on urlHash and resolving to the LIVE tabId here is
     * both correct and durable across extension reloads.
     *
     * @param {string} query
     * @param {Array<object|number>|Set<number>|null} candidates
     *        Preferred: candidate CARDS ({tabId, urlHash}). Bare tab ids still
     *        work but cannot be hash-joined, so they degrade to a global query.
     * @param {object} options
     *        topKPerTab (2), maxChunks (30), minSimilarity (0.15), domain
     * @returns {Promise<{chunksByTabId: Map<number, Array>, allChunks: Array, source: string, durMs: number}>}
     */
    async retrieveRelevantChunks(query, candidates = null, options = {}) {
      const L = (typeof self !== 'undefined' && self.TSLog) || null;
      const t0 = Date.now();
      const cleanQ = String(query || '').trim();
      const topKPerTab = options.topKPerTab || 2;
      const maxChunks = options.maxChunks || 30;
      const minSimilarity = options.minSimilarity ?? 0.15;
      const domain = options.domain ? String(options.domain).toLowerCase() : null;

      const empty = (source) => ({ chunksByTabId: new Map(), allChunks: [], source, durMs: Date.now() - t0 });

      if (!cleanQ) {
        L && L.fail('RAG', 'empty query, skipping retrieval');
        return empty('empty');
      }

      // --- 1. Build the urlHash <-> live tabId join ---------------------------
      const list = candidates instanceof Set ? Array.from(candidates) : (candidates || []);
      const hashToTabIds = new Map(); // urlHash -> [live tabId, ...]
      const candTabIds = new Set();
      for (const c of list) {
        if (c == null) continue;
        if (typeof c === 'number') { candTabIds.add(c); continue; }
        const tabId = Number(c.tabId);
        if (Number.isFinite(tabId)) candTabIds.add(tabId);
        const h = c.urlHash ? String(c.urlHash) : '';
        if (!h || !Number.isFinite(tabId)) continue;
        if (!hashToTabIds.has(h)) hashToTabIds.set(h, []);
        hashToTabIds.get(h).push(tabId);
      }
      const hashes = Array.from(hashToTabIds.keys());
      L && L.step('RAG', `retrieve "${cleanQ}" over ${candTabIds.size} candidate tabs / ${hashes.length} urlHashes`);

      if (list.length > 0 && hashes.length === 0) {
        L && L.fail('RAG', 'candidates carry no urlHash -- cannot scope retrieval; passing cards (not ids) is required');
      }

      // --- 2. Embed the query ------------------------------------------------
      let queryVector = null;
      const endEmbed = L && L.timer('RAG', 'query embedded');
      try {
        const embedder = Embed || (typeof self !== 'undefined' && self.Embed);
        if (embedder && typeof embedder.embed === 'function') {
          queryVector = await embedder.embed(cleanQ);
        }
      } catch (err) {
        L && L.fail('RAG', `query embedding threw: ${err.message}`);
      }
      endEmbed && endEmbed();
      if (!queryVector) {
        L && L.fail('RAG', 'no query embedding -- retrieval aborted');
        return empty('no_embedding');
      }

      // --- 3. Query Chroma, with the candidate hashes PUSHED DOWN ------------
      // Asking for the global top-N and filtering afterwards was measured at
      // 0-1 covered tabs; pushing the filter into the query gave 11-23.
      let rawChunks = [];
      let source = 'indexeddb';
      let chromaOk = false;

      const chroma = (typeof self !== 'undefined' && self.defaultChromaClient) ||
        (ChromaClient ? new ChromaClient() : null);

      if (chroma) {
        try {
          if (await chroma.isOnline()) {
            const where = {};
            if (hashes.length) {
              // $in has a practical payload ceiling; batch wide candidate sets.
              const BATCH = 200;
              const batches = [];
              for (let i = 0; i < hashes.length; i += BATCH) batches.push(hashes.slice(i, i + BATCH));
              const perBatch = Math.max(maxChunks, Math.ceil(maxChunks / batches.length) * 2);
              const collected = [];
              for (const b of batches) {
                const w = { urlHash: { $in: b } };
                if (domain) w.domain = domain;
                const res = await chroma.query(queryVector, { nResults: perBatch, where: w });
                if (res.success && Array.isArray(res.results)) collected.push(...res.results);
              }
              collected.sort((a, b) => b.similarity - a.similarity);
              rawChunks = collected.slice(0, maxChunks);
              chromaOk = true;
              L && L.step('RAG', `chroma: ${batches.length} batch(es) -> ${collected.length} chunks, kept top ${rawChunks.length}`);
            } else {
              if (domain) where.domain = domain;
              const res = await chroma.query(queryVector, {
                nResults: maxChunks,
                where: Object.keys(where).length ? where : undefined
              });
              if (res.success && Array.isArray(res.results)) {
                rawChunks = res.results;
                chromaOk = true;
              }
            }
            if (chromaOk) source = 'chroma';
          } else {
            L && L.step('RAG', 'chroma offline -> IndexedDB fallback');
          }
        } catch (e) {
          L && L.fail('RAG', `chroma query failed: ${e.message}`);
          chromaOk = false;
        }
      }

      // --- 4. IndexedDB fallback (same urlHash scoping) ----------------------
      if (!chromaOk) {
        try {
          const db = TabDB || (typeof self !== 'undefined' && self.TabDB);
          if (db && typeof db.queryLocalChunks === 'function') {
            rawChunks = await db.queryLocalChunks(queryVector, {
              topK: maxChunks,
              urlHashes: hashes.length ? hashes : null,
              domain
            });
            source = 'indexeddb';
            L && L.step('RAG', `indexeddb -> ${rawChunks.length} chunks`);
          }
        } catch (e) {
          L && L.fail('RAG', `IndexedDB chunk query failed: ${e.message}`);
        }
      }

      // --- 5. Map chunks back onto LIVE tab ids ------------------------------
      const chunksByTabId = new Map();
      const validChunks = [];
      let droppedLowSim = 0;
      let droppedUnjoinable = 0;

      for (const chunk of rawChunks) {
        const sim = chunk.similarity;
        if (sim != null && sim < minSimilarity) { droppedLowSim++; continue; }

        const h = chunk.urlHash || chunk.metadata?.urlHash || '';
        let targets = h && hashToTabIds.has(h) ? hashToTabIds.get(h) : null;

        if (!targets) {
          // No hash join available (bare-id caller, or a chunk from a page that
          // is not among the candidates). Fall back to the stored tabId ONLY if
          // it is actually a candidate -- never trust it otherwise.
          const stored = Number(chunk.tabId ?? chunk.metadata?.tabId);
          if (Number.isFinite(stored) && candTabIds.has(stored)) targets = [stored];
        }
        if (!targets || !targets.length) { droppedUnjoinable++; continue; }

        validChunks.push(chunk);
        for (const tabId of targets) {
          if (!chunksByTabId.has(tabId)) chunksByTabId.set(tabId, []);
          const bucket = chunksByTabId.get(tabId);
          if (bucket.length < topKPerTab) bucket.push(chunk);
        }
      }

      const durMs = Date.now() - t0;
      const label = source === 'chroma' ? 'ChromaDB(HNSW)' : 'IndexedDB(rag_chunks)';
      if (L) {
        const summary = `${validChunks.length} chunks over ${chunksByTabId.size}/${candTabIds.size} tabs via ${label} in ${durMs}ms ` +
          `(dropped: ${droppedLowSim} lowSim<${minSimilarity}, ${droppedUnjoinable} unjoinable)`;
        if (chunksByTabId.size === 0) L.fail('RAG', `${summary} -- NLI will use title-only premise`);
        else L.step('RAG', summary);
      }

      return { chunksByTabId, allChunks: validChunks, source, durMs };
    },
```

**Acceptance check:** `node tests/run-phase0.js` green. `tests/rag-retriever.test.js` may need its call updated — see Task 8.

---

### Task 5 — Support `urlHashes` in the local fallback (and stop full-scanning)

**File:** `db.js`. In `queryLocalChunks`, find:

```js
      const topK = options.topK || 10;
      const candidateTabIds = options.candidateTabIds ? new Set(options.candidateTabIds) : null;
      const domain = options.domain ? String(options.domain).toLowerCase() : null;

      const chunks = await this.getAllChunks();
      if (!chunks || chunks.length === 0) return [];
```

Replace with:

```js
      const topK = options.topK || 10;
      const candidateTabIds = options.candidateTabIds ? new Set(options.candidateTabIds) : null;
      const urlHashes = options.urlHashes && options.urlHashes.length
        ? Array.from(new Set(options.urlHashes)) : null;
      const domain = options.domain ? String(options.domain).toLowerCase() : null;

      // Prefer the urlHash index over a full scan. getAllChunks() read every
      // record (2252 and growing) on every single topic filter.
      let chunks;
      if (urlHashes) {
        const perHash = await Promise.all(urlHashes.map(h => this.getChunksByUrlHash(h).catch(() => [])));
        chunks = perHash.flat();
      } else {
        chunks = await this.getAllChunks();
      }
      if (!chunks || chunks.length === 0) return [];
```

Then find and **delete** this line (the tabId filter is what we are removing):

```js
        if (candidateTabIds && !candidateTabIds.has(c.tabId)) continue;
```

Replace it with:

```js
        // Deliberately NOT filtered by c.tabId: a chunk's stored tabId is only
        // correct for whichever tab first indexed that URL. urlHash scoping
        // above is the durable filter; rag-retriever.js maps back to live tabs.
        if (candidateTabIds && !urlHashes && !candidateTabIds.has(c.tabId)) continue;
```

Finally, make the result carry `urlHash` at the top level so the retriever can join. Find:

```js
        scored.push({
          chunkId: c.chunkId,
          similarity,
          text: c.text,
```

Confirm the object already ends with `urlHash: c.urlHash,` further down (it does). No change needed if present — **verify** it.

**Acceptance check:** `node tests/run-phase0.js` green.

---

### Task 6 — Pass cards (not bare ids) from the agent

**File:** `command-agent.js`. In `makeFindByTopic`, find:

```js
          const candIds = list.map(c => c.tabId);
          const ragRes = await self.RagRetriever.retrieveRelevantChunks(String(topicValue), candIds, { topKPerTab: 2 });
```

Replace with:

```js
          // Pass the CARDS, not bare ids: the retriever joins chunks on the
          // stable urlHash and resolves back to the live tabId.
          const ragRes = await self.RagRetriever.retrieveRelevantChunks(
            String(topicValue), list, { topKPerTab: 2 });
```

Also add a step log. Find:

```js
          if (ragRes && ragRes.chunksByTabId && ragRes.chunksByTabId.size > 0) {
            relevantChunksByTabId = ragRes.chunksByTabId;
          }
        } catch (e) {
          // RAG retrieval optional fallback
        }
```

Replace with:

```js
          if (ragRes && ragRes.chunksByTabId && ragRes.chunksByTabId.size > 0) {
            relevantChunksByTabId = ragRes.chunksByTabId;
          } else if (self.TSLog) {
            self.TSLog.fail('Topic', `no chunks for "${topicValue}" -- NLI falls back to title-only premise`);
          }
        } catch (e) {
          if (self.TSLog) self.TSLog.fail('Topic', `RAG retrieval threw: ${e && e.message}`);
        }
```

**Acceptance check:** `node tests/run-phase0.js` green.

---

### Task 7 — Densify and budget the deep premise (D5)

**File:** `rag-retriever.js`, function `formatDeepPremise`. Find:

```js
      if (Array.isArray(relevantChunks) && relevantChunks.length > 0) {
        for (let i = 0; i < relevantChunks.length; i++) {
          const c = relevantChunks[i];
          const sec = c.section ? `[Section: ${c.section}] ` : '';
          const txt = String(c.text || '').replace(/^\[Section:[^\]]+\]\s*/i, '').replace(/\s+/g, ' ').trim();
          if (txt) {
            parts.push(`Relevant Content ${i + 1} ${sec}: ${txt.slice(0, 600)}.`);
          }
        }
      } else {
```

Replace with:

```js
      if (Array.isArray(relevantChunks) && relevantChunks.length > 0) {
        // Stop-word filter chunk text, matching what nli-select.js already does
        // for the title path. DeBERTa's window is 512 tokens; prose wastes it on
        // filler, and a longer sequence costs more per forward pass.
        const strip = (typeof self !== 'undefined' && self.NliSelect && self.NliSelect.filterStopWords)
          ? self.NliSelect.filterStopWords
          : (t) => t;
        for (let i = 0; i < relevantChunks.length; i++) {
          const c = relevantChunks[i];
          const sec = c.section ? `[Section: ${c.section}] ` : '';
          const raw = String(c.text || '')
            .replace(/^\[Section:[^\]]+\]\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();
          const txt = strip(raw).slice(0, 600);
          if (txt) parts.push(`Relevant Content ${i + 1} ${sec}: ${txt}.`);
        }
      } else {
```

**File:** `nli-select.js` — export the existing filter so the retriever can use it. Find the export block near the bottom (it assigns `self.NliSelect`). Locate the object literal being exported and add `filterStopWords` to it alongside `select`. If the export looks like `self.NliSelect = { select, setEmbedder, ... }`, add `filterStopWords,`.

> If you cannot find a plain object export, instead add `NliSelect.filterStopWords = filterStopWords;` immediately after the assignment to `self.NliSelect`. Either is acceptable; do not restructure the module.

**Acceptance check:** `node tests/run-phase0.js` green. In a Node REPL, `require('./nli-select.js')` then confirm `filterStopWords` is a function on the export.

---

### Task 8 — Update the two RAG tests to the new signature

**File:** `tests/rag-retriever.test.js`

1. Find the `TabDB.queryLocalChunks(graphQueryVector, { topK: 5 })` call. Leave it — the no-scope path still works.
2. Add two new assertions at the end, before any cleanup:

```js
// urlHash join: passing CARDS must resolve chunks onto the live tabId, even when
// the chunk's stored tabId is stale (the real-world case -- 50 tabIds in the
// live index owned chunks from more than one page).
const staleChunks = [
  { chunkId: 'h1_c0', tabId: 999, urlHash: 'hash_join', url: 'https://x.test/a',
    domain: 'x.test', title: 'Graph', section: 'Main',
    text: 'topological sort kahn algorithm graph', embedding: Array.from(graphQueryVector) }
];
await TabDB.storeChunks(staleChunks);
const joined = await RagRetriever.retrieveRelevantChunks(
  'graph algorithms',
  [{ tabId: 4242, urlHash: 'hash_join' }],   // live tab id differs from stored 999
  { minSimilarity: 0 }
);
ok('urlHash join maps chunk onto the LIVE tabId, not the stale stored one',
   joined.chunksByTabId.has(4242) && !joined.chunksByTabId.has(999),
   `keys=${[...joined.chunksByTabId.keys()].join(',')}`);

// A chunk whose page is not among the candidates must never be attached.
const foreign = await RagRetriever.retrieveRelevantChunks(
  'graph algorithms',
  [{ tabId: 5151, urlHash: 'hash_not_present' }],
  { minSimilarity: 0 }
);
ok('chunks from non-candidate pages are dropped', foreign.chunksByTabId.size === 0,
   `size=${foreign.chunksByTabId.size}`);

await TabDB.deleteChunksByUrlHash('hash_join');
```

3. **Stop polluting the live collection.** This suite currently reaches the real server on `localhost:8000` — there is a `test1` record with all-`0.1` values and a stray `test_col` in production as a result. At the top of the file, before any `TabDB` call, add:

```js
// Never touch the real vector DB from tests. defaultChromaClient auto-detects
// localhost:8000; point it at a closed port so every Chroma call takes the
// offline path and only IndexedDB is exercised.
if (typeof self !== 'undefined' && self.defaultChromaClient) {
  self.defaultChromaClient.baseUrl = 'http://127.0.0.1:9999';
  self.defaultChromaClient._isOnline = false;
  self.defaultChromaClient._checkInterval = Number.MAX_SAFE_INTEGER;
}
```

**Acceptance check:** `node tests/run-phase0.js` — all suites green, and the run prints **no** `Connection verified at http://localhost:8000` line.

---

## 5. Workstream B — extract more data per tab

### Task 9 — Widen extraction in `extract-core.js`

**File:** `extract-core.js`

**9a. Fix the heading walker — this is the biggest real gap.** `extractDocumentSections` walks `h.nextElementSibling`, so it only captures content that is a **sibling** of the heading. Modern SPA markup wraps heading and body in separate containers (`<div><h2>..</h2></div><div>content</div>`), and for those pages the walker captures **nothing**. Find:

```js
      const headings = Array.from(bodyClone.querySelectorAll('h1, h2, h3, h4, h5, h6'));
```

and the `while (curr)` loop below it. Replace the whole `if (headings.length > 0) { ... }` block with:

```js
      const headings = Array.from(bodyClone.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      if (headings.length > 0) {
        // Document-order walk instead of nextElementSibling. The sibling walk
        // captured nothing whenever a heading and its body sat in different
        // wrapper elements, which is the norm in React/Angular markup.
        const ORDER = new Map();
        {
          const all = bodyClone.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) ORDER.set(all[i], i);
        }
        const headingPos = headings.map(h => ORDER.get(h) ?? 0);

        for (let i = 0; i < headings.length; i++) {
          const h = headings[i];
          const headingText = (h.textContent || '').replace(/\s+/g, ' ').trim();
          if (!headingText) continue;
          const level = parseInt(h.tagName.substring(1), 10) || 2;

          // The section ends at the next heading of the same or shallower level.
          let endPos = Infinity;
          for (let j = i + 1; j < headings.length; j++) {
            const lvl = parseInt(headings[j].tagName.substring(1), 10) || 2;
            if (lvl <= level) { endPos = headingPos[j]; break; }
          }
          const startPos = headingPos[i];

          const contentParts = [];
          const codeBlocks = [];
          const seen = new Set();
          const CONTENT_SEL = 'p, li, dd, dt, td, th, blockquote, pre, code, figcaption, summary, [role="article"]';
          for (const el of bodyClone.querySelectorAll(CONTENT_SEL)) {
            const pos = ORDER.get(el) ?? -1;
            if (pos <= startPos || pos >= endPos) continue;
            if (h.contains(el)) continue;
            // Skip nested duplicates (an <li> inside an already-captured <li>).
            let ancestorCaptured = false;
            for (let p = el.parentElement; p; p = p.parentElement) {
              if (seen.has(p)) { ancestorCaptured = true; break; }
            }
            if (ancestorCaptured) continue;

            if (el.matches('pre, code') || /code|highlight/i.test(el.className || '')) {
              const codeText = (el.textContent || '').trim();
              if (codeText) codeBlocks.push(codeText.slice(0, 1000));
              seen.add(el);
              continue;
            }
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && text.length > 1) { contentParts.push(text); seen.add(el); }
          }

          const sectionText = contentParts.join('\n\n').trim();
          if (headingText || sectionText) {
            sections.push({ heading: headingText, level, text: sectionText, codeBlocks });
          }
        }
      }
```

**9b. Add table, definition-list and alt-text capture.** Insert this helper immediately **before** `function extractDocumentSections(doc) {`:

```js
  // Content types the section walker reads poorly: tables (row structure is
  // meaningful), definition lists, and image alt text (often the only
  // description of a chart or diagram).
  function extractAuxiliarySections(doc) {
    const out = [];
    try {
      const tables = Array.from(doc.querySelectorAll('table')).slice(0, 8);
      for (const t of tables) {
        const rows = Array.from(t.querySelectorAll('tr')).slice(0, 40);
        const lines = rows.map(r =>
          Array.from(r.querySelectorAll('th, td'))
            .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean).join(' | ')
        ).filter(l => l.length > 2);
        if (lines.length >= 2) {
          const caption = (t.querySelector('caption')?.textContent || '').replace(/\s+/g, ' ').trim();
          out.push({ heading: caption || 'Table', level: 3, text: lines.join('\n'), codeBlocks: [] });
        }
      }

      const dls = Array.from(doc.querySelectorAll('dl')).slice(0, 5);
      for (const dl of dls) {
        const pairs = [];
        const kids = Array.from(dl.children);
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].tagName !== 'DT') continue;
          const term = (kids[i].textContent || '').replace(/\s+/g, ' ').trim();
          const def = kids[i + 1] && kids[i + 1].tagName === 'DD'
            ? (kids[i + 1].textContent || '').replace(/\s+/g, ' ').trim() : '';
          if (term) pairs.push(def ? `${term}: ${def}` : term);
        }
        if (pairs.length >= 2) {
          out.push({ heading: 'Definitions', level: 3, text: pairs.join('\n'), codeBlocks: [] });
        }
      }

      const alts = Array.from(doc.querySelectorAll('img[alt], [aria-label]'))
        .map(el => (el.getAttribute('alt') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(a => a.length > 12 && a.length < 300);
      const uniqueAlts = Array.from(new Set(alts)).slice(0, 25);
      if (uniqueAlts.length >= 2) {
        out.push({ heading: 'Media descriptions', level: 4, text: uniqueAlts.join('\n'), codeBlocks: [] });
      }
    } catch (e) {}
    return out;
  }
```

**9c. Merge the auxiliary sections in.** Find:

```js
    if (out.extractionLevel === 'turndown-custom') {
      out.sections = extractMarkdownSections(out.mainText, doc.title);
    } else {
      out.sections = extractDocumentSections(doc);
    }
    
    return out;
```

Replace with:

```js
    if (out.extractionLevel === 'turndown-custom') {
      out.sections = extractMarkdownSections(out.mainText, doc.title);
    } else {
      out.sections = extractDocumentSections(doc);
    }

    // Tables / definition lists / alt text, which the prose walkers miss.
    try {
      const aux = extractAuxiliarySections(doc);
      if (aux.length) out.sections = out.sections.concat(aux);
    } catch (e) {}

    // Keep the per-page chunk budget bounded (see rag-chunker MAX_CHUNKS_PER_TAB,
    // which caps per SECTION, not per document).
    if (Array.isArray(out.sections) && out.sections.length > 40) {
      out.sections = out.sections
        .sort((a, b) => (b.text || '').length - (a.text || '').length)
        .slice(0, 40);
    }

    return out;
```

**9d. Export the new helper.** Find `globalThis.extractDocumentSections = extractDocumentSections;` and add below it:

```js
  globalThis.extractAuxiliarySections = extractAuxiliarySections;
```

**Acceptance check:** `node tests/run-phase0.js` green (the rag-chunker suite exercises sections). Then reload the extension, open a React-heavy docs page and a page with a table, and confirm the service worker console shows a **higher** section count than before in the `[TabCards] ... extracted N sections -> M chunks` line.

---

### Task 10 — Sanitize sections (D6 — security gap)

**File:** `tab-cards.js`. `sanitizePageContent` is applied to `mainText`, `excerpt` and `pseudoDoc` but **not** to `sections` — and sections are exactly what now reaches the NLI premise. Find:

```js
        if (data) {
            data.mainText = sanitizePageContent(data.mainText);
            data.excerpt = sanitizePageContent(data.excerpt);
            data.harvestTags = (data.harvestTags || []).slice(0, 8).map(String);
            data.pseudoDoc = sanitizePageContent(data.pseudoDoc || '').slice(0, 800);
        }
```

Replace with:

```js
        if (data) {
            data.mainText = sanitizePageContent(data.mainText);
            data.excerpt = sanitizePageContent(data.excerpt);
            data.harvestTags = (data.harvestTags || []).slice(0, 8).map(String);
            data.pseudoDoc = sanitizePageContent(data.pseudoDoc || '').slice(0, 800);
            // Sections feed the RAG chunks that now build the NLI premise, so
            // they need the same injection scrubbing as mainText.
            if (Array.isArray(data.sections)) {
                data.sections = data.sections.map(s => ({
                    heading: sanitizePageContent(String(s.heading || '')).slice(0, 200),
                    level: Number(s.level) || 2,
                    text: sanitizePageContent(String(s.text || '')),
                    codeBlocks: Array.isArray(s.codeBlocks)
                        ? s.codeBlocks.slice(0, 10).map(c => sanitizePageContent(String(c)).slice(0, 1000))
                        : []
                }));
            }
        }
```

**Acceptance check:** `node tests/run-phase0.js` green.

---

### Task 11 — Re-chunk when page content changes

**File:** `tab-cards.js`. The cache-hit path returns early and never re-chunks, so a page whose content changed keeps stale chunks. Find:

```js
  if (cachedCard) {
    const newCard = {
      ...cachedCard,
      tabId: tab.id,
      title: tab.title || cachedCard.title,
      url: tab.url,
      extractedAt: Date.now()
    };
    await self.TabDB.storeTabCard(newCard);
    return { status: 'cached', card: newCard };
  }
```

Replace with:

```js
  if (cachedCard) {
    const newCard = {
      ...cachedCard,
      tabId: tab.id,
      title: tab.title || cachedCard.title,
      url: tab.url,
      extractedAt: Date.now()
    };
    await self.TabDB.storeTabCard(newCard);
    // NOTE: chunks are deliberately NOT rewritten here. They are keyed by
    // urlHash (stable) and rag-retriever.js resolves them onto the live tabId,
    // so a cache hit needs no chunk update. Only missing chunks are backfilled.
    try {
      if (self.TabDB && typeof self.TabDB.getChunksByUrlHash === 'function') {
        const existing = await self.TabDB.getChunksByUrlHash(urlHash);
        if (!existing || existing.length === 0) {
          if (self.TSLog) self.TSLog.step('TabCards', `cached card ${urlHash.slice(0, 8)} has no chunks -- will re-extract`);
          // Fall through to a full rebuild so chunks get created.
        } else {
          return { status: 'cached', card: newCard };
        }
      } else {
        return { status: 'cached', card: newCard };
      }
    } catch (e) {
      return { status: 'cached', card: newCard };
    }
  }
```

**Acceptance check:** `node tests/run-phase0.js` green. Manually: delete a page's chunks, revisit the page, confirm chunks reappear.

---

## 6. Workstream C — persistence across extension reload

### Task 12 — Make the ChromaDB server persistent

Chroma stores data **server-side**. If it was started without a path it is in-memory and everything is lost when the server restarts. Start it with an explicit on-disk path:

```bash
chroma run --host 127.0.0.1 --port 8000 --path C:\Users\bkh\chroma-data
```

Verify persistence:
```bash
curl -s http://localhost:8000/api/v2/version
# restart the server, then re-run the count below -- it must be unchanged
```

**Optional cleanup (not required — Task 3 makes it unnecessary):** if you want `tab_chunks` in true cosine space, delete and re-create it, then run Task 13's backfill to restore all 2252 chunks from IndexedDB.

```bash
BASE=http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections
curl -s -X DELETE $BASE/tab_chunks
```

Also remove the test pollution left by earlier runs:
```bash
curl -s -X DELETE $BASE/test_col
```

**Do not do this before Task 13 is implemented**, or the index will be empty with no way to refill it.

---

### Task 13 — Backfill Chroma from IndexedDB on startup

This is the actual "index survives an extension reload" fix. Today `syncMissingTabsToChroma` decides what is missing by reading **IndexedDB** (`existingChunkHashes` at `background.js:5276`), not Chroma. So if Chroma is empty or was restarted, every hash still looks present locally and the sync reports `0 chunks to sync` while Chroma stays empty forever.

**File:** `background.js`. Find:

```js
    const existingChunkHashes = new Set(allExistingChunks.map(c => c.urlHash).filter(Boolean));
    const cardMap = new Map(allCards.map(c => [c.urlHash, c]));
```

Replace with:

```js
    const existingChunkHashes = new Set(allExistingChunks.map(c => c.urlHash).filter(Boolean));
    const cardMap = new Map(allCards.map(c => [c.urlHash, c]));

    // Reconcile Chroma against IndexedDB before deciding anything is "missing".
    // `existingChunkHashes` comes from IndexedDB, so a wiped or restarted Chroma
    // would otherwise look fully populated and never be refilled. Local chunks
    // already carry their embeddings, so this needs no re-embedding.
    try {
      const remoteCount = typeof chroma.count === 'function' ? await chroma.count() : -1;
      const localCount = allExistingChunks.length;
      self.TSLog && self.TSLog.step('Sync', `chunk counts -- chroma=${remoteCount} local=${localCount}`);

      if (remoteCount >= 0 && localCount > 0 && remoteCount < localCount) {
        const withVectors = allExistingChunks.filter(c => Array.isArray(c.embedding) && c.embedding.length > 0);
        self.TSLog && self.TSLog.step('Sync',
          `backfilling ${withVectors.length} local chunks into Chroma (missing ${localCount - remoteCount})`);
        const B = 128;
        let pushed = 0;
        for (let i = 0; i < withVectors.length; i += B) {
          const batch = withVectors.slice(i, i + B);
          const res = await chroma.upsertChunks(batch, batch.map(c => c.embedding));
          pushed += (res && res.count) || 0;
        }
        self.TSLog && self.TSLog.step('Sync', `backfill complete: ${pushed} chunks upserted`);
      }
    } catch (e) {
      self.TSLog && self.TSLog.fail('Sync', `backfill failed: ${e.message}`);
    }
```

Also replace the silent "nothing to do" branch. Find:

```js
    if (missingChunks.length === 0) {
      console.log(`⏱️ [ChromaDB:Sync] Verified database: all ${eligibleLiveTabs.length} live open tabs already have chunks indexed. 0 chunks to sync.`);
```

Replace the `console.log` line with:

```js
    if (missingChunks.length === 0) {
      self.TSLog
        ? self.TSLog.step('Sync', `all ${eligibleLiveTabs.length} eligible live tabs already have chunks; 0 to sync`)
        : console.log(`⏱️ [ChromaDB:Sync] all ${eligibleLiveTabs.length} live tabs indexed. 0 chunks to sync.`);
```

**Acceptance check:**
1. Note the count: `curl -s $BASE/<collection-id>/count`.
2. Delete the collection (Task 12 command).
3. Reload the extension and open the service worker console.
4. You must see `backfilling N local chunks into Chroma` followed by `backfill complete`.
5. Re-check the count — it should return to roughly the previous number.

---

### Task 14 — Add a trace dump command

**File:** `background.js`. Add a new `case` alongside the existing `DEBUG_GET_TABS` handler (search for `case "DEBUG_GET_TABS":`). Insert before it:

```js
    case "TS_TRACE_DUMP": {
      (async () => {
        try {
          const entries = self.TSLog ? await self.TSLog.dump() : [];
          sendResponse({ success: true, count: entries.length, entries });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    case "TS_TRACE_CLEAR": {
      (async () => {
        try { self.TSLog && await self.TSLog.clear(); sendResponse({ success: true }); }
        catch (e) { sendResponse({ success: false, error: e.message }); }
      })();
      return true;
    }
```

**How to read the trace from any page console** (document this for the user):

```js
chrome.runtime.sendMessage({ type: 'TS_TRACE_DUMP' }, r =>
  console.table(r.entries.map(e => ({ seq: e.seq, phase: e.phase, msg: e.msg }))));
```

**Acceptance check:** run the snippet in a page console after issuing a tab command; a table of numbered steps appears, including steps recorded **before** the current service-worker lifetime.

---

## 7. Verification protocol (run all of this at the end)

**7.1 Unit suites**
```bash
node tests/run-phase0.js      # every suite must pass, and must NOT contact localhost:8000
```

**7.2 Retrieval probes** (require Chroma running)
```bash
node bench/chroma-query-probe.js       # keptByChroma must be tens, not 0/1
node bench/chroma-candidate-probe.js   # shipped vs pushed-down gap should close
node bench/chroma-tabid-probe.js       # informational: collisions no longer matter
```

**7.3 Accuracy regression — the gate that decides ship / no-ship**

Run the 112-command benchmark that already exists in `bench/`.

```bash
node bench/<the 112-command runner>    # locate it: it reads commands-v2.jsonl
```

- **Baseline to beat: set-exact 100/112 (89%).**
- If set-exact **drops**, the richer premise is adding noise. Do **not** ship. Try, in order: lower `topKPerTab` to 1; raise `minSimilarity` to 0.25; shorten the per-chunk slice from 600 to 300.
- Record the number you get. Do not report a figure you did not run.

**7.4 Live browser check**
1. Reload the extension; open the service worker console (`chrome://extensions` → *Inspect views: service worker*).
2. Run `group all youtube tabs except the ones related to programming`.
3. The trace must show, in order: `RUN`, `RAG retrieve ... over N candidate tabs / M urlHashes`, `Chroma query -> K chunks (space=..., topCos=...)`, `RAG ... chunks over X/N tabs`, then NLI pass counts.
4. `X` must be **greater than 0**. If it is 0, the trace names which stage dropped everything — fix that stage.

**7.5 Latency — measure, do not assume**

Premises are now longer, so per-pass NLI cost will rise. Record `passes` and per-pass ms from the browser trace **before and after**. Only a browser (WASM) measurement is meaningful — the Node backend is ~110× faster and is not shipped, so never quote a Node figure as user-facing latency.

---

## 8. Task summary

| # | Task | File(s) | Fixes |
|---|---|---|---|
| 1 | Create `logger.js`, register it first | `logger.js`, `background.js` | RC-4 |
| 2 | Mirror trace to page console | `content.js` | RC-4 |
| 3 | Space-aware similarity + count + upsert guard | `chroma-client.js` | **RC-1** |
| 4 | Retrieve by urlHash, push filter down | `rag-retriever.js` | **RC-2, RC-3** |
| 5 | `urlHashes` support, drop full scan | `db.js` | RC-2, perf |
| 6 | Pass cards not ids | `command-agent.js` | RC-3 |
| 7 | Densify premise | `rag-retriever.js`, `nli-select.js` | D5 |
| 8 | Update + de-pollute tests | `tests/rag-retriever.test.js` | hygiene |
| 9 | Widen extraction | `extract-core.js` | more data |
| 10 | Sanitize sections | `tab-cards.js` | D6 security |
| 11 | Backfill missing chunks on cache hit | `tab-cards.js` | durability |
| 12 | Persistent Chroma server | ops | persistence |
| 13 | Backfill Chroma from IndexedDB | `background.js` | **persistence** |
| 14 | Trace dump command | `background.js` | RC-4 |

**Minimum set to make RAG work at all: Tasks 1, 3, 4, 5, 6.** Tasks 9–11 add data; 12–14 add durability and visibility.

---

## 9. Do NOT change these

- **`vendor/readibility.js` — do not "fix" the spelling.** `tab-cards.js:30` injects that exact filename. Renaming it silently disabled extraction for the entire life of the feature once already.
- **Do not remove the `matchDomains` short-circuit** in `nli-select.js`. Domain tokens are string containment, not entailment; removing it returned nothing for every domain command.
- **Do not re-enable LLM query expansion.** It was measured at 82% → 56% set-exact with 21 forbidden selections. There is a documented cliff at 0.6.
- **Do not change `DEFAULT_THRESHOLD` (0.55) or `UNCERTAIN_THRESHOLD` (0.35)** in `nli-select.js`, or the `0.55` / `0.35` inclusion/exclusion floors in `command-agent.js`. They are swept values, and the asymmetry is deliberate (precision for `is`, recall for `is_not`).
- **Do not bump `DB_VERSION`** in `db.js`. No schema change is required — `rag_chunks` already indexes `urlHash`, `tabId` and `domain`.
- **Do not delete the IndexedDB fallback.** It is the offline path and now also the backfill source.
- **Do not add a `console.log` gate or strip existing logs.** Nothing was being suppressed; the logs were in a console nobody had open.

---

## 10. Known limits after this work

- `minSimilarity: 0.15` and `topKPerTab: 2` are untuned guesses. Sweep them against the 112-command bench once retrieval actually returns chunks.
- Chunk `tabId` metadata stays stale in existing records. That is now harmless (nothing reads it), but it is dead data — a future cleanup could drop the field.
- The `$in` batching in Task 4 caps at 200 hashes per request. With ~1000 tabs that is ~5 requests per topic filter. If that shows up in the trace as slow, consider a single unfiltered query with a much larger `nResults` plus local filtering.
- End-to-end browser latency is still unmeasured. Section 7.5 is how to get a real number; do not invent one.
- Chroma is a **local dev dependency**. If the server is not running the extension silently uses IndexedDB, which is correct but slower (a full cosine scan). The trace now states which path ran.
