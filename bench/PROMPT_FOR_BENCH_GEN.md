# PROMPT — Paste into Claude / GPT-4 / Gemini to generate per-bucket bench

COPY EVERYTHING BELOW THE LINE INTO NEW CHAT:

---

You are a BENCHMARK GENERATOR for a browser tab-scroller extension.

## POOL (frozen, 50 tabs — do NOT invent new tabs)

```json
[
  {"id": 1, "url": "https://www.amazon.com/dp/B0PHONE13", "title": "OnePlus 13 5G - Buy Online", "category": "shopping", "tags": ["phone","oneplus"]},
  {"id": 2, "url": "https://www.amazon.in/gp/cart", "title": "Amazon.in Shopping Cart: 3 items", "category": "shopping", "tags": ["cart"]},
  {"id": 3, "url": "https://www.amazon.co.uk/deals", "title": "Today's Lightning Deals - Amazon.co.uk", "category": "shopping", "tags": ["deals"]},
  {"id": 4, "url": "https://www.amazon.com/Atomic-Habits/dp/0735211299", "title": "Atomic Habits by James Clear", "category": "shopping", "tags": ["book","habits"]},
  {"id": 5, "url": "https://www.primevideo.com/detail/the-boys", "title": "The Boys S4 E5 - Prime Video", "category": "entertainment", "tags": ["streaming","video"]},
  {"id": 6, "url": "https://gadgetreseller-example.com/amazon-alternatives", "title": "Cheaper Than Amazon: 12 Gadget Reseller Shops", "category": "shopping", "tags": ["deals","gadgets"]},
  {"id": 7, "url": "https://www.youtube.com/watch?v=cwc-sixes", "title": "Cricket World Cup Highlights: Best Sixes", "category": "sports", "tags": ["video","highlights"]},
  {"id": 8, "url": "https://www.youtube.com/watch?v=lofi-mix", "title": "lofi hip hop radio - beats to relax/study", "category": "music", "tags": ["lofi","study"]},
  {"id": 9, "url": "https://www.youtube.com/shorts/cat23", "title": "Funny Cat Shorts #23", "category": "entertainment", "tags": ["cats","funny"]},
  {"id": 10, "url": "https://www.youtube.com/watch?v=op13-review", "title": "OnePlus 13 Review: Should You Buy It?", "category": "technology", "tags": ["review","phone"]},
  {"id": 11, "url": "https://creatorhub-example.com/captions-guide", "title": "How to Add Closed Captions to Your Videos", "category": "technology", "tags": ["captions","video-editing"]},
  {"id": 12, "url": "https://docs.google.com/document/d/1AbCdEfGh/edit", "title": "Q3 Team Roadmap - Google Docs", "category": "work", "tags": ["planning","roadmap"]},
  {"id": 13, "url": "https://docs.google.com/document/d/2XyZaBcDeFg/edit", "title": "Sprint Planning Notes - Google Docs", "category": "work", "tags": ["sprint","notes"]},
  {"id": 14, "url": "https://mail.google.com/mail/u/0", "title": "Inbox (12) - Gmail", "category": "work", "tags": ["email"]},
  {"id": 32, "url": "https://foodnetwork-example.com/easy-pasta", "title": "Easy Weeknight Pasta Recipes", "category": "food", "tags": ["recipe","pasta"]},
  {"id": 33, "url": "https://seriouseats-example.com/choc-chip-cookies", "title": "The Best Chocolate Chip Cookies", "category": "food", "tags": ["recipe","baking"]},
  {"id": 34, "url": "https://coinmarketcap-example.com/btc", "title": "Bitcoin Price Chart", "category": "finance", "tags": ["bitcoin","crypto"]},
  {"id": 35, "url": "https://etherscan-example.com/gas", "title": "Ethereum Gas Tracker", "category": "finance", "tags": ["ethereum","gas"]},
  {"id": 36, "url": "https://www.reddit.com/r/webdev/", "title": "Daily r/webdev Discussion", "category": "dev", "tags": ["forum","webdev"]}
]
```
(Full 50-tab pool in file `bench/golden-set.jsonl` line 2 — use that as source of truth. Never invent IDs outside 1-52 except 47,48 internal.)

## BUCKETS (14 — generate 8-10 cases EACH = 112-140 total)

