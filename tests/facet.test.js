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

// topicGenre derivation (D1): WHAT a page is about, orthogonal to media.
check('podcast host -> media audio', Facet.build(mk({ url: 'https://podcast-example.com/dtns-512' })).media === 'audio');
check('podcast host -> topicGenre entertainment', Facet.build(mk({ url: 'https://podcast-example.com/dtns-512' })).topicGenre === 'entertainment');
check('podcast tag on foreign host -> podcast flag', Facet.build(mk({ url: 'https://feeds.example.com/ep1', tags: ['podcast'] })).podcast === true);
check('primevideo -> topicGenre entertainment', Facet.build(mk({ url: 'https://www.primevideo.com/detail/the-boys' })).topicGenre === 'entertainment');
check('netflix -> topicGenre entertainment', Facet.build(mk({ url: 'https://www.netflix.com/watch/1' })).topicGenre === 'entertainment');
check('twitch -> topicGenre gaming (NOT entertainment)', Facet.build(mk({ url: 'https://www.twitch.tv/shroud' })).topicGenre === 'gaming');
check('redzone stream slug -> topicGenre sports', Facet.build(mk({ url: 'https://stream-example.com/redzone-live' })).topicGenre === 'sports');
check('espn host -> topicGenre sports', Facet.build(mk({ url: 'https://www.espn.com/nba/game/lakers-celtics' })).topicGenre === 'sports');

// weather derivation must not eat aviation radar vocabulary (D4)
const fr = Facet.build(mk({ url: 'https://www.flightradar24.com/BAW178/3a8b9c', tags: ['aviation', 'radar'] }));
check('flightradar24 -> NOT weather genre', fr.genre !== 'weather');
check('flightradar24 -> topicGenre travel', fr.topicGenre === 'travel');
check('bbc weather path still weather', Facet.build(mk({ url: 'https://www.bbc.com/weather/2643743' })).genre === 'weather');
check('doppler radar page still weather via host', Facet.build(mk({ url: 'https://weather.com/radar/us/sf' })).genre === 'weather');

// SENSE GATE (D2/D3): facet elect suppressed by command frames. Exercised
// through the nli-select test seam so the gate is checked at its call sites'
// exact entry point.
const NliSelect = require('../nli-select.js');
const predOf = NliSelect.__facetPredicateForTest;
check('sense gate: "docs" elect fires normally', typeof predOf('docs', 'bookmark my docs tabs') === 'function');
check('sense gate: negation frame suppresses docs facet', predOf('docs', "don t close my docs just pin them") === null);
check('sense gate: exception frame suppresses docs facet', predOf('docs', 'everything except docs can be closed') === null);
check('sense gate: desire-shaped negation does NOT suppress shopping', typeof predOf('shopping', 'don t want any shopping tabs open anymore') === 'function');
check('sense gate: close-deals collocation suppresses commerce facet for deal concepts', predOf('enterprise deals', 'close the tab discussing closing enterprise deals') === null);
check('sense gate: deals facet fine without competing frame', typeof predOf('amazon.co.uk deals', 'pin the amazon.co.uk deals page') === 'function');
check('sense gate: video facet untouched by unrelated command', typeof predOf('video', 'mute al teh vidoe tabs') === 'function');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
