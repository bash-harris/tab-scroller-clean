# Prompt: generate 75–100 tab-command test cases

Paste everything below the line into another model. It is self-contained.

---

You are building a benchmark for a Chrome extension that selects browser tabs from
a natural-language command. I need **85 test cases** in JSONL format.

## Output format

One JSON object per line. No prose, no markdown fences, no trailing commas.
Every line must be independently parseable by `JSON.parse`.

```
{"command":"close my cricket tabs","expectedIntent":"close_tabs","expectedTabIds":[1,2,4,8],"mustNotSelect":[7],"requiresConfirmation":true,"notes":"tab 7 is football and must not match cricket"}
```

### Fields

| field | type | meaning |
|---|---|---|
| `command` | string | what the user types |
| `expectedIntent` | enum | one of: `close_tabs`, `group_tabs`, `bookmark_tabs`, `pin_tabs`, `unpin_tabs`, `mute_tabs`, `unmute_tabs`, `reload_tabs`, `sort_tabs`, `search_and_switch` |
| `expectedTabIds` | int[] | **exactly** the tabs that should be selected. `[]` is a valid, expected answer |
| `mustNotSelect` | int[] | tabs that would be a *serious* error — near-misses, not every unrelated tab |
| `requiresConfirmation` | bool | `true` iff `expectedIntent` is `close_tabs` |
| `expectAmbiguous` | bool | optional; `true` when the command names two valid intents |
| `notes` | string | one line on what the case tests and why the answer is what it is |

## The tab pool

Every `expectedTabIds` refers to these 15 tabs. **Do not invent tabs.**

```json
[
 {"id":1,"url":"https://www.espncricinfo.com/series/ind-vs-aus-2026/3rd-test/live","title":"India vs Australia, 3rd Test","category":"sports","tags":["cricket","test-match"]},
 {"id":2,"url":"https://www.youtube.com/watch?v=cricket-highlights-2026","title":"Cricket World Cup Highlights: Best Sixes","category":"sports","tags":["cricket","video"]},
 {"id":3,"url":"https://www.bbc.com/sport/football/tables","title":"Premier League Table, Week 12","category":"sports","tags":["football","soccer"]},
 {"id":4,"url":"https://www.iplt20.com/auction/2026","title":"IPL Auction 2026: Full Player List","category":"sports","tags":["cricket","ipl"]},
 {"id":5,"url":"https://forums.keebtalk-example.com/t/best-budget-mechanical-keyboards-2026","title":"Best Budget Mechanical Keyboards 2026","category":"technology","tags":["keyboards","hardware"]},
 {"id":6,"url":"https://creatorhub-example.com/guides/how-to-add-closed-captions","title":"How to Add Closed Captions to Your Videos","category":"technology","tags":["captions","video-editing"]},
 {"id":7,"url":"https://www.fifa.com/worldcup/qualifiers/standings","title":"World Cup Qualifiers: Group Standings","category":"sports","tags":["football","soccer"]},
 {"id":8,"url":"https://www.cricketreport-example.com/day3-old-trafford-report","title":"England v Australia: Day 3 Report, Old Trafford","category":"sports","tags":["test-match","england"]},
 {"id":9,"url":"https://www.bloomberg.com/news/central-bank-rate-pause","title":"Central Bank Signals Possible Rate Pause","category":"finance","tags":["finance","economy"]},
 {"id":10,"url":"https://www.foodnetwork.com/recipes/easy-weeknight-pasta","title":"Easy Weeknight Pasta Recipes","category":"food","tags":["recipe","pasta"]},
 {"id":11,"url":"https://www.travelblog-example.com/thailand-hidden-beaches","title":"Top 10 Hidden Beaches in Thailand","category":"travel","tags":["travel","beaches"]},
 {"id":12,"url":"https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrSt/edit","title":"Q3 Team Roadmap","category":"work","tags":["docs","planning"]},
 {"id":13,"url":"https://docs.google.com/document/d/2XyZaBcDeFgHiJkLmNoP/edit","title":"Sprint Planning Notes","category":"work","tags":["docs","planning"]},
 {"id":14,"url":"https://www.youtube.com/watch?v=funny-cat-compilation","title":"Funny Cat Compilation","category":"entertainment","tags":["video","cats"]},
 {"id":15,"url":"https://www.energynews-example.com/solar-farm-nevada-desert","title":"Solar Farm Doubles Capacity in Nevada Desert","category":"science","tags":["solar","renewable"]}
]
```

Facts about this pool that the labels must respect:
- Tabs **1, 2, 4, 8** are cricket. Tab 8 is an Ashes Test — cricket, despite the
  title containing no literal "cricket".
- Tabs **3, 7** are football/soccer. Football is **not** cricket.
- Tab **2** is on youtube.com *and* is cricket — it is simultaneously sports and
  entertainment. A command for either topic should find it.
- Tabs **12, 13** are both on `docs.google.com`, so they match `google.com`.
- Tab **6** contains the word "closed" as an adjective ("closed captions"), not
  the verb "close".
- Tab **9** is central-bank/rates finance. It is **not** crypto.

## Distribution — aim for roughly this mix

| # | class | what it probes |
|---|---|---|
| 12 | plain topical | "close my cricket tabs" |
| 8 | domain-scoped | "close all youtube.com tabs" — exact host filter, not a topic |
| 8 | **empty expected** | topic with no matching tab; `expectedTabIds: []` |
| 8 | world knowledge | "the Ashes", "clean power" — no literal word overlap |
| 8 | typos | "clsoe my crickt tabs" |
| 8 | negation | "don't close my docs, just group them" |
| 6 | verb-as-noun | "stock market **close**", "**closed** captions" — the topic word collides with a verb |
| 6 | un-prefixed verbs | unpin vs pin, unmute vs mute |
| 6 | select-all | "reload everything" — all 15 ids |
| 6 | ambiguous | names two intents; set `expectAmbiguous: true` |
| 5 | no verb | "my cricket tabs" → `search_and_switch` (least destructive default) |
| 4 | multi-label | tabs belonging to two categories at once |

## Rules

1. **`[]` is a real answer.** Roughly 8 cases must expect zero tabs. A system that
   always returns something is broken, and only empty-expectation cases catch it.
2. **Ambiguity in the command, not the label.** If you cannot state one defensible
   correct answer, rewrite the command. Every label must be justifiable from the
   pool data above.
3. **No contradictions across cases.** If one case treats tab 8 as cricket, every
   case must. Before emitting, re-read your own lines and check that any given tab
   is labelled consistently everywhere it appears.
4. **`mustNotSelect` is for near-misses.** For a cricket command list football
   (`[7]`) — a plausible confusion. Do not list the pasta recipe.
5. **Vary phrasing.** Include terse ("cricket tabs"), polite ("could you please
   close…"), and imperative forms. Vary word order. Do not use one template.
6. **Typo cases must stay recoverable** — one or two transposed characters
   (`crickt`, `tehc`), not unrecognisable strings.
7. `requiresConfirmation` is `true` **iff** the intent is `close_tabs`.

## Before you answer

Check each line: valid JSON; every id in 1–15; intent in the enum; the answer
follows from the pool; no contradiction with your other lines. Then output the 85
lines and nothing else.
