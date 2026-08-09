# Phase 2 Verification & Testing Guide

## Goal

Verify that the Retrieval-Augmented Generation (RAG) pipeline works correctly before introducing additional features such as preview mode, undo, or hybrid rule matching.

The objective is to validate each layer independently and then confirm the entire pipeline functions end-to-end.

---

# Expected Architecture

```
User

↓

content.js

↓

background.js

↓

SearchService

↓

EmbeddingService

↓

IndexedDB

↓

Top-K Retrieval

↓

ChatService

↓

Django

↓

Ollama

↓

Tool JSON

↓

TabService

↓

Chrome APIs
```

Every test in this document validates one part of this pipeline.

---

# Phase 1 — Verify Existing Components Still Work

Before testing RAG, ensure Phase 1 functionality has not regressed.

Verify:

* Extension loads successfully
* Django server starts
* Ollama server is running
* Chat endpoint still works
* Chrome commands still execute correctly

Commands to test:

```
group github tabs
close youtube tabs
pin amazon tabs
bookmark documentation tabs
focus gmail
```

Expected:

* Django receives the request.
* Ollama returns valid JSON.
* Chrome performs the requested action.
* Success toast appears.

If any Phase 1 functionality is broken, stop here.

---

# Phase 2 — Verify Embedding Endpoint

Purpose

Ensure Django can generate embeddings.

Start Django.

Send:

POST

```
/api/embeddings
```

Body

```json
{
    "text":"React documentation"
}
```

Expected

```json
{
    "embedding":[
        ...
    ]
}
```

Checks

✓ HTTP 200

✓ embedding exists

✓ embedding length > 0

✓ no null values

Repeat twice.

Embeddings should be nearly identical.

---

# Phase 3 — Verify TabCard Creation

Open a brand new browser tab.

Wait for indexing.

Inspect IndexedDB.

Expected

One TabCard.

Fields

```
tabId

title

url

summary

embedding

contentHash

lastIndexed
```

Checks

✓ contentHash exists

✓ lastIndexed exists

✓ summary not empty

✓ embedding not null

---

# Phase 4 — Verify Startup Indexing

Close Chrome.

Open Chrome with

10–20 existing tabs.

Reload extension.

Wait.

Inspect IndexedDB.

Expected

Exactly one TabCard for every open tab.

No manual refresh should be required.

Checks

```
Number of open tabs

==

Number of stored TabCards
```

---

# Phase 5 — Verify Incremental Indexing

Create a new tab.

Expected

```
tabs.onCreated

↓

TabCard created

↓

Embedding generated

↓

Stored
```

Close tab.

Expected

```
tabs.onRemoved

↓

TabCard deleted
```

Navigate to a different page.

Expected

```
tabs.onUpdated

↓

contentHash changes

↓

Embedding regenerated

↓

lastIndexed updated
```

---

# Phase 6 — Verify Cosine Similarity Search

Populate browser with diverse tabs.

Example

```
React Docs

GitHub React

Python Tutorial

Amazon Careers

YouTube

StackOverflow

Netflix
```

Open DevTools.

Execute SearchService directly.

Query

```
react tutorial
```

Expected ranking

```
1 React Docs

2 GitHub React

3 StackOverflow

...

Netflix

YouTube
```

Checks

✓ Highest similarity is React-related

✓ Results sorted descending

✓ Null embeddings ignored

✓ topK respected

---

# Phase 7 — Verify Query Embedding

Run

```
group react tabs
```

Observe network.

Exactly one request

```
POST

/api/embeddings
```

for the query.

Expected

```
Query

↓

Embedding

↓

Search
```

No duplicate embedding requests.

---

# Phase 8 — Verify Candidate Retrieval

After SearchService finishes

Log returned candidates.

Expected

Maximum

```
10
```

Each candidate

```
tabId

title

url

summary
```

No embeddings.

No raw page text.

Checks

✓ Candidate count <= topK

✓ Most relevant tabs included

✓ Irrelevant tabs excluded

---

# Phase 9 — Verify Chat Payload

Inspect

```
POST /api/chat
```

Payload should contain

```
prompt

candidateTabs
```

Example

```json
{
  "prompt":"group react tabs",
  "candidateTabs":[
      {
         "tabId":4,
         "title":"React Docs",
         "summary":"Official React documentation..."
      }
  ]
}
```

It should NOT include

* all browser tabs
* embeddings
* raw HTML
* page text

---

# Phase 10 — Verify Ollama Reasoning

Monitor Django logs.

Expected

```
Candidate Tabs

↓

Prompt

↓

Ollama

↓

JSON

↓

Response
```

Verify model never receives

50+

browser tabs.

Only retrieved candidates.

---

# Phase 11 — Verify Chrome Execution

Command

```
group github tabs
```

Expected

```
Search

↓

Top K

↓

LLM

↓

group_tabs

↓

chrome.tabs.group()
```

Verify

Correct tabs grouped.

Wrong tabs untouched.

Repeat

```
close youtube tabs

pin amazon tabs

focus gmail

bookmark docs
```

---

# Phase 12 — Failure Recovery

Stop Ollama.

Run

```
group github tabs
```

Expected

```
SearchService

↓

Still returns candidates

↓

Chat fails

↓

Friendly error

↓

No Chrome actions
```

Extension should remain responsive.

---

Delete IndexedDB.

Run command.

Expected

```
Re-index

↓

Generate embeddings

↓

Search

↓

Execute
```

No crashes.

---

Return malformed JSON from Django.

Expected

```
Validation failure

↓

Error toast

↓

No browser action
```

---

# Phase 13 — Performance Validation

Open

100 tabs.

Run

```
group github tabs
```

Measure

Search latency

Target

<50 ms

Embedding request

Target

<300 ms

Chat request

Target

<2 seconds

Extension should remain responsive throughout.

---

# Phase 14 — Test Suite

Run all automated tests.

Expected

```
tests/tabcard.test.js

8 / 8 passing
```

```
tests/db-search.test.js

6 / 6 passing
```

```
tests/searchservice.test.js

9 / 9 passing
```

```
tests/background-rag.test.js

7 / 7 passing
```

Total

```
30 / 30 tests passing
```

No skipped tests.

No flaky tests.

---

# Phase 15 — End-to-End Acceptance

The following workflow must succeed without any manual intervention.

```
Open Chrome

↓

Extension starts

↓

Indexes all existing tabs

↓

Generate embeddings

↓

Store TabCards

↓

User types

"group react tabs"

↓

Query embedding generated

↓

IndexedDB semantic search

↓

Top 10 candidates

↓

POST /api/chat

↓

Ollama

↓

Structured tool JSON

↓

Background executes tool

↓

Chrome groups tabs

↓

Success toast displayed
```

---

# Completion Checklist

All items below must be true before beginning Phase 3.

* [ ] Phase 1 functionality still passes.
* [ ] Existing tabs index automatically.
* [ ] New tabs index automatically.
* [ ] Updated tabs regenerate embeddings.
* [ ] Removed tabs are deleted from IndexedDB.
* [ ] Query embeddings are generated successfully.
* [ ] Cosine similarity returns relevant results.
* [ ] Only Top-K candidates are sent to Django.
* [ ] Ollama receives candidate tabs only.
* [ ] Chrome executes the returned tool correctly.
* [ ] All automated tests pass (30/30).
* [ ] Error handling works for Ollama failures, malformed JSON, and missing embeddings.
* [ ] End-to-end semantic command execution works consistently.

Once every item above is complete, the RAG foundation is considered stable and the project is ready for Phase 3 (preview/confirmation workflow, hybrid rule engine, workspace memory improvements, and undo support).
