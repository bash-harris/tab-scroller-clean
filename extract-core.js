// extract-core.js
// Page-extraction logic shared by production (tab-cards.js) and the bench
// (bench/enrich-bench.js). Pure DOM + location: no chrome APIs, no module system
// deps. Loaded via chrome.scripting.executeScript({files}) in prod and by
// reading the file into a puppeteer page in the bench — one implementation,
// two callers, so bench and production can't drift.
//
// Exposes globalThis.__tsExtract(document, location) -> the same `out` object
// tab-cards.js previously built inline.

(() => {
  const CAP_TEXT = 4000;
  const CAP_PEOPLE = 20;
  const CAP_KEYWORDS = 20;

  const SCHEMA_TYPE_TO_TAG = {
    NewsArticle: 'news', Article: 'news', Report: 'news', LiveBlogPosting: 'news',
    Recipe: 'cooking', SportsEvent: 'sports', SportsTeam: 'sports',
    Movie: 'entertainment', TVSeries: 'entertainment', Episode: 'entertainment',
    MusicAlbum: 'entertainment', MusicRecording: 'entertainment', MusicGroup: 'music',
    SoftwareSourceCode: 'coding', WebApplication: 'coding', SoftwareApplication: 'coding',
    Product: 'shopping', Offer: 'shopping', JobPosting: 'work', Organization: 'work',
    VideoObject: 'video', VideoGame: 'gaming', ScholarlyArticle: 'science',
    Book: 'reference', WebPage: null, AboutPage: null
  };

  function __tsExtract(doc, loc) {
    const out = {
      title: doc.title || '',
      mainText: '',
      excerpt: '',
      byline: '',
      structured: { type: '', headline: '', keywords: [], people: [], datePublished: '' },
      extractionLevel: 'minimal',
      harvestTags: [],
      pseudoDoc: ''
    };

    // --- Readability: main article content ---
    try {
      // Clone so we don't mutate the live page
      const docClone = doc.cloneNode(true);
      const article = new Readability(docClone).parse();
      if (article && article.textContent) {
        out.mainText = article.textContent.replace(/\s+/g, ' ').trim().slice(0, CAP_TEXT);
        out.excerpt = (article.excerpt || '').slice(0, 300);
        out.byline = (article.byline || '').slice(0, 100);
        out.extractionLevel = 'full';
      }
    } catch (e) { /* fall through to minimal */ }

    // Fallback if Readability found nothing (SPAs, video pages)
    if (!out.mainText && doc.body) {
      out.mainText = doc.body.innerText.replace(/\s+/g, ' ').trim().slice(0, CAP_TEXT);
      out.extractionLevel = 'body-fallback';
    }

    const people = new Set();
    const keywords = new Set();
    const harvestTags = new Set();
    const collectNames = (val) => {
      if (!val) return;
      const items = Array.isArray(val) ? val : [val];
      for (const item of items) {
        const name = typeof item === 'string' ? item : item?.name;
        if (name && typeof name === 'string') people.add(name.trim().slice(0, 80));
      }
    };

    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        let data = JSON.parse(script.textContent);
        const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          if (!out.structured.type && node['@type']) {
            out.structured.type = String(Array.isArray(node['@type']) ? node['@type'][0] : node['@type']);
          }
          for (const ty of Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) {
            const tag = SCHEMA_TYPE_TO_TAG[String(ty)];
            if (tag) harvestTags.add(tag);
          }
          if (!out.structured.headline && node.headline) out.structured.headline = String(node.headline).slice(0, 200);
          if (!out.structured.datePublished && node.datePublished) out.structured.datePublished = String(node.datePublished).slice(0, 30);
          if (node.keywords) {
            const kws = typeof node.keywords === 'string' ? node.keywords.split(',') : node.keywords;
            if (Array.isArray(kws)) kws.forEach(k => typeof k === 'string' && keywords.add(k.trim().slice(0, 50)));
          }
          collectNames(node.actor); collectNames(node.author);
          collectNames(node.director); collectNames(node.about);
        }
      } catch (e) { /* skip malformed JSON-LD blocks */ }
    }

    // --- OpenGraph / meta fallbacks ---
    const meta = (sel) => doc.querySelector(sel)?.content || '';
    if (!out.structured.type) out.structured.type = meta('meta[property="og:type"]');
    if (!out.excerpt) out.excerpt = (meta('meta[property="og:description"]') || meta('meta[name="description"]')).slice(0, 300);
    const metaKw = meta('meta[name="keywords"]');
    if (metaKw) metaKw.split(',').forEach(k => keywords.add(k.trim().slice(0, 50)));

    // article:section / og:article:section -> topic tag
    const section = meta('meta[property="article:section"]') || meta('meta[property="og:article:section"]');
    if (section) harvestTags.add(section.trim().toLowerCase().slice(0, 30));

    // Wikipedia human-curated categories (#mw-normal-catlinks)
    for (const a of doc.querySelectorAll('#mw-normal-catlinks a[href^="/wiki/Category:"]')) {
      const name = (a.textContent || '').trim().toLowerCase();
      if (name) keywords.add(name.slice(0, 50));
    }

    // --- Pseudo-document for embedding (title x2 | path tokens | desc | h1 | h2x3 | first 2 sentences) ---
    const pseudoParts = [];
    const title = out.title || '';
    if (title) pseudoParts.push(title, title);
    try {
      const pathTokens = loc.pathname.split(/[/\-_]+/).filter(t => t && t.length > 1);
      if (pathTokens.length) pseudoParts.push(pathTokens.join(' '));
    } catch (e) {}
    if (out.excerpt) pseudoParts.push(out.excerpt);
    const h1 = doc.querySelector('h1');
    if (h1 && h1.textContent) pseudoParts.push(h1.textContent.trim().slice(0, 120));
    const h2s = Array.from(doc.querySelectorAll('h2')).slice(0, 3);
    for (const h2 of h2s) {
      const t = (h2.textContent || '').trim();
      if (t) pseudoParts.push(t.slice(0, 80));
    }
    const sentenceMatch = out.mainText ? out.mainText.match(/[^.!?]+[.!?]+[^.!?]+[.!?]+/) : null;
    if (sentenceMatch) pseudoParts.push(sentenceMatch[0].trim().slice(0, 240));
    out.pseudoDoc = pseudoParts.filter(Boolean).join(' | ').slice(0, 800);
    out.harvestTags = Array.from(harvestTags);

    out.structured.people = Array.from(people).slice(0, CAP_PEOPLE);
    out.structured.keywords = Array.from(keywords).slice(0, CAP_KEYWORDS);
    return out;
  }

  globalThis.__tsExtract = __tsExtract;
})();
