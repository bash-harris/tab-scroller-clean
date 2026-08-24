// facet.js
// INGEST-TIME tab understanding (Tier 1.1): every tab gets a deterministic
// facet fingerprint built ONCE from its own fields, so queries compile against
// observed properties instead of re-deriving meaning at scoring time.
//
//   Facet.build(candidate) -> {
//     media:    'none'|'video'|'audio'|'live'|'text'|'doc',
//     commerce: 'none'|'storefront'|'listing'|'marketplace'|'deals'|'checkout',
//     genre:    'news'|'sports'|'reference'|'forum'|'satire'|'weather'|'docs'|'tool'|null,
//     content:  [trusted tags/category],      // conflicted tags removed
//     conflicts:[{field, claimed, derived}]   // lying metadata, recorded
//   }
//
// TRUST RULE: domain-derived facts beat self-declared tags. A tag claiming a
// genre the host contradicts ("news" on a cricket scoreboard) is moved to
// conflicts and excluded from evidence — the generalised fix for lying-tag
// poisoning, with no special cases.
//
// Pure function of the candidate. No chrome APIs, no model calls.

(() => {
  // Generic platform families — world knowledge, same class as BRAND_HOSTS.
  const VIDEO_FAMILY = ['youtube', 'youtu', 'twitch', 'netflix', 'vimeo', 'dailymotion', 'primevideo', 'hulu'];
  const AUDIO_FAMILY = ['spotify', 'soundcloud', 'pandora', 'deezer', 'audible', 'podcast'];
  const LIVE_TOKENS = ['/live', '/stream', 'livestream'];
  const NEWS_FAMILY = ['bbc', 'reuters', 'guardian', 'nytimes', 'bloomberg', 'cnn', 'apnews', 'nbcnews', 'news'];
  const SPORTS_FAMILY = ['espn', 'cricinfo', 'cricbuzz', 'iplt20', 'skysports', 'bleacher', 'fifa', 'nfl'];
  const SATIRE_FAMILY = ['theonion', 'satire'];
  const FORUM_TOKENS = ['reddit', 'forums', '/r/'];
  const REFERENCE_TOKENS = ['wikipedia', 'wiki.'];
  const DOCS_HINTS = ['developer.', 'docs.', 'mdn', '/docs/', 'readthedocs'];
  const WEATHER_TOKENS = ['weather', 'forecast', 'radar'];
  const COMMERCE_STORE = ['/dp/', '/product', '/itm/', '/p/', 'store.', '/store/', 'shop', 'flipkart', 'target.', 'walmart'];
  const COMMERCE_MARKET = ['craigslist', 'classifieds', 'marketplace', '/auctions', 'ebay'];
  const COMMERCE_DEALS = ['deals', 'offer', 'coupon', 'promo'];

  function tokens(url) {
    const s = String(url || '').toLowerCase();
    return {
      host: (() => { try { return new URL(s.startsWith('http') ? s : 'https://' + s).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
      path: (() => { try { return new URL(s.startsWith('http') ? s : 'https://' + s).pathname; } catch { return '/'; } })(),
      raw: s,
    };
  }
  function famHit(list, t) {
    return list.some(f => t.host.includes(f) || t.raw.includes(f.replace(/^\//, '')) || (f.startsWith('/') && t.path.includes(f)));
  }

  const GENRE_WORDS = new Set(['news', 'satire', 'weather']);

  function build(c) {
    const t = tokens(c && c.url);
    const titleLower = String((c && c.title) || '').toLowerCase();
    const cat = String((c && c.enrichment?.category) || (c && c.category) || '').toLowerCase();
    const rawTags = ((c && c.enrichment?.tags) || (c && c.tags) || [])
      .map(x => (typeof x === 'string' ? x : x && x.tag))
      .filter(Boolean).map(s => String(s).toLowerCase());
    const tagSet = new Set(rawTags);

    const conflicts = [];
    const dropConflicted = (claimedGenre) => {
      if (!GENRE_WORDS.has(claimedGenre)) return;
      if (tagSet.has(claimedGenre)) conflicts.push({ field: 'genre', claimed: claimedGenre, source: 'tag' });
    };

    // ---- genre (domain-derived first) ------------------------------------
    let genre = null;
    if (WEATHER_TOKENS.some(w => t.host.includes(w) || t.path.toLowerCase().includes(w))) genre = 'weather';
    else if (SATIRE_FAMILY.some(f => t.host.includes(f))) genre = 'satire';
    else if (SPORTS_FAMILY.some(f => t.host.includes(f))) genre = 'sports';
    else if (NEWS_FAMILY.some(f => t.host.includes(f) || t.path.toLowerCase().includes('/news'))) genre = 'news';
    else if (FORUM_TOKENS.some(f => t.host.includes(f) || t.raw.includes(f))) genre = 'forum';
    else if (REFERENCE_TOKENS.some(f => t.host.includes(f))) genre = 'reference';
    if (genre === 'news' && WEATHER_TOKENS.some(w => t.path.toLowerCase().includes(w))) genre = 'weather';

    // Record genre conflicts from lying tags BEFORE pruning content.
    for (const g of ['news', 'satire']) {
      if (genre && genre !== g && tagSet.has(g)) dropConflictedFromTags(g);
    }
    function dropConflictedFromTags(g) {
      if (tagSet.has(g)) { conflicts.push({ field: 'genre', claimed: g, derived: genre, source: 'tag' }); tagSet.delete(g); }
    }

    const trustedTags = [...tagSet];
    const content = cat && !conflicts.some(x => x.claimed === cat) ? [cat, ...trustedTags] : trustedTags;

    // ---- media ------------------------------------------------------------
    let media = 'none';
    const isPdf = /\.pdf\b/i.test(t.raw) || /\.pdf\b/i.test(titleLower);
    const fileScheme = /^file:\/\//i.test(String(c && c.url) || '');
    if (AUDIO_FAMILY.some(f => t.host.includes(f)) || rawTags.some(x => x === 'podcast')) media = 'audio';
    else if ((c && c.audible === true)) media = 'audio';
    if (VIDEO_FAMILY.some(f => t.host.includes(f)) ||
        /(\/watch|\/shorts|\/embed|\/video)/i.test(t.path)) media = 'video';
    if (LIVE_TOKENS.some(x => t.path.toLowerCase().includes(x) || t.raw.includes(x)) &&
        VIDEO_FAMILY.concat(['stream']).some(f => t.host.includes(f) || t.raw.includes(f))) media = 'live';
    if (media === 'none' && (fileScheme && isPdf || DOCS_HINTS.some(h => t.host.includes(h) || t.path.toLowerCase().includes(h)))) media = 'doc';
    if (media === 'none') media = 'text';

    // ---- commerce ----------------------------------------------------------
    let commerce = 'none';
    if (/cart|checkout/i.test(t.path)) commerce = 'checkout';
    else if (COMMERCE_MARKET.some(x => t.host.includes(x) || t.path.toLowerCase().includes(x))) commerce = 'marketplace';
    else if (COMMERCE_DEALS.some(x => t.host.includes(x) || t.path.toLowerCase().includes(x) || rawTags.includes(x))) commerce = 'deals';
    else if (COMMERCE_STORE.some(x => t.host.includes(x) || t.path.toLowerCase().includes(x))) commerce = 'storefront';

    // ---- work-axis fallback genre -----------------------------------------
    if (!genre) {
      if (cat === 'work') genre = null;             // ambiguous by design
      else if (cat === 'dev' || cat === 'technology') genre = 'tool';
      else if (cat === 'news') genre = 'news';      // category agrees with itself
    }

    return {
      media,
      commerce,
      genre,
      content,
      category: cat,
      tags: trustedTags,
      conflicts,
    };
  }

  // Predicate helpers used by the selection layer.
  const isMedia = (f, kinds) => !!f && kinds.includes(f.media);
  const hasCommerce = (f) => !!f && f.commerce !== 'none';
  const genreIs = (f, g) => !!f && f.genre === g;

  const Facet = { build, isMedia, hasCommerce, genreIs };
  if (typeof module !== 'undefined' && module.exports) module.exports = Facet;
  if (typeof self !== 'undefined') self.Facet = Facet;
})();
