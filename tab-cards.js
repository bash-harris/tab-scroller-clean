function sanitizePageContent(text) {
    if (!text) return '';
    const injectionPatterns = [
        /ignore\s+(?:any|the)?\s*instructions/gi,
        /system\s+prompt/gi,
        /you\s+are\s+now\s+an?\s+/gi,
        /instead\s+do\s+this/gi,
        /forget\s+previous/gi,
        /bypass\s+the/gi
    ];
    let clean = text;
    for (const pattern of injectionPatterns) {
        clean = clean.replace(pattern, '[Content Redacted]');
    }
    return clean;
}

async function extractRichPageData(tabId) {
    try {
        // Step 1: Inject the vendored Readability library into the page's isolated world
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['vendor/readability.js']
        });

        // Step 2: Run extraction in the same isolated world
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const CAP_TEXT = 4000;
                const CAP_PEOPLE = 20;
                const CAP_KEYWORDS = 20;

                const out = {
                    title: document.title || '',
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
                    const docClone = document.cloneNode(true);
                    const article = new Readability(docClone).parse();
                    if (article && article.textContent) {
                        out.mainText = article.textContent.replace(/\s+/g, ' ').trim().slice(0, CAP_TEXT);
                        out.excerpt = (article.excerpt || '').slice(0, 300);
                        out.byline = (article.byline || '').slice(0, 100);
                        out.extractionLevel = 'full';
                    }
                } catch (e) { /* fall through to minimal */ }

                // Fallback if Readability found nothing (SPAs, video pages)
                if (!out.mainText && document.body) {
                    out.mainText = document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, CAP_TEXT);
                    out.extractionLevel = 'body-fallback';
                }

                // --- JSON-LD structured data (Wikipedia, IMDb, news sites expose this) ---
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

                for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
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
                const meta = (sel) => document.querySelector(sel)?.content || '';
                if (!out.structured.type) out.structured.type = meta('meta[property="og:type"]');
                if (!out.excerpt) out.excerpt = (meta('meta[property="og:description"]') || meta('meta[name="description"]')).slice(0, 300);
                const metaKw = meta('meta[name="keywords"]');
                if (metaKw) metaKw.split(',').forEach(k => keywords.add(k.trim().slice(0, 50)));

                // article:section / og:article:section -> topic tag
                const section = meta('meta[property="article:section"]') || meta('meta[property="og:article:section"]');
                if (section) harvestTags.add(section.trim().toLowerCase().slice(0, 30));

                // Wikipedia human-curated categories (#mw-normal-catlinks)
                for (const a of document.querySelectorAll('#mw-normal-catlinks a[href^="/wiki/Category:"]')) {
                    const name = (a.textContent || '').trim().toLowerCase();
                    if (name) keywords.add(name.slice(0, 50));
                }

                // --- Pseudo-document for embedding (title x2 | path tokens | desc | h1 | h2x3 | first 2 sentences) ---
                const pseudoParts = [];
                const title = out.title || '';
                if (title) pseudoParts.push(title, title);
                try {
                    const pathTokens = location.pathname.split(/[/\-_]+/).filter(t => t && t.length > 1);
                    if (pathTokens.length) pseudoParts.push(pathTokens.join(' '));
                } catch (e) {}
                if (out.excerpt) pseudoParts.push(out.excerpt);
                const h1 = document.querySelector('h1');
                if (h1 && h1.textContent) pseudoParts.push(h1.textContent.trim().slice(0, 120));
                const h2s = Array.from(document.querySelectorAll('h2')).slice(0, 3);
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
        });

        const data = results?.[0]?.result || null;
        if (data) {
            data.mainText = sanitizePageContent(data.mainText);
            data.excerpt = sanitizePageContent(data.excerpt);
            data.harvestTags = (data.harvestTags || []).slice(0, 8).map(String);
            data.pseudoDoc = sanitizePageContent(data.pseudoDoc || '').slice(0, 800);
        }
        return data;
    } catch (e) {
        // Injection fails on chrome://, Web Store, PDFs — return minimal card data
        return null;
    }
}

