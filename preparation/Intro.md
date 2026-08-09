# Three-Minute Project Introduction

---

## Why

Most people who use a browser heavily end up with the same problem: too many tabs, too little structure. The tab bar overflows, you lose track of what you had open, and doing anything meaningful with a hundred open tabs requires manual effort — scrolling, clicking, dragging, naming. Chrome's built-in tab grouping helps a little, but it is still entirely manual.

I wanted to remove that friction completely. The idea was straightforward: let me type what I want in plain English and have the browser figure out which tabs I mean and what to do with them. Say "group all my coding tabs," and the right tabs should be grouped automatically, without me having to point at each one.

There was also a privacy motivation. Most AI browser tools I saw were sending your tab titles and browsing history to cloud APIs. I wanted something that could run entirely on your own machine — no API key required, no data leaving your device.

---

## What

Tab Scroller is a Chrome extension that injects a thin tab management bar at the top of every page using Shadow DOM, and adds an AI command input where you type a `>` prefix to issue natural language commands.

The system supports about a dozen actions out of the box: grouping tabs by topic, closing them, bookmarking them, pinning, muting, sorting, and searching. It also has a semantic memory component — if you visit a page today, the extension indexes its content locally, and you can ask "find that article about protein folding I had open last week" and it will pull up the right result from its own vector store.

Commands are executed locally. The LLM runs via Ollama on your machine. The embeddings run in the browser itself using a vendored MiniLM model. Nothing is sent to the cloud by default.

---

## How

The architecture has three layers.

The content script injects the UI into every page as a closed Shadow DOM so it cannot interfere with the page's own CSS. When a command is typed, it sends a message to the service worker.

The service worker runs the command pipeline. It starts by classifying the command: if it mentions a specific domain like GitHub or YouTube, it takes a deterministic fast path that resolves in under 200 milliseconds with no AI involved. For semantic queries — "group all entertainment tabs" — it runs a hybrid retrieval pipeline. Each tab has a stored enrichment card with MiniLM embeddings and tags computed offline using a centroid-based math classifier. The command is embedded, scored against all cards using cosine similarity plus keyword overlap and domain priors, and the top candidates are sent to a local LLM. The LLM returns which of those candidates it thinks match and with what confidence.

One design decision I am particularly proud of is that the LLM never returns tab IDs. It can only classify the tabs it was given. The extension validates every ID the model returns against the original candidate set before execution. This eliminates hallucinated tab actions entirely.

The enrichment pipeline is also notable. Rather than calling the LLM to categorise each tab — which would take minutes for a large tab set — I use a pure-math approach. MiniLM embeddings of each page are compared against pre-computed centroid vectors for about 20 topic categories. This gives rich semantic tagging at zero extra cost or latency.

The main trade-off I made was using a 3-billion-parameter local model for the command reasoning step. It is fast and private, but it can struggle with ambiguous categories. I handle this with a two-round protocol: if the model is uncertain and requests more details in round one, it gets the full page text in round two. I had to be careful to merge rather than overwrite the results from both rounds — that was a real bug I had to fix.

---

## What Now

The project is an advanced MVP. The core pipeline works well for domain-specific and well-defined semantic commands. The main limitation right now is the absence of automated tests for the command-agent pipeline — the most complex part of the system has no unit tests, which makes iteration risky. The vector search is also a brute-force cosine scan over IndexedDB with no approximate nearest-neighbour index, which will become slow beyond about five thousand stored pages.

The most valuable next improvement would be adding unit tests for the retrieval and scoring logic so regressions are caught automatically. After that, replacing the brute-force vector search with a WASM-compiled HNSW index would make recall fast at any scale.

Longer term, I think the most interesting direction is improving the topic classifier — replacing the fixed centroid approach with a small distilled model trained on web category data would meaningfully improve precision for edge-case domains.

I am happy to go deeper on any part of this — the retrieval pipeline, the enrichment math, the two-round LLM protocol, or the privacy architecture.

---

## Thirty-Second Version

Tab Scroller is a Chrome extension with an AI command interface. You type `> group all coding tabs` or `> find that article I read last week` and the extension figures out which tabs you mean and acts on them. Everything runs locally — embeddings, topic classification, and LLM inference all happen on your machine using Ollama and a vendored MiniLM model. The key engineering decisions are: the LLM never selects tab IDs (only classifies pre-retrieved candidates), and tab enrichment uses a pure-math centroid classifier so we never need to call the LLM just to tag a page. It is an advanced MVP with a working semantic pipeline but no CI/CD and no tests for the command-agent yet.

---

## Key Points to Remember

1. **LLM never returns tab IDs** — it classifies candidates; extension validates and injects IDs. Eliminates hallucinations.
2. **Math enrichment, not LLM enrichment** — centroid classifer using MiniLM embeddings; zero API cost at indexing time.
3. **Two-round LLM protocol with result merging** — Round 1 compact metadata; Round 2 full page text if model requests; results merged not overwritten.
4. **Dynamic candidate cap** — floor((contextSize / 50) * 0.9); Gemini users get ~18000 slots; Ollama 8K users get ~147.
5. **Syntactic fast path** — domain-pattern commands complete in <200ms with no LLM call.
6. **Local-first privacy** — allowCloudContent is off by default; isLocalhost() enforces Ollama stays local.
7. **Shadow DOM closed mode** — CSS isolation works everywhere but blocks Playwright E2E tests.
8. **Biggest gap** — no tests for command-agent.js (the most complex component); brute-force cosine search in IndexedDB.
