// tests/domain-priors.test.js
// Pure-function test — no chrome APIs, no Embed. Run: node tests/domain-priors.test.js
const path = require('path');
const priors = require(path.join(__dirname, '..', 'domain-priors.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; }
  else console.log('  ok:', msg);
}

// DOMAIN_PRIORS exact match
let r = priors.applyPriors('https://github.com/foo/bar');
assert(r && r.tags.includes('coding') && r.conf >= 0.9, 'github.com -> coding');

r = priors.applyPriors('https://www.espncricinfo.com/series/foo');
assert(r && r.tags.includes('cricket') && r.conf >= 0.9, 'espncricinfo.com -> cricket');

// PATH_PRIORS with capture group (subreddit)
r = priors.applyPriors('https://www.reddit.com/r/cricket/comments/x/');
assert(r && r.tags.includes('sports'), 'reddit /r/cricket -> sports via subreddit map');

r = priors.applyPriors('https://www.reddit.com/r/recipes/x/');
assert(r && r.tags.includes('cooking'), 'reddit /r/recipes -> cooking via subreddit map');

// PATH_PRIORS plain regex
r = priors.applyPriors('https://example.com/sports/football/live');
assert(r && r.tags.includes('sports'), '/sports/ path -> sports');

// No match -> null
r = priors.applyPriors('https://unknown-random-site-xyz.com/page');
assert(r === null, 'unknown domain/path -> null');

// www stripping + port + query string tolerance
r = priors.applyPriors('https://www.espncricinfo.com:443/series/x?utm_source=test');
assert(r && r.tags.includes('cricket'), 'www + port + query handled');

console.log(failures === 0 ? 'PASS' : `FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
