// tests/facet.test.js
// Pure-function gate for ingest-time facet fingerprints (Tier 1.1).
//   node tests/facet.test.js

global.self = global;
const Facet = require('../facet.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
const mk = (over) => Object.assign({
  tabId: 1, title: '', url: '', domain: '', category: '', tags: [],
  pinned: false, muted: false, audible: false,
}, over);
const ent = (c) => JSON.parse(JSON.stringify(c));

// media derivation
check('youtube watch -> video', Facet.build(mk({ url: 'https://www.youtube.com/watch?v=x' })).media === 'video');
check('youtu.be -> video', Facet.build(mk({ url: 'https://youtu.be/x' })).media === 'video');
check('twitch -> live/video family', ['live', 'video'].includes(Facet.build(mk({ url: 'https://www.twitch.tv/shroud' })).media));
check('netflix muted still video', Facet.build(mk({ url: 'https://www.netflix.com/watch/1', muted: true })).media === 'video');
check('spotify playlist -> audio', Facet.build(mk({ url: 'https://open.spotify.com/playlist/1' })).media === 'audio');
check('podcast host -> audio', Facet.build(mk({ url: 'https://podcast-example.com/dtns-512' })).media === 'audio');
check('audible flag overrides to audio', Facet.build(mk({ url: 'https://example.com/a', audible: true })).media === 'audio');
check('file:// pdf -> doc', Facet.build(mk({ url: 'file:///Users/dev/report.pdf' })).media === 'doc');
check('plain article -> text', Facet.build(mk({ url: 'https://blog.example.com/post' })).media === 'text');

// commerce derivation
check('amazon /dp/ -> storefront', Facet.build(mk({ url: 'https://www.amazon.com/dp/B0X' })).commerce === 'storefront');
check('ebay /itm/ -> marketplace', Facet.build(mk({ url: 'https://www.ebay.com/itm/1' })).commerce === 'marketplace');
check('craigslist -> marketplace', Facet.build(mk({ url: 'https://sfbay.craigslist.org/sfc/bik/d/vintage' })).commerce === 'marketplace');
check('/deals path -> deals', Facet.build(mk({ url: 'https://not-amazon.com/products/deals' })).commerce === 'deals');
check('docs page -> commerce none', Facet.build(mk({ url: 'https://en.wikipedia.org/wiki/X' })).commerce === 'none');

// genre + trust/conflict rule
const cb = Facet.build(mk({ url: 'https://www.cricbuzz.com/cricket-news/ashes', category: 'sports', tags: ['cricket', 'news'] }));
check('cricbuzz derived genre = sports (host family)', cb.genre === 'sports');
check('lying "news" tag recorded as conflict', cb.conflicts.some(x => x.claimed === 'news'));
check('conflicted tag pruned from trusted content', !cb.tags.includes('news') && cb.content.includes('cricket'));

const bb = Facet.build(mk({ url: 'https://www.bloomberg.com/crypto/etf', category: 'finance', tags: ['crypto'] }));
check('bloomberg host -> genre news', bb.genre === 'news');
check('finance category survives as content (no conflict)', !bb.conflicts.length && bb.content.includes('finance'));

check('bbc weather path overrides news family', Facet.build(mk({ url: 'https://www.bbc.com/weather/2643743' })).genre === 'weather');
check('theonion -> satire', Facet.build(mk({ url: 'https://www.theonion.com/x' })).genre === 'satire');
check('wikipedia -> reference', Facet.build(mk({ url: 'https://en.wikipedia.org/wiki/P_versus_NP' })).genre === 'reference');
check('reddit -> forum', Facet.build(mk({ url: 'https://www.reddit.com/r/webdev/' })).genre === 'forum');

// predicate helpers
const f = Facet.build(mk({ url: 'https://www.twitch.tv/x', audible: true }));
check('isMedia helper', Facet.isMedia(f, ['video', 'live']));
check('hasCommerce helper false on media tab', Facet.hasCommerce(f) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
