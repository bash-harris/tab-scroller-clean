// Scratch probe: gauntlet-v2 R2 repair verification (deterministic floor path).
const path = require('path');
global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));
const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const POOL = [
  { id: 'yt-watch', title: 'Lo-fi mix', url: 'https://www.youtube.com/watch?v=abc' },
  { id: 'yt-shorts', title: 'Short: cat', url: 'https://www.youtube.com/shorts/xyz' },
  { id: 'amz-cart', title: 'Amazon Cart', url: 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart' },
  { id: 'amz-dp', title: 'Wireless mouse', url: 'https://www.amazon.com/dp/B08N5WRWNW' },
  { id: 'gh-repo', title: 'foo/bar', url: 'https://github.com/foo/bar' },
  { id: 'news', title: 'Daily story', url: 'https://example-news.com/story/1' }
];
const candidates = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: 'news', tags: [] },
  index: 1, openedAt: Date.now() - 60000, lastAccessed: Date.now() - 30000
}));

const PROBES = [
  ['close amazon cart tabs',                     { fire: true,  ids: ['amz-cart'] }],
  ['close youtube tabs but keep shorts',         { fire: false }],
  ['close youtube shorts tabs',                  { fire: true,  ids: ['yt-shorts'] }],
  ['close shopping tabs unless they are pinned', { fire: false }],
  ['close all tabs except github',               { fire: false }]
];

(async () => {
  console.log('-- parser cue (slotsFromCommand -> validateSlots) --');
  for (const [cmd] of PROBES) {
    const v = LlmQuery.validateSlots(LlmQuery.slotsFromCommand(cmd));
    console.log(JSON.stringify({ cmd, slots: v }));
  }
  console.log('-- interpreter (floor path, no query object) --');
  for (const [cmd, exp] of PROBES) {
    let res;
    try {
      res = await NliSelect.select(cmd, candidates, {});
    } catch (e) {
      console.log(JSON.stringify({ cmd, CRASH: String(e && e.message) }));
      continue;
    }
    const got = res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId).sort();
    const fired = String(res.mode || '').startsWith('slot ');
    const ok = fired === exp.fire &&
      (!exp.ids || JSON.stringify(got) === JSON.stringify(exp.ids.slice().sort()));
    console.log(JSON.stringify({ cmd, mode: res.mode, got, fired, expectFire: exp.fire, PASS: ok }));
  }
})();
