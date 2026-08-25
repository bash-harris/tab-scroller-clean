// bench/synth-gen.js
// Round 5: SYNTHETIC benchmark generation at scale, labels correct-by-construction.
//
// Reads the FROZEN golden pool from bench/golden-set.jsonl, builds ~100
// deterministic template instances from pure pool metadata (never from
// existing benchmark strings), paraphrases a subset via local Ollama qwen2.5,
// validates every case mechanically, dedupes against the three curated
// benches, and writes bench/synth-v1.jsonl.
//
//   node bench/synth-gen.js

'use strict';
const fs = require('fs');
const path = require('path');

const GOLDEN = path.join(__dirname, 'golden-set.jsonl');
const OUT = path.join(__dirname, 'synth-v1.jsonl');
const SEED = 42;
const INTERNAL_IDS = new Set([47, 48]);
const TARGET_TOTAL = 180;
const PARALLEL = 4;
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5';
const PARAPHRASE_SYSTEM =
  'Rewrite this browser-tab command in a different natural phrasing. ' +
  'Keep EXACTLY the same meaning and targets. Reply with only the rewritten command.';

const T0 = Date.now();

// ---- seeded RNG -------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- load frozen pool -------------------------------------------------------
const goldenRecs = fs.readFileSync(GOLDEN, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
const metaIn = goldenRecs.find((r) => r._meta)._meta;
const pool = goldenRecs.find((r) => r._tabPool)._tabPool;
const BENCH_NOW = metaIn.benchNow;
const NOW_MS = Date.parse(BENCH_NOW);
const selectable = pool.filter((t) => !INTERNAL_IDS.has(t.id));
const byId = new Map(pool.map((t) => [t.id, t]));

const DAY = 86400000, MIN = 60000;
const hostOf = (t) => String(t.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
const dayOf = (iso) => Math.floor(Date.parse(iso) / DAY);

// ---- attribute inventory (computed from pool metadata ONLY) -----------------
function brandGroups() {
  const defs = [
    ['amazon', (t) => /amazon\./.test(hostOf(t))],
    ['youtube', (t) => /youtube\.com$/.test(hostOf(t))],
    ['google docs', (t) => hostOf(t) === 'docs.google.com'],
    ['gmail', (t) => hostOf(t) === 'mail.google.com'],
    ['github', (t) => /(^|\.)github\.com$/.test(hostOf(t))],
    ['espncricinfo', (t) => hostOf(t) === 'espncricinfo.com'],
    ['reddit', (t) => hostOf(t) === 'reddit.com'],
    ['notion', (t) => hostOf(t) === 'notion.so'],
    ['prime video', (t) => hostOf(t) === 'primevideo.com'],
    ['flipkart', (t) => hostOf(t) === 'flipkart.com'],
    ['ebay', (t) => hostOf(t) === 'ebay.com'],
  ];
  const out = [];
  for (const [word, test] of defs) {
    const ids = selectable.filter(test).map((t) => t.id);
    if (!ids.length) continue;
    // near-misses: brand word in title/url-path but different host
    const near = selectable
      .filter((t) => !test(t))
      .filter((t) => new RegExp(word.replace(' ', '\\s*'), 'i').test(`${t.title} ${t.url}`))
      .map((t) => t.id);
    out.push({ kind: 'brand', word, ids, near });
  }
  return out;
}

function categoryGroups() {
  const m = new Map();
  for (const t of selectable) {
    if (!m.has(t.category)) m.set(t.category, []);
    m.get(t.category).push(t.id);
  }
  return [...m.entries()]
    .filter(([, ids]) => ids.length >= 2 && ids.length <= 12)
    .map(([word, ids]) => ({ kind: 'category', word, ids, near: [] }));
}

function tagGroups() {
  const m = new Map();
  for (const t of selectable) {
    for (const tag of t.tags || []) {
      if (!m.has(tag)) m.set(tag, []);
      m.get(tag).push(t.id);
    }
  }
  return [...m.entries()]
    .filter(([, ids]) => ids.length >= 2 && ids.length <= 8)
    .map(([word, ids]) => ({ kind: 'tag', word, ids, near: [] }));
}

function stateGroups() {
  return [
    { kind: 'state', word: 'pinned', ids: selectable.filter((t) => t.pinned).map((t) => t.id), near: [] },
    { kind: 'state', word: 'audible', ids: selectable.filter((t) => t.audible).map((t) => t.id), near: [],
      phrase: 'playing sound' },
    { kind: 'state', word: 'muted', ids: selectable.filter((t) => t.muted).map((t) => t.id), near: [] },
  ].filter((g) => g.ids.length >= 2);
}

function temporalBuckets() {
  const out = [];
  const yest = dayOf(BENCH_NOW) - 1;
  const todayAcc = selectable.filter((t) => dayOf(t.lastAccessed) === dayOf(BENCH_NOW)).map((t) => t.id);
  const yestAcc = selectable.filter((t) => dayOf(t.lastAccessed) === yest).map((t) => t.id);
  const todayOp = selectable.filter((t) => dayOf(t.openedAt) === dayOf(BENCH_NOW)).map((t) => t.id);
  const yestOp = selectable.filter((t) => dayOf(t.openedAt) === yest).map((t) => t.id);
  const oldTwoWeeks = selectable.filter((t) => NOW_MS - Date.parse(t.openedAt) > 14 * DAY).map((t) => t.id);
  const lastHour = selectable.filter((t) => NOW_MS - Date.parse(t.lastAccessed) <= 60 * MIN).map((t) => t.id);
  if (todayAcc.length) out.push({ kind: 'temporal', key: 'accessed-today', phrase: 'accessed today', field: 'lastAccessed', ids: todayAcc });
  if (yestAcc.length) out.push({ kind: 'temporal', key: 'accessed-yesterday', phrase: 'I accessed yesterday', field: 'lastAccessed', ids: yestAcc });
  if (todayOp.length) out.push({ kind: 'temporal', key: 'opened-today', phrase: 'opened today', field: 'openedAt', ids: todayOp });
  if (yestOp.length) out.push({ kind: 'temporal', key: 'opened-yesterday', phrase: 'opened yesterday', field: 'openedAt', ids: yestOp });
  if (oldTwoWeeks.length) out.push({ kind: 'temporal', key: 'opened-old', phrase: 'opened more than two weeks ago', field: 'openedAt', ids: oldTwoWeeks });
  if (lastHour.length) out.push({ kind: 'temporal', key: 'accessed-last-hour', phrase: 'accessed in the last hour', field: 'lastAccessed', ids: lastHour });
  return out;
}

function duplicatePair() {
  const byUrl = new Map();
  for (const t of selectable) {
    if (!byUrl.has(t.url)) byUrl.set(t.url, []);
    byUrl.get(t.url).push(t);
  }
  const out = [];
  for (const [, group] of byUrl) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
    const dupIds = sorted.slice(1).map((t) => t.id); // keep original, close later copies
    out.push({ kind: 'duplicate', ids: dupIds, desc: sorted[0].title.slice(0, 40) });
  }
  return out;
}

function literalTokens() {
  const STOP = new Set(['with', 'your', 'from', 'this', 'that', 'have', 'what', 'when', 'best', 'how',
    'the', 'and', 'for', 'you', 'top', 'new', 'tab', 'page', 'sign', 'live', 'vs']);
  const hits = new Map();
  for (const t of selectable) {
    const seen = new Set();
    for (const tok of String(t.title).toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length < 4 || STOP.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      if (!hits.has(tok)) hits.set(tok, []);
      hits.get(tok).push(t.id);
    }
  }
  const cands = [...hits.entries()].filter(([, ids]) => ids.length >= 1 && ids.length <= 2);
  const wanted = ['roadmap', 'lofi', 'dotfiles', 'bangkok', 'cookies', 'redzone', 'ashes'];
  const found = [];
  for (const w of wanted) {
    if (hits.has(w)) found.push({ kind: 'literal', token: w, ids: hits.get(w).slice().sort((a, b) => a - b) });
  }
  // top up deterministically from candidates if wanted tokens were sparse
  for (const [tok, ids] of shuffled(cands)) {
    if (found.length >= 10) break;
    if (found.some((f) => f.token === tok)) continue;
    found.push({ kind: 'literal', token: tok, ids: ids.slice().sort((a, b) => a - b) });
  }
  return found;
}

const ABSENT_TOPICS = [
  'knitting', 'linkedin', 'netflix', 'poker', 'quantum computing', 'fantasy football',
  'spotify', 'instagram', 'wikipedia', 'discord', 'sushi recipes', 'mortgage calculator',
];

// ---- template families ------------------------------------------------------
// Each factory pushes instances: {family, command, intent, ids, mustNot, confirm}
const instances = [];
function add(family, command, intent, ids, opts = {}) {
  instances.push({
    family,
    command,
    intent,
    ids: [...new Set(ids)].sort((a, b) => a - b),
    mustNot: [...new Set(opts.mustNot || [])].sort((a, b) => a - b),
    confirm: opts.confirm != null ? opts.confirm : intent === 'close_tabs',
  });
}

const CLOSE_VARIANTS = [(w) => `close all ${w} tabs`, (w) => `close every ${w} tab`, (w) => `shut down all my ${w} tabs`];
const GROUP_VARIANTS = [(w) => `group my ${w} tabs`, (w) => `put all the ${w} tabs in a group`, (w) => `gather my ${w} tabs together`];
const ACTION_ROTATION = [
  ['group_tabs', (w) => `group my ${w} tabs`],
  ['pin_tabs', (w) => `pin all the ${w} tabs`],
  ['mute_tabs', (w) => `mute every ${w} tab`],
  ['reload_tabs', (w) => `reload all my ${w} tabs`],
  ['bookmark_tabs', (w) => `bookmark the ${w} tabs`],
  ['sort_tabs', (w) => `sort my ${w} tabs alphabetically`],
];

function famHostScope(brands) {
  const multi = brands.filter((b) => b.ids.length >= 2);
  multi.forEach((b, i) => {
    add('host-scope', CLOSE_VARIANTS[i % CLOSE_VARIANTS.length](b.word), 'close_tabs', b.ids,
      { mustNot: b.near, confirm: true });
  });
  multi.forEach((b, i) => {
    const [intent, fmt] = ACTION_ROTATION[i % ACTION_ROTATION.length];
    add('host-action', fmt(b.word), intent, b.ids, { mustNot: b.near, confirm: false });
  });
}

function famTopicCategory(cats) {
  const verbs = [['group_tabs', (w) => `group all my ${w} tabs`],
    ['close_tabs', (w) => `get rid of the ${w} tabs`],
    ['bookmark_tabs', (w) => `bookmark my ${w} pages`],
    ['reload_tabs', (w) => `refresh every ${w} tab`]];
  cats.slice(0, 10).forEach((c, i) => {
    const [intent, fmt] = verbs[i % verbs.length];
    add('topic-category', fmt(c.word), intent, c.ids, { confirm: intent === 'close_tabs' });
  });
}

function famTopicTag(tags) {
  const chosen = shuffled(tags).slice(0, 10);
  chosen.forEach((g, i) => {
    const [intent, fmt] = ACTION_ROTATION[(i + 2) % ACTION_ROTATION.length];
    add('topic-tag', fmt(`${g.word}`), intent, g.ids, { confirm: false });
  });
}

function famActionState(states) {
  const [pinned, audible, muted] = states;
  const combos = [
    ['gather my pinned tabs into a group', 'group_tabs', pinned.ids, false],
    ['close the tabs that are muted', 'close_tabs', muted.ids, true],
    ['silence the tabs that are playing sound', 'mute_tabs', audible.ids, false],
    ['unmute my muted tabs', 'unmute_tabs', muted.ids, false],
    ['strip the pins off every pinned tab', 'unpin_tabs', pinned.ids, false],
    ['reload the tabs that are playing audio', 'reload_tabs', audible.ids, false],
    ['bookmark my currently pinned tabs', 'bookmark_tabs', pinned.ids, false],
    ['sort the muted tabs by domain', 'sort_tabs', muted.ids, false],
  ];
  combos.forEach(([cmd, intent, ids, confirm]) => add('window-state', cmd, intent, ids, { confirm }));
}

function famNegationComplement(groups) {
  // exception sets kept small (<=5) by construction
  const pool_ = groups.filter((g) => g.ids.length >= 1 && g.ids.length <= 5);
  const chosen = shuffled(pool_).slice(0, 10);
  chosen.forEach((g, i) => {
    const w = g.kind === 'state' && g.phrase ? g.phrase : `${g.word} `;
    if (i % 3 === 0) {
      add('negation-complement', `close all tabs except the ${g.word} ones`, 'close_tabs',
        selectable.map((t) => t.id).filter((id) => !g.ids.includes(id)),
        { mustNot: g.ids, confirm: true });
    } else if (i % 3 === 1) {
      add('negation-complement', `mute every tab except the ${g.word} ones`, 'mute_tabs',
        selectable.map((t) => t.id).filter((id) => !g.ids.includes(id)),
        { mustNot: g.ids, confirm: false });
    } else {
      add('negation-complement', `keep only the ${w.trim()} tabs open, close the others`, 'close_tabs',
        selectable.map((t) => t.id).filter((id) => !g.ids.includes(id)),
        { mustNot: g.ids, confirm: true });
    }
  });
}

function famTemporal(buckets) {
  buckets.forEach((b, i) => {
    const verb = [['reload_tabs', (p) => `reload the tabs ${p}`],
      ['close_tabs', (p) => `close the tabs ${p}`],
      ['group_tabs', (p) => `group the tabs ${p}`],
      ['bookmark_tabs', (p) => `bookmark the tabs ${p}`],
      ['mute_tabs', (p) => `mute the tabs ${p}`]][i % 5];
    add('temporal-window', verb[1](b.phrase), verb[0], b.ids, { confirm: verb[0] === 'close_tabs' });
  });
}

function famLiteralMeta(tokens) {
  const plans = [
    ['search_and_switch', (tok) => `find the page with '${tok}' in the title`, false],
    ['close_tabs', (tok) => `close the tab titled containing '${tok}'`, true],
    ['bookmark_tabs', (tok) => `bookmark the tabs titled containing '${tok}'`, false],
    ['mute_tabs', (tok) => `mute the tab titled containing '${tok}'`, false],
    ['pin_tabs', (tok) => `pin the tab titled containing '${tok}'`, false],
    ['reload_tabs', (tok) => `reload the tab titled containing '${tok}'`, false],
    ['group_tabs', (tok) => `group the tabs titled containing '${tok}'`, false],
    ['bookmark_tabs', (tok) => `save the tabs with '${tok}' somewhere in the title`, false],
  ];
  tokens.slice(0, plans.length).forEach((tk, i) => {
    const [intent, fmt, confirm] = plans[i];
    add('literal-meta', fmt(tk.token), intent, tk.ids, { confirm });
  });
}

function famNegativeAbsent() {
  ABSENT_TOPICS.forEach((topic, i) => {
    const verbs = [
      ['close_tabs', (t) => `close my ${t} tabs`],
      ['group_tabs', (t) => `group my ${t} tabs`],
      ['pin_tabs', (t) => `pin my ${t} tabs`],
      ['mute_tabs', (t) => `mute the ${t} tabs`],
      ['bookmark_tabs', (t) => `bookmark my ${t} tabs`],
      ['reload_tabs', (t) => `reload my ${t} tabs`],
    ];
    const [intent, fmt] = verbs[i % verbs.length];
    add('negative-absent', fmt(topic), intent, [], { confirm: intent === 'close_tabs' });
  });
}

function famDuplicate(dups) {
  dups.slice(0, 2).forEach((d, i) => {
    if (i === 0) add('duplicate-pair', 'close the duplicated tabs', 'close_tabs', d.ids, { confirm: true });
    else add('duplicate-pair', 'find and close the extra copy of the repeated tab', 'close_tabs', d.ids, { confirm: true });
  });
}

// ---- build ------------------------------------------------------------------
const brands = brandGroups();
const cats = categoryGroups();
const tags = tagGroups();
const states = stateGroups();
const temporals = temporalBuckets();
const dups = duplicatePair();
const literals = literalTokens();

famHostScope(brands);
famTopicCategory(cats);
famTopicTag(tags);
famActionState(states);
famNegationComplement([...cats, ...tags, ...states]);
famTemporal(temporals);
famLiteralMeta(literals);
famNegativeAbsent();
famDuplicate(dups);

// ---- dedupe against curated benches ----------------------------------------
function normCmd(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const curatedFiles = ['golden-set.jsonl', 'golden-set-v2.jsonl', 'open-bookmark-bench.jsonl'];
const seenNormalized = new Set();
for (const f of curatedFiles) {
  try {
    const recs = fs.readFileSync(path.join(__dirname, f), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    for (const r of recs) if (r.command) seenNormalized.add(normCmd(r.command));
  } catch (_) { /* missing curated file: nothing to dedupe against from it */ }
}

// ---- mechanical validation (adapted from validate-golden.js + gold-audit.js)
const INTENTS = new Set([
  'close_tabs', 'group_tabs', 'group_multi', 'bookmark_tabs', 'pin_tabs', 'unpin_tabs',
  'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs', 'retrieve_open', 'open_tabs',
  'search_and_switch', 'clarify',
]);
const dropped = [];
function drop(case_, why) {
  dropped.push(`[${case_.family}] "${case_.command}" -> ${why}`);
}
function validateCase(c) {
  const errs = [];
  for (const id of c.ids) {
    if (!byId.has(id)) errs.push(`id ${id} not in pool`);
    if (INTERNAL_IDS.has(id)) errs.push(`internal tab ${id} selected`);
  }
  for (const id of c.mustNot) {
    if (!byId.has(id)) errs.push(`mustNot id ${id} not in pool`);
  }
  const inter = c.ids.filter((id) => c.mustNot.includes(id));
  if (inter.length) errs.push(`expected∩mustNot = [${inter}]`);
  if (!INTENTS.has(c.intent)) errs.push(`unknown intent ${c.intent}`);
  if (c.intent === 'clarify' && c.ids.length) errs.push('clarify with non-empty selection');
  if (c.expectAmbiguous && !c.confirm) errs.push('ambiguous without confirmation');
  if (c.intent === 'close_tabs' && c.ids.length && !c.confirm) errs.push('destructive close without confirmation');

  // --- gold-audit replicas ---
  const cmd = c.command;
  const tsOf = (id, field) => (byId.has(id) ? Date.parse(byId.get(id)[field]) : NaN);
  if (c.ids.length && /yesterday/i.test(cmd)) {
    const field = /opened|open(ed)?\s/i.test(cmd) ? 'openedAt' : 'lastAccessed';
    for (const id of c.ids) {
      const t = tsOf(id, field);
      if (Number.isFinite(t) && Math.floor(t / DAY) !== dayOf(BENCH_NOW) - 1 && !/except/i.test(cmd)) {
        errs.push(`yesterday-window includes ${id} (${field})`);
      }
    }
  }
  if (c.ids.length && /\b(\d+|twenty|thirty|fifteen)\s*minutes?\b/i.test(cmd) && /last|within|past/i.test(cmd)) {
    const m = cmd.match(/(\d+|twenty|thirty|fifteen)\s*minutes?/i);
    const words = { twenty: 20, thirty: 30, fifteen: 15 };
    const mins = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
    for (const id of c.ids) {
      const t = tsOf(id, 'lastAccessed');
      if (Number.isFinite(t) && NOW_MS - t > mins * MIN + 60000) errs.push(`"${mins} minutes" window includes stale ${id}`);
    }
  }
  if (c.ids.length && /(older|more than a month|months)\b/i.test(cmd) && /month/i.test(cmd)) {
    for (const id of c.ids) {
      const t = tsOf(id, 'openedAt');
      if (Number.isFinite(t) && NOW_MS - t < 30 * DAY) errs.push(`">1 month" includes fresh ${id}`);
    }
  }
  // complement-shape heuristic (mirrors gold-audit)
  if (c.mustNot.length > 5 && c.ids.length > 0) {
    const exclPhrase = (cmd.match(/except\s+(?:the\s+)?([a-z\s]{3,30})/i) || [])[1];
    if (exclPhrase) {
      const phrase = exclPhrase.trim();
      const wordEq = (phraseS, token) => {
        if (!token) return false;
        const p = String(phraseS).toLowerCase().split(/\s+/);
        const tS = String(token).toLowerCase();
        return p.includes(tS) && tS.length > 3;
      };
      for (const id of c.ids) {
        const t = byId.get(id);
        if (!t) continue;
        const catHit = wordEq(phrase, t.category) || (t.tags || []).some((tag) => wordEq(phrase, tag));
        const hostHit = wordEq(phrase, hostOf(t));
        if ((catHit || hostHit) && !/\b(not|never|neither|nor)\b/i.test(cmd)) {
          errs.push(`complement acts on ${id} matching exception phrase "${phrase}"`);
        }
      }
    }
  }
  return errs;
}

// ---- assemble valid template cases -----------------------------------------
const validInstances = [];
for (const inst of instances) {
  const errs = validateCase(inst);
  if (errs.length) { drop(inst, errs.join('; ')); continue; }
  validInstances.push(inst);
}

// ---- paraphrase pass (LLM variation, batches of 4) --------------------------
async function ollamaParaphrase(command, seed) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: command,
      system: PARAPHRASE_SYSTEM,
      stream: false,
      keep_alive: '30m',
      options: { temperature: 0.9, seed, num_predict: 80 },
    }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  return String(j.response || '').trim();
}

function sanitizeParaphrase(text, original) {
  let s = text.replace(/^[`"'\s]+|[`"'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 8 || s.length > 200) return null;
  if (/^(here|sure|rewritten|note)/i.test(s)) return null;
  if (normCmd(s) === normCmd(original)) return null;
  return s;
}

async function paraphraseAll(targets) {
  const results = new Array(targets.length).fill(null);
  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i += PARALLEL) {
    const batch = targets.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(
      batch.map((t, k) => ollamaParaphrase(t.command, SEED * 100 + i + k))
    );
    settled.forEach((r, k) => {
      const gi = i + k;
      if (r.status === 'fulfilled') {
        const cleaned = sanitizeParaphrase(r.value, batch[k].command);
        if (cleaned) { results[gi] = cleaned; ok++; } else fail++;
      } else fail++;
    });
  }
  return { results, ok, fail };
}

const targetParaphrases = Math.max(0, TARGET_TOTAL - validInstances.length);
const paraIndices = shuffled(validInstances.map((_, i) => i)).slice(0, targetParaphrases);
const paraTargets = paraIndices.map((i) => validInstances[i]);

async function main() {
console.log(`ollama: paraphrasing ${paraTargets.length}/${validInstances.length} template instances (batches of ${PARALLEL})...`);
let paraResults = { results: paraTargets.map(() => null), ok: 0, fail: 0 };
try {
  paraResults = await paraphraseAll(paraTargets);
} catch (e) {
  console.error(`paraphrase pass aborted: ${e.message}; keeping template-only versions`);
}
console.log(`ollama: ${paraResults.ok} paraphrased, ${paraResults.fail} failed/kept template-only`);

// ---- final case list --------------------------------------------------------
const cases = [];
let nextId = 1;
function pushCase(inst, command, source, templateCommand) {
  const n = normCmd(command);
  if (seenNormalized.has(n)) { drop({ family: inst.family, command }, 'dedupe collision post-paraphrase'); return; }
  const cand = { ...inst, command };
  const errs = validateCase(cand);
  if (errs.length) { drop(cand, errs.join('; ')); return; }
  seenNormalized.add(n);
  const c = {
    id: `SY-${String(nextId++).padStart(4, '0')}`,
    command,
    expectedIntent: inst.intent,
    expectedTabIds: inst.ids,
    mustNotSelect: inst.mustNot,
    requiresConfirmation: inst.confirm,
    expectAmbiguous: false,
    bucket: inst.family,
    source,
  };
  if (templateCommand) c.templateCommand = templateCommand;
  cases.push(c);
}

for (const inst of validInstances) pushCase(inst, inst.command, 'template', null);
paraIndices.forEach((instIdx, k) => {
  const para = paraResults.results[k];
  if (para) pushCase(validInstances[instIdx], para, 'paraphrase', validInstances[instIdx].command);
});

// ---- write output -----------------------------------------------------------
const byFamily = {};
for (const c of cases) byFamily[c.bucket] = (byFamily[c.bucket] || 0) + 1;

const outMeta = {
  _meta: {
    version: '1.0.0',
    created: new Date().toISOString().slice(0, 10),
    provenance: 'synthetic round5',
    purpose: 'Synthetic scale-up of the golden benchmark. Labels are correct-by-construction: '
      + 'commands are generated from frozen-pool metadata via deterministic templates, so '
      + 'expectedTabIds are computed, never guessed. LLM paraphrases preserve template semantics.',
    benchNow: BENCH_NOW,
    generation: {
      seed: SEED,
      templated: validInstances.length,
      paraphrased: paraResults.ok,
      dropped: dropped.length,
      totalCases: cases.length,
      model: OLLAMA_MODEL,
      endpoint: OLLAMA_URL,
      families: byFamily,
      dedupedAgainst: curatedFiles,
    },
  },
};
const poolLine = { _tabPool: pool };
const lines = [JSON.stringify(outMeta), JSON.stringify(poolLine), ...cases.map((c) => JSON.stringify(c))];
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

// ---- report -----------------------------------------------------------------
console.log('\ntemplate families:');
for (const [f, n] of Object.entries(byFamily).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`\ngeneration stats: templated=${validInstances.length} paraphrased=${paraResults.ok} dropped=${dropped.length} totalCases=${cases.length}`);
if (dropped.length) {
  console.log(`\ndropped (${dropped.length}):`);
  dropped.forEach((d) => console.error('  x ' + d));
}
console.log(`\nwrote ${OUT} (${cases.length} cases) in ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
