// tests/group-name.test.js
// Phase 0 / A4 + A4b regression gate.
//
// A4:  background.js built tool args as { tabIds } only, so handleGroupTabs
//      destructured groupName === undefined, passed it to chrome.tabGroups.update,
//      and every group was literally titled "undefined" ("Grouped 5 tabs into
//      \"undefined\"").
// A4b: the intent ladder fix made unpin_tabs / unmute_tabs reachable, but there
//      is NO handler with those names -- handlePinTabs/handleMuteTabs branch on
//      args.action. Without an explicit mapping the new intents dead-end at the
//      dispatcher, so the A3 fix would have looked correct in unit tests and
//      still done nothing in the product.
//
//   node tests/group-name.test.js

global.self = global;

const {
  toolForIntent, deriveGroupName, titleCase
} = require('../command-agent.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}

const card = (tags) => ({ enrichment: { tags: tags.map(t => ({ tag: t, score: 0.9 })) } });

console.log('\n--- A4b: every intent routes to a real handler ---');
// These are the tool names the dispatcher in background.js actually implements.
const REAL_TOOLS = new Set([
  'close_tabs', 'group_tabs', 'bookmark_tabs', 'pin_tabs',
  'mute_tabs', 'reload_tabs', 'sort_tabs', 'search_and_switch'
]);
const ALL_INTENTS = [
  'close_tabs', 'group_tabs', 'bookmark_tabs', 'pin_tabs', 'unpin_tabs',
  'mute_tabs', 'unmute_tabs', 'reload_tabs', 'sort_tabs', 'search_and_switch'
];
for (const intent of ALL_INTENTS) {
  const r = toolForIntent(intent);
  ok(`${intent} -> ${r.tool}`, REAL_TOOLS.has(r.tool), r);
}

console.log('\n--- A4b: inverted intents carry the right action arg ---');
ok('unpin_tabs -> pin_tabs + action unpin',
  toolForIntent('unpin_tabs').tool === 'pin_tabs' &&
  toolForIntent('unpin_tabs').args.action === 'unpin', toolForIntent('unpin_tabs'));
ok('pin_tabs -> pin_tabs + action pin',
  toolForIntent('pin_tabs').args.action === 'pin', toolForIntent('pin_tabs'));
ok('unmute_tabs -> mute_tabs + action unmute',
  toolForIntent('unmute_tabs').tool === 'mute_tabs' &&
  toolForIntent('unmute_tabs').args.action === 'unmute', toolForIntent('unmute_tabs'));
ok('mute_tabs -> mute_tabs + action mute',
  toolForIntent('mute_tabs').args.action === 'mute', toolForIntent('mute_tabs'));
ok('unknown intent falls back to group_tabs',
  toolForIntent('nonsense_intent').tool === 'group_tabs');
ok('toolForIntent returns a fresh args object (no shared mutation)',
  (() => { const a = toolForIntent('pin_tabs'); a.args.action = 'MUTATED';
           return toolForIntent('pin_tabs').args.action === 'pin'; })());

console.log('\n--- A4: group name is never undefined ---');
const NAME_CASES = [
  // [command, cards, llmName, expected]
  ['group my cricket tabs', [card(['sports']), card(['sports']), card(['sports'])], null, 'Sports'],
  ['group my cricket tabs', [], null, 'Cricket'],
  ['organize these', [], null, 'Tabs'],
  ['group all my tabs together', [], null, 'Tabs'],
  ['group my coding tabs', [card(['coding']), card(['coding'])], null, 'Coding'],
  // LLM-supplied name wins when present (this is where D5 plugs in later)
  ['group my cricket tabs', [card(['sports'])], 'IPL 2026', 'IPL 2026'],
  // A minority tag must NOT name the group
  ['group my reading list', [card(['sports']), card(['news']), card(['cooking'])], null, 'Reading List'],
  // 'other' is an abstention, never a title
  ['group these pages', [card(['other']), card(['other'])], null, 'Pages']
];
for (const [cmd, cards, llm, expected] of NAME_CASES) {
  const got = deriveGroupName(cmd, cards, llm);
  ok(`"${cmd}" (${cards.length} cards${llm ? ', llm="' + llm + '"' : ''}) -> "${expected}"`,
    got === expected, got);
}

console.log('\n--- A4: no input produces "undefined" or an empty title ---');
const ADVERSARIAL = [
  [undefined, undefined, undefined],
  ['', [], ''],
  ['group', [], null],
  ['group my tabs', null, null],
  ['   ', [card([])], null],
  ['group the the the', [], null]
];
for (const [cmd, cards, llm] of ADVERSARIAL) {
  const got = deriveGroupName(cmd, cards, llm);
  ok(`deriveGroupName(${JSON.stringify(cmd)}) -> "${got}"`,
    typeof got === 'string' && got.length > 0 &&
    got !== 'undefined' && got !== 'null' && got.trim() === got, got);
}

console.log('\n--- title length is bounded (chrome group titles are short) ---');
{
  const long = 'group my extraordinarily verbose and quite unnecessarily lengthy machine learning research tabs';
  const got = deriveGroupName(long, [], null);
  ok(`long command -> <= 40 chars ("${got}")`, got.length <= 40, got.length);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
