// tests/clarify.test.js
// Phase 0 gate for the interpretation-level clarification loop (V2-3).
//
// What this proves, offline, with no chrome / no Ollama / no NLI model:
//   1. LEXICON HITS  -- concept and domain tokens hit POLYSEMY_LEXICON and the
//      parse carries query.senses; unrelated tokens carry none; old parses
//      gain senses idempotently (cache-hit shape).
//   2. SPLIT TEST    -- pure senseSplitTest logic over mock pool scores:
//      one-matching-sense is inert, wide margin is inert, near-tie fires,
//      destructive intent fires even on a wide-but-both-matching split.
//   3. OPTION CAP    -- never more than 3 options are presented.
//   4. NO-LOOP       -- maybeClarify with resolved:true (the clarify-chosen
//      re-entry) never re-attaches plan.clarify, so one command clarifies at
//      most once; an inert plan is returned untouched.
//
//   node tests/clarify.test.js

global.self = global;

const path = require('path');
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const CommandAgent = require(path.join(__dirname, '..', 'command-agent.js'));

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  <' + JSON.stringify(extra) + '>' : '')); }
}

// ---------------------------------------------------------------------------
// 1. LEXICON HITS
// ---------------------------------------------------------------------------

const qAmazon = { concepts: ['amazon product pages'], domains: ['amazon.com'] };
LlmQuery.reconcile('close amazon product pages', qAmazon);
ok('amazon concept token -> 2 senses', Array.isArray(qAmazon.senses) && qAmazon.senses.length === 2, qAmazon.senses);
ok('amazon sense 0 is the company', qAmazon.senses[0].label.includes('company'), qAmazon.senses[0]);
ok('amazon sense 1 is the river', qAmazon.senses[1].label.includes('river'), qAmazon.senses[1]);
ok('senses carry NLI-entailable concepts', qAmazon.senses.every(s => typeof s.concept === 'string' && s.concept.length > 3));

const qDom = { concepts: [], domains: ['amazon.in'] };
LlmQuery.reconcile('close amazon.in shopping tabs', qDom);
ok('domain label token -> senses', Array.isArray(qDom.senses) && qDom.senses.length === 2);

const qGo = { concepts: ['go'], domains: [] };
LlmQuery.reconcile('group my go tabs', qGo);
ok('go -> language + board game', Array.isArray(qGo.senses) && qGo.senses.length === 2 &&
  qGo.senses[0].label.includes('language') && qGo.senses[1].label.includes('game'), qGo.senses);

const qRust = { concepts: ['rust'], domains: [] };
LlmQuery.reconcile('close tabs about rust', qRust);
ok('rust -> language + oxidation', Array.isArray(qRust.senses) && qRust.senses.length === 2);

const qPhx = { concepts: ['phoenix'], domains: [] };
LlmQuery.reconcile('close phoenix tabs', qPhx);
ok('phoenix -> 3 senses (bird/city/framework)', Array.isArray(qPhx.senses) && qPhx.senses.length === 3);

const qNone = { concepts: ['cricket'], domains: [] };
LlmQuery.reconcile('close cricket tabs', qNone);
ok('unambiguous token -> no senses', qNone.senses === undefined);

// Whole-word discipline: "goose" must not hit the 'go' entry.
const qGoose = { concepts: ['goose hunting'], domains: [] };
LlmQuery.reconcile('close goose hunting tabs', qGoose);
ok('substring token does not hit (goose != go)', qGoose.senses === undefined);

// Idempotence / cache shape: a query that already carries senses is untouched.
const qCache = { concepts: ['amazon'], domains: [], senses: [{ label: 'preset', concept: 'preset' }] };
LlmQuery.reconcile('close amazon tabs', qCache);
ok('existing senses array is never rewritten', qCache.senses.length === 1 && qCache.senses[0].label === 'preset');

