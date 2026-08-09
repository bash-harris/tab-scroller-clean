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
        // Inject the vendored Readability library + the shared extraction core into
        // the page's isolated world, then run __tsExtract in that same world.
        // extract-core.js is the single source of truth for extraction — the bench
        // (bench/enrich-bench.js) injects the identical two files, so bench and
        // production score the same page identically.
        // Note filename: vendor/readibility.js (as on disk). Do not "fix" the typo
        // to readability.js — the file was never renamed and doing so silently
        // disabled extraction for the entire life of the feature.
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            files: ['vendor/readibility.js', 'extract-core.js']
        });

        // executeScript({files}) returns the last statement value of the last file.
        // extract-core.js ends by assigning globalThis.__tsExtract, so run it in a
        // second call that invokes the now-loaded function.
        const invoke = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => globalThis.__tsExtract(document, location)
        });
        results[0] = invoke[0];
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