async function sha256(text) {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function buildTabCard(tab, cachedCards) {
  const isExcluded = !tab.url || 
    tab.url.startsWith('chrome://') || 
    tab.url.startsWith('edge://') || 
    tab.url.startsWith('about:') || 
    tab.url.startsWith('chrome-extension://');

  const normalized = normalizeUrl(tab.url);
  const urlHash = await sha256(normalized);
  const domain = (() => {
    try {
      return new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  if (isExcluded) {
    const card = {
      tabId: tab.id,
      url: tab.url || '',
      urlHash,
      domain,
      title: tab.title || '',
      extractedAt: Date.now(),
      contentHash: '',
      mainText: '',
      structured: { type: 'other', headline: '', keywords: [], people: [], datePublished: '' },
      enrichment: {
        category: 'other',
        subTopics: [],
        entities: { people: [], orgs: [], works: [] },
        contentType: 'other',
        summary: tab.title || '',
        enrichedAt: 0
      },
      embedding: new Float32Array(0),
      extractionLevel: 'minimal'
    };
    await self.TabDB.storeTabCard(card);
    return card;
  }

  // Reuse pre-fetched card list when available (batch callers); fetch once otherwise.
  let savedCards;
  if (Array.isArray(cachedCards)) {
    savedCards = cachedCards;
  } else {
    savedCards = [];
    try {
      savedCards = await self.TabDB.getAllTabCards();
    } catch (e) {}
  }

  // Cache hit: same URL + valid vec2 enrichment + fresh TTL.
  // No re-extraction, no script injection, no re-embedding — ~2ms.
  const cachedCard = savedCards.find(c =>
    c.urlHash === urlHash &&
    c.enrichment?.vecVersion === 2 &&
    c.enrichment?.enrichedAt > 0 &&
    (Date.now() - c.enrichment.enrichedAt) < 7 * 24 * 60 * 60 * 1000);

  if (cachedCard) {
    const newCard = {
      ...cachedCard,
      tabId: tab.id,
      title: tab.title || cachedCard.title,
      url: tab.url,
      extractedAt: Date.now()
    };
    await self.TabDB.storeTabCard(newCard);
    return newCard;
  }

  const richData = await extractRichPageData(tab.id);
  const mainText = richData?.mainText || '';
  const pseudoDocForHash = richData?.pseudoDoc || tab.title || '';
  const contentHash = await sha256(pseudoDocForHash);

  const category = (() => {
    if (typeof classifyDomain === 'function') {
      return classifyDomain(tab.url);
    }
    return 'other';
  })();

  const card = {
    tabId: tab.id,
    url: tab.url,
    urlHash,
    domain,
    title: tab.title || '',
    extractedAt: Date.now(),
    contentHash,
    mainText,
    structured: richData?.structured || { type: 'other', headline: '', keywords: [], people: [], datePublished: '' },
    enrichment: {
      category: category === 'other' ? 'other' : category,
      tags: category === 'other' ? [] : [{ tag: category, score: 0.9 }],
      subTopics: ((richData && richData.structured && richData.structured.keywords) || []).slice(0, 4),
      entities: (richData && richData.structured && richData.structured.people)
        ? { people: richData.structured.people, orgs: [], works: [] } : { people: [], orgs: [], works: [] },
      contentType: 'other',
      tier: 'math',
      vecVersion: 2,
      enrichedAt: Date.now()
    },
    embedding: new Float32Array(0),
    extractionLevel: richData?.extractionLevel || 'minimal'
  };

  // ---- Math enrichment (offline, no LLM) ----
  const pseudoDoc = (richData && richData.pseudoDoc) ||
    `${card.title || ''} ${card.title || ''} ${domain.split('.').slice(-2).join(' ')}`.trim().slice(0, 800);
  const harvestTags = (richData && richData.harvestTags) || [];

  try {
    if (typeof self.EnrichMath !== 'undefined' && typeof self.Embed !== 'undefined') {
      await self.EnrichMath.initTopicVocab(self.Embed.embed.bind(self.Embed));
      const v = await self.Embed.embed(pseudoDoc);
      if (v && v.length > 0) {
        card.embedding = new Float32Array(v);
        const prior = typeof self.DomainPriors !== 'undefined' ? self.DomainPriors.applyPriors(tab.url) : null;
        card.enrichment = self.EnrichMath.mathEnrich(card.embedding, {
          harvestTags,
          keywordHints: (richData && richData.structured && richData.structured.keywords) || [],
          priorTags: prior ? prior.tags : [],
          priorConf: prior ? prior.conf : 0,
          structured: (richData && richData.structured) || null
        });
        if (card.enrichment.subTopics.length === 0) {
          card.enrichment.subTopics = ((richData && richData.structured && richData.structured.keywords) || []).slice(0, 4);
        }
      }
    }
  } catch (err) {
    console.warn('[TabCards] mathEnrich failed:', err.message);
  }

  card.pseudoDoc = pseudoDoc;

  await self.TabDB.storeTabCard(card);

  // Eviction uses the already-loaded card list — no extra DB scan.
  if (savedCards.length > 2000) {
    const allCards = savedCards;
    allCards.sort((a, b) => a.extractedAt - b.extractedAt);
    const toDeleteCount = allCards.length - 2000;
    for (let i = 0; i < toDeleteCount; i++) {
      await self.TabDB.deleteTabCard(allCards[i].tabId);
    }
  }

  return card;
}

self.sha256 = sha256;
self.normalizeUrl = normalizeUrl;
self.buildTabCard = buildTabCard;