// Full lexicon coverage per spec.
const SPEC_TOKENS = ['apple', 'jaguar', 'eclipse', 'mercury', 'amazon', 'phoenix', 'go', 'rust', 'swift', 'anchor'];
for (const t of SPEC_TOKENS) {
  const entry = LlmQuery.POLYSEMY_LEXICON.find(e => e.token === t);
  ok(`lexicon entry: ${t}`, !!entry && entry.senses.length >= 2);
}
ok('python deliberately absent (handled elsewhere)', !LlmQuery.POLYSEMY_LEXICON.some(e => e.token === 'python'));

// ---------------------------------------------------------------------------
// 2. SPLIT TEST (mock pools)
// ---------------------------------------------------------------------------

const ST = CommandAgent.senseSplitTest;
ok('single matching sense -> inert',
  ST([{ matchCount: 9, topConf: 0.9 }, { matchCount: 0, topConf: 0 }], { destructive: true }).required === false);
ok('both zero -> inert',
  ST([{ matchCount: 0, topConf: 0 }, { matchCount: 0, topConf: 0 }], { destructive: true }).required === false);
ok('wide margin, non-destructive -> inert',
  ST([{ matchCount: 9, topConf: 0.9 }, { matchCount: 2, topConf: 0.8 }], { destructive: false }).required === false);
ok('near tie (1 vs 1) -> required',
  ST([{ matchCount: 1, topConf: 0.9 }, { matchCount: 1, topConf: 0.8 }], { destructive: false }).required === true);
ok('margin exactly 0.1 (10 vs 9) is NOT < 0.1 -> inert',
  ST([{ matchCount: 10, topConf: 0.9 }, { matchCount: 9, topConf: 0.8 }], { destructive: false }).required === false);
ok('near tie fires only under 0.1: 11 vs 10 (margin 0.0909) -> required',
  ST([{ matchCount: 11, topConf: 0.9 }, { matchCount: 10, topConf: 0.8 }], { destructive: false }).required === true);
ok('10 vs 2 (margin 0.8) -> inert',
  ST([{ matchCount: 10, topConf: 0.9 }, { matchCount: 2, topConf: 0.8 }], { destructive: false }).required === false);
ok('wide margin, destructive -> required',
  ST([{ matchCount: 9, topConf: 0.9 }, { matchCount: 2, topConf: 0.8 }], { destructive: true }).required === true);
ok('3-way split ranks by matchCount then topConf',
  ST([{ matchCount: 2, topConf: 0.9 }, { matchCount: 5, topConf: 0.5 }, { matchCount: 5, topConf: 0.9 }], { destructive: false }).ranked[0].matchCount === 5);

// Dual-intent detector: genuine verb conflicts stay, noun/participle noise dies.
ok('"close or group these" stays ambiguous', CommandAgent.isAmbiguousIntent('close or group these') === true);
ok('"unpin and close the old tabs" stays ambiguous', CommandAgent.isAmbiguousIntent('unpin and close the old tabs') === true);
ok('"group my cricket tabs" not ambiguous', CommandAgent.isAmbiguousIntent('group my cricket tabs') === false);
ok('temporal qualifier "tabs opened in the last hour" not ambiguous',
  CommandAgent.isAmbiguousIntent('close tabs opened in the last hour') === false);
ok('state noun "in the dev group" not ambiguous',
  CommandAgent.isAmbiguousIntent('close all tabs in the dev group') === false);
ok('state adjective "close my pinned tabs" not ambiguous',
  CommandAgent.isAmbiguousIntent('close my pinned tabs') === false);
ok('topic noun "google search tabs" not ambiguous',
  CommandAgent.isAmbiguousIntent('close all google search tabs') === false);
ok('topic noun "refresh tokens" not ambiguous',
  CommandAgent.isAmbiguousIntent('close pages mentioning refresh tokens') === false);
ok('detectIntent order untouched (close wins over opened)',
  CommandAgent.detectIntent('close tabs opened in the last hour') === 'close_tabs');