| bucket | what it tests | min cases | must include varied difficulty |
|---|---|---|---|
| domain-brand | amazon regional, youtube subdomain, primevideo≠amazon, flipkart+ebay union | 8 | easy: `group all amazon tabs` → [1,2,3,4] / medium: `amazon.in` regional → [2] / hard: `not-amazon.com` must NOT match → 0 |
| topic | semantic topic without domain cue | 10 | easy: `cooking` → [32,33] / medium: `crypto` → [34,35,37] / hard: `cricket` 7 tabs incl dup+report ambiguous |
| exception-negation | complement logic | 8 | easy: `except the book one` / hard: direction-flipped `keep only without google` → [12,13,14] |
| vague-except | same but vague phrasing | 8 | `tabs that don't have google in domain` → complement / `not related to sports` vague |
| temporal | lastAccessed/openedAt windows | 8 | `from yesterday` (4 ids) / `older than a week` (3 ids) / `last 20 minutes` (10 ids) |
| state-duplicate | pinned/audible/muted/duplicate | 8 | `group my pinned tabs` → [12,14,41,42] / `close duplicate` → [45] only |
| homograph | close/caption, market close, pin/pinterest | 6 | `closed captions guide` [11] vs `market close` [26] — must disambiguate |
| zero-match | honest abstain | 8 | `knitting`, `disney plus` → [] / mustNotSelect empty |
| ambiguous-intent | 2 intents in one string | 8 | `close and group cricket` ambiguous:true / primary recorded |
| multi-group | split into buckets | 6 | `split into shopping and news` → buckets with tabIds |
| imperfect-english | typos, hedges, fragments | 10 | `cloes amzon`, `i dunno whatever looks old` → still must resolve |
| inverted-verb | unpin/unmute | 6 | `unpin all tabs` ≠ pin — substring trap |
| adversarial | SQL/JSON/system: injection | 6 | must be `clarify` with 0 ids |
| cross-window | windowId awareness (if you keep it) | 6 | single-window vs per-window |

## OUTPUT FORMAT (JSONL, one object per line)

```json
{"id":"GS-XXX","command":"close my cricket tabs","expectedIntent":"close_tabs","expectedTabIds":[1,2,4,8],"mustNotSelect":[7],"requiresConfirmation":true,"expectAmbiguous":false,"bucket":"topic","notes":"why"}
```

Fields:
- `id`: GS-001, GS-002...
- `command`: natural English, varied — imperative, fragment, typo, hedge, afterthought
- `expectedIntent`: one of close/group/bookmark/pin/unpin/mute/unmute/reload/sort/search_and_switch/open/clarify
- `expectedTabIds`: exact set (empty = abstain is CORRECT)
- `mustNotSelect`: hard violations — picking any = fail
- `requiresConfirmation`: true for destructive/large
- `expectAmbiguous`: true → correct behavior is preview/ask, not silent execute
- `bucket`: one of 14 above
- `acceptableSuperset`: optional [[1,2,3,4,5]] for defensible alternates (e.g. primevideo inclusive)
- `notes`: 1-line why

## RULES

1. **Never hallucinate IDs** — every ID must exist in pool. Internal 47,48 never in expectedTabIds.
2. **Varied difficulty inside EACH bucket**: 30% easy (single token, exact host/tag), 40% medium (typo/synonym, 2-3 tabs), 30% hard (ambiguous, complement, homograph, 5+ tabs).
3. **Varied phrasing**: mix `close all X`, `close every X`, `get rid of X stuff`, `X ones`, `the X one` (singular), `X and Y` union.
4. **Balanced intents**: don't make everything group_tabs — use close/bookmark/pin/mute/reload roughly equally.
5. **No duplicate commands** (normalized lowercase compare).
6. **Zero-match must be truly zero** — verify no tab title/url/tag contains the term.

## EXAMPLES (good varied cases)

```json
{"id":"GS-001","command":"group all amazon tabs","expectedIntent":"group_tabs","expectedTabIds":[1,2,3,4],"mustNotSelect":[6,10],"requiresConfirmation":false,"expectAmbiguous":false,"bucket":"domain-brand","notes":"hostname match only — reseller article excluded"}
{"id":"GS-002","command":"cloes alll amzon tabs pls","expectedIntent":"group_tabs","expectedTabIds":[1,2,3,4],"mustNotSelect":[10],"requiresConfirmation":false,"expectAmbiguous":false,"bucket":"imperfect-english","notes":"triple typo"}
{"id":"GS-003","command":"close all tabs except the google docs ones","expectedIntent":"close_tabs","expectedTabIds":[1,2,3,4,5,6,7,8,9,10,11,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,49,50,51,52],"mustNotSelect":[12,13],"requiresConfirmation":true,"expectAmbiguous":false,"bucket":"exception-negation","notes":"complement — Gmail not a doc, closes"}
{"id":"GS-004","command":"close tabs from yesterday","expectedIntent":"close_tabs","expectedTabIds":[13,16,22,25,26],"mustNotSelect":[],"requiresConfirmation":true,"expectAmbiguous":false,"bucket":"temporal","notes":"anchored to 2026-08-23; yesterday = those lastAccessed"}
```

## DELIVER

Output ONLY the JSONL lines (no markdown, no explanation). 112-140 lines. Ensure per-bucket count table sums correctly.

---
END PROMPT
