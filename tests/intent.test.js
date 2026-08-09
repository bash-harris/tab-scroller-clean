// tests/intent.test.js
// Phase 0 / A2 + A3 regression gate for command routing.
//
// A2: sanitizeQuery stripped '.' from commands, so "close youtube.com tabs"
//     became "close youtube com tabs" and every domain check was false.
// A3: the intent ladder tested 'pin' before 'unpin', 'mute' before 'unmute',
//     and 'close' first of all -- so unpin_tabs/unmute_tabs were unreachable
//     and any command containing the substring "close" (e.g. "closed caption")
//     resolved to the single destructive intent.
//
// Pure logic, no chrome and no embedding model:
//   node tests/intent.test.js

global.self = global;
global.chrome = undefined;

const {
  detectIntent, isAmbiguousIntent, hasDomainPattern
} = require('../command-agent.js');

// Mirror of the fixed sanitizeQuery in background.js. Kept in sync by the
// "sanitizer parity" case at the bottom of this file.
function sanitizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, 500)
    .replace(/^[>\s]+/, '')
    .replace(/[^a-zA-Z0-9\s'./-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The pre-fix implementations, kept verbatim so the report can show a real delta.
function legacySanitizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, 500)
    .replace(/^[>\s]+/, '')
    .replace(/[^a-zA-Z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function legacyDetectIntent(cmdLower) {
  return cmdLower.includes('close') ? 'close_tabs' :
         cmdLower.includes('bookmark') ? 'bookmark_tabs' :
         cmdLower.includes('pin') ? 'pin_tabs' :
         cmdLower.includes('unpin') ? 'unpin_tabs' :
         cmdLower.includes('mute') ? 'mute_tabs' :
         cmdLower.includes('unmute') ? 'unmute_tabs' :
         cmdLower.includes('reload') ? 'reload_tabs' :
         cmdLower.includes('search') ? 'search_and_switch' :
         cmdLower.includes('sort') ? 'sort_tabs' :
         'group_tabs';
}

// (command, expected intent). Adversarial classes from the plan: negation,
// inverted verbs, homographs, and the destructive-default trap.
const INTENT_CASES = [
  // --- inverted verbs: unreachable before the fix ---
  ['unpin all tabs',                         'unpin_tabs'],
  ['unpin my github tabs',                   'unpin_tabs'],
  ['un-pin everything',                      'unpin_tabs'],
  ['unmute the youtube tab',                 'unmute_tabs'],
  ['turn the sound back on for spotify',     'unmute_tabs'],

  // --- homograph: "closed caption" is not the close verb ---
  ['group my closed caption tabs',           'group_tabs'],
  ['organize closed caption videos',         'group_tabs'],

  // --- negation: must not resolve to the destructive intent ---
  ["don't close my docs, just group them",   'group_tabs'],
  ['dont close anything, only pin them',     'pin_tabs'],
  ['group these instead of closing them',    'group_tabs'],

  // --- ordinary positive forms still work ---
  ['close all my shopping tabs',             'close_tabs'],
  ['close youtube.com tabs',                 'close_tabs'],
  ['pin the documentation tabs',             'pin_tabs'],
  ['mute all noisy tabs',                    'mute_tabs'],
  ['bookmark these for later',               'bookmark_tabs'],
  ['reload the failed tabs',                 'reload_tabs'],
  ['sort tabs by domain',                    'sort_tabs'],
  ['group my cricket tabs',                  'group_tabs'],
  ['organize my reading list',               'group_tabs'],

  // --- no explicit verb: default to the least destructive action ---
  ['my cricket tabs',                        'group_tabs'],
  ['everything about machine learning',      'group_tabs']
];

const DOMAIN_CASES = [
  ['close youtube.com tabs',       true],
  ['group github.com and stackoverflow.com', true],
  ['close tabs from espncricinfo.com', true],
  ['group my cricket tabs',        false],
  ['close all shopping tabs',      false],
  ['bump version to v1.2',         false]   // not a domain
];

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\n--- A3: intent detection ---');
let legacyCorrect = 0;
for (const [cmd, expected] of INTENT_CASES) {
  const got = detectIntent(sanitizeQuery(cmd).toLowerCase());
  ok(`"${cmd}" -> ${expected}`, got === expected, got);
  if (legacyDetectIntent(legacySanitizeQuery(cmd).toLowerCase()) === expected) legacyCorrect++;
}

console.log('\n--- A2: domain pattern survives sanitization ---');
let legacyDomainCorrect = 0;
for (const [cmd, expected] of DOMAIN_CASES) {
  const got = hasDomainPattern(sanitizeQuery(cmd));
  ok(`"${cmd}" -> domain:${expected}`, got === expected, String(got));
  const legacyRe = /\b[a-z0-9-]+\.(com|org|net|edu|gov|co|io|uk|in|de|jp|us|xyz)\b/i;
  if (legacyRe.test(legacySanitizeQuery(cmd).toLowerCase()) === expected) legacyDomainCorrect++;
}

console.log('\n--- A3: ambiguity forces a preview ---');
ok('"close or group these" is ambiguous', isAmbiguousIntent('close or group these'));
ok('"group my cricket tabs" is not ambiguous', !isAmbiguousIntent('group my cricket tabs'));
ok('"unpin and close the old tabs" is ambiguous', isAmbiguousIntent('unpin and close the old tabs'));

console.log('\n--- sanitizer parity with background.js ---');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  // The character class must preserve '.' and '/'.
  ok('background.js sanitizeQuery preserves . and /',
    /replace\(\/\[\^a-zA-Z0-9\\s'\.\/-\]\/g/.test(src) ||
    src.includes("[^a-zA-Z0-9\\s'./-]"),
    'character class in background.js no longer matches this test\'s mirror');
}

const total = INTENT_CASES.length;
const domainTotal = DOMAIN_CASES.length;
const intentFails = INTENT_CASES.filter(([cmd, exp]) =>
  detectIntent(sanitizeQuery(cmd).toLowerCase()) !== exp).length;
const domainFails = DOMAIN_CASES.filter(([cmd, exp]) =>
  hasDomainPattern(sanitizeQuery(cmd)) !== exp).length;

const pct = (a, b) => `${a}/${b} (${(100 * a / b).toFixed(0)}%)`;
console.log('\n' + '='.repeat(60));
console.log('ROUTING ACCURACY  (legacy code -> current code, same cases)');
console.log(`  intent-acc : ${pct(legacyCorrect, total)}  ->  ${pct(total - intentFails, total)}`);
console.log(`  domain-acc : ${pct(legacyDomainCorrect, domainTotal)}  ->  ${pct(domainTotal - domainFails, domainTotal)}`);
console.log('='.repeat(60));
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
