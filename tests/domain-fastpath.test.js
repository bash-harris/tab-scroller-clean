// tests/domain-fastpath.test.js
// Regression gate for the domain-scope fast path.
//
// BUG: "group all amazon tabs" was classified 'semantic' (bare brand without
// TLD defeats DOMAIN_PATTERN; "amazon" between "all" and "tabs" defeats
// ALL_TABS_CLEAN), then scored through embeddings + NLI, which returned an
// arbitrary SUBSET of the amazon tabs (measured live: 1 of 6). Domain
// membership is a metadata predicate and must resolve deterministically.
//
// Pure logic, no chrome, no embeddings:
//   node tests/domain-fastpath.test.js

global.self = global;
global.chrome = undefined;

const {
  resolveDomainScopes, isDomainScopeCommand, detectIntent
} = require('../command-agent.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const flat = (scopes) => (scopes || []).flat();

console.log('resolveDomainScopes');

let s = resolveDomainScopes('group all amazon tabs');
check('bare brand amazon -> regional hosts', !!s && flat(s).includes('amazon.com') && flat(s).includes('amazon.in'), JSON.stringify(s));

s = resolveDomainScopes('close all youtube.com tabs');
check('dotted token wins, no duplicate brand scope', !!s && s.length === 1 && s[0][0] === 'youtube.com', JSON.stringify(s));

s = resolveDomainScopes('group my flipkart and ebay tabs');
check('multi-brand union', !!s && s.length === 2, JSON.stringify(s));

s = resolveDomainScopes('close primevideo tabs');
check('primevideo distinct from amazon', !!s && s.length === 1 && !flat(s).some(h => h.includes('amazon')), JSON.stringify(s));

s = resolveDomainScopes('mute every youtube tab');
check('subdomain-capable host list for youtube', !!s && flat(s).includes('youtu.be') && flat(s).includes('youtube.com'), JSON.stringify(s));

s = resolveDomainScopes('close my knitting tabs');
check('no domain words -> null', s === null, JSON.stringify(s));

console.log('isDomainScopeCommand (shape guard)');

check('"group all amazon tabs" fires',
  isDomainScopeCommand('group all amazon tabs') === true);

check('"close all tabs on espncricinfo.com" fires',
  isDomainScopeCommand('close all tabs on espncricinfo.com') === true);

check('"close all youtube.com tabs from yesterday" does NOT fire (trailing qualifier)',
  isDomainScopeCommand('close all youtube.com tabs from yesterday') === false,
  'temporal compound must stay with the agent router');

check('"close all amazon tabs except the book one" does NOT fire (exception)',
  isDomainScopeCommand('close all amazon tabs except the book one') === false,
  'exception compounds must not take the fast path');

check('"pin my travel tabs" does NOT fire (no resolvable domain)',
  (() => {
    const scopes = resolveDomainScopes('pin my travel tabs');
    return !(scopes && isDomainScopeCommand('pin my travel tabs'));
  })());

check('"reload everything" does NOT fire (ends in everything)',
  isDomainScopeCommand('reload everything') === false);

console.log('detectIntent pairing');

check('"group all amazon tabs" intent = group_tabs',
  detectIntent('group all amazon tabs') === 'group_tabs');

check('"close all youtube.com tabs" intent = close_tabs',
  detectIntent('close all youtube.com tabs') === 'close_tabs');

check('"unpin all github tabs" intent = unpin_tabs',
  detectIntent('unpin all github tabs') === 'unpin_tabs');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