// ---------------------------------------------------------------------------
// 3. OPTION CAP (mock scorer, no NLI)
// ---------------------------------------------------------------------------

// A polysemous pool where every sense matches >=1 tab with a near-tie forces
// the modal path; the option list must cap at 3 even for 3-sense tokens, and
// generateInterpretations must cap at 3.
(async () => {
  const mockScorer = async () => ({ matchCount: 2, topConf: 0.9, tabIds: [1, 2], perTab: { 1: 'x', 2: 'y' } });
  const fakeCandidates = [{ tabId: 1, title: 'a' }, { tabId: 2, title: 'b' }];
  const plan = { intent: 'close_tabs', tabIds: [1, 2], uncertain: [], destructive: true, path: 'semantic' };
  const ctx = { command: 'close phoenix tabs', windowId: 1, scorer: mockScorer };
  // maybeClarify consults self.LlmQuery for the parse; inject a canned
  // command-aware query so the split test is the firing trigger and other
  // commands stay inert.
  self.LlmQuery = { parse: async (cmd) => String(cmd || '').includes('phoenix')
    ? { intent: 'close_tabs', concepts: ['phoenix'], domains: [], confidence: 0.9, senses: [
        { label: 'phoenix — the bird', concept: 'phoenix bird mythology' },
        { label: 'phoenix — the city', concept: 'phoenix city arizona' },
        { label: 'phoenix — the web framework', concept: 'phoenix web framework elixir' }] }
    : { intent: 'group_tabs', concepts: ['cricket'], domains: [], confidence: 0.9 } };
  // maybeClarify re-derives candidates via retrieveCandidates (a self fn);
  // stub it for the test.
  self.retrieveCandidates = async () => fakeCandidates;
  const clarified = await CommandAgent.maybeClarify(plan, ctx);
  ok('3-sense split fires clarify', !!(clarified && clarified.clarify));
  ok('option cap: at most 3 options', clarified.clarify.options.length <= 3, clarified.clarify.options.length);
  ok('options carry label + matchCount + executable plan',
    clarified.clarify.options.every(o => typeof o.label === 'string' && Number.isInteger(o.matchCount) && o.plan && Array.isArray(o.plan.tabIds)));

  const interps = LlmQuery.generateInterpretations('group those tabs about planning', 3);
  ok('generateInterpretations caps at 3', interps.length <= 3, interps.length);
  ok('generateInterpretations caps at n=1', LlmQuery.generateInterpretations('close those tabs', 1).length === 1);
  ok('interpretations are executable slot-sets',
    interps.every(i => i.query && typeof i.query.intent === 'string' && Array.isArray(i.query.concepts) && typeof i.query.selectAll === 'boolean'));

  // 4. NO-LOOP: the clarify-resolved re-entry (background's CLARIFY_CHOSEN
  // path) never re-attaches .clarify, and a plan that already carries
  // .clarify is passed through untouched.
  const reentry = await CommandAgent.maybeClarify(clarified.clarify.options[0].plan, { ...ctx, resolved: true });
  ok('clarify-resolved re-entry never re-fires', !(reentry && reentry.clarify));
  const secondCall = await CommandAgent.maybeClarify(clarified, ctx);
  ok('plan already carrying .clarify is not rebuilt', secondCall.clarify.options.length === clarified.clarify.options.length);

  // Inert outcome: plan returned untouched (no re-selection, no clarify).
  const inertPlan = { intent: 'group_tabs', tabIds: [7, 8], uncertain: [], destructive: false, path: 'semantic' };
  const inert = await CommandAgent.maybeClarify(inertPlan, { command: 'close cricket tabs', windowId: 1, scorer: mockScorer });
  ok('unambiguous command -> plan untouched', inert === inertPlan && !inert.clarify);

  console.log(fail === 0 ? `\nPASS  (${pass} passed, ${fail} failed)` : `\nFAILED (${fail} failed, ${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
