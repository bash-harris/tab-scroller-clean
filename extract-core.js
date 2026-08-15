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
  const CAP_KEYWORDS = 25;

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

  // Comprehensive stop words & web noise filters for high keyword density
  const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
    'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during',
    'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
    'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
    'me', 'more', 'most', 'my', 'myself',
    'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own',
    'same', 'she', 'should', 'so', 'some', 'such',
    'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
    'under', 'until', 'up', 'very',
    'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would',
    'you', 'your', 'yours', 'yourself', 'yourselves',
    // Web UI noise
    'like', 'subscribe', 'follow', 'share', 'comment', 'cookie', 'cookies', 'privacy', 'policy', 'terms', 'service', 'sign', 'login', 'logout'
  ]);

  function filterStopWords(text) {
    if (!text) return '';
    return text
      .split(/\s+/)
      .filter(w => {
        const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
        return clean.length > 2 && !STOP_WORDS.has(clean);
      })
      .join(' ');
  }

  const GENERIC_KEYWORD_BLACKLIST = new Set([
    'video', 'sharing', 'camera phone', 'video phone', 'free', 'upload',
    'videos', 'watch', 'online', 'website', 'webpage', 'homepage',
    'official site', 'powered by', 'all rights reserved', 'terms of service',
    'google llc', 'youtube', 'facebook', 'twitter', 'instagram'
  ]);

  // Extracts language indicators, code blocks, framework names, and badge pills from the DOM
  function extractCodeAndTechSignals(doc) {
    const signatures = new Set();
    const harvest = new Set();

    // 0. Title & Heading high-confidence tech keywords (e.g. "Build Enterprise-Grade RAG Applications")
    const titleAndHeadings = `${doc.title || ''} ${(doc.querySelector('h1')?.textContent || '')}`.toLowerCase();
    const TECH_TITLE_REGEX = /\b(rag|llm|api|apis|python|javascript|typescript|react|next\.?js|vue|rust|golang|docker|kubernetes|pytorch|tensorflow|sql|database|databases|backend|frontend|fullstack|devops|machine\s*learning|deep\s*learning|artificial\s*intelligence|neural\s*network|algorithms?|data\s*structures?|tutorial|coding|programming|developer|software\s*engineering)\b/gi;
    let tMatch;
    while ((tMatch = TECH_TITLE_REGEX.exec(titleAndHeadings)) !== null) {
      signatures.add(tMatch[1].toLowerCase());
      harvest.add('coding');
    }

    // 1. Pre, Code, and Syntax Highlighter elements
    const codeElements = Array.from(doc.querySelectorAll('pre, code, [class*="highlight"], [class*="code"], [class*="snippet"]')).slice(0, 15);
    for (const el of codeElements) {
      const txt = (el.textContent || '').trim();
      if (!txt) continue;

      // Package managers & CLI commands
      if (/\b(pip\s+install|npm\s+i|npm\s+install|yarn\s+add|cargo\s+add|gem\s+install|brew\s+install|git\s+clone|docker\s+run)\b/i.test(txt)) {
        harvest.add('coding');
        harvest.add('dev');
      }
      // AI / Data / Language imports & keywords
      if (/\b(import\s+torch|from\s+transformers|import\s+tensorflow|import\s+numpy|import\s+pandas|import\s+react|from\s+fastapi)\b/i.test(txt)) {
        harvest.add('coding');
        signatures.add('python');
        signatures.add('ai');
      }
      if (/\b(function\s*\(|def\s+\w+|const\s+\w+\s*=|class\s+\w+|public\s+static|fn\s+\w+)\b/i.test(txt)) {
        harvest.add('coding');
      }
      // Class name hints (e.g. class="language-python")
      const cls = el.className || '';
      const langMatch = cls.match(/language-([a-z0-9+#]+)/i);
      if (langMatch) {
        signatures.add(langMatch[1].toLowerCase());
        harvest.add('coding');
      }
    }

    // 2. Semantic Badge, Tag, Topic, and Breadcrumb elements
    const badgeElements = Array.from(doc.querySelectorAll('[class*="tag"], [class*="badge"], [class*="pill"], [class*="topic"], [class*="label"], nav[aria-label="breadcrumb"] a')).slice(0, 25);
    for (const b of badgeElements) {
      const text = (b.textContent || '').trim().toLowerCase();
      if (text && text.length > 2 && text.length < 35 && !STOP_WORDS.has(text) && !GENERIC_KEYWORD_BLACKLIST.has(text)) {
        if (!/^(new|beta|pro|like|follow|share|reply|edit|star|watch|fork|sponsor|download)$/i.test(text)) {
          signatures.add(text);
          if (/python|javascript|typescript|c\+\+|rust|golang|java|ruby|php|sql|html|css|rag|llm|api|coding|programming/i.test(text)) {
            harvest.add('coding');
          }
          if (/pytorch|tensorflow|transformers|safetensors|huggingface|llm|dataset|weights|vision-language|nlp|multimodal/i.test(text)) {
            harvest.add('coding');
            harvest.add('science');
          }
        }
      }
    }

    return { signatures: Array.from(signatures), harvestTags: Array.from(harvest) };
  }

  // Clean heading text by stripping nested buttons, SVGs, counter labels
  function getCleanHeadingText(el) {
    if (!el) return '';
    try {
      const clone = el.cloneNode(true);
      const noise = clone.querySelectorAll('button, svg, nav, form, [class*="count"], [class*="btn"], [class*="follow"]');
      noise.forEach(n => n.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    } catch {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }

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
      const docClone = doc.cloneNode(true);
      // Strip navigation, footers, and noise before Readability
      docClone.querySelectorAll('footer, nav, header, aside, [id*="footer"], [class*="footer"], [id*="copyright"], [class*="cookie"], [class*="consent"], ytd-masthead, ytd-guide-renderer, tp-yt-app-drawer').forEach(el => el.remove());
      
      const article = new Readability(docClone).parse();
      if (article && article.textContent) {
        const cleaned = article.textContent.replace(/\s+/g, ' ').trim();
        // Ignore if Readability only captured legal boilerplate
        if (!/About\s*Press\s*Copyright|Terms\s*Privacy\s*Policy|All\s*Rights\s*Reserved/i.test(cleaned)) {
          out.mainText = cleaned.slice(0, CAP_TEXT);
          out.excerpt = (article.excerpt || '').slice(0, 300);
          out.byline = (article.byline || '').slice(0, 100);
          out.extractionLevel = 'full';
        }
      }
    } catch (e) { /* fall through to minimal */ }

    // Fallback if Readability found nothing (SPAs, video pages like YouTube)
    if (!out.mainText) {
      // 1. YouTube & Video SPA specific selectors
      const ytDesc = doc.querySelector('#description-inline-expander, ytd-video-secondary-info-renderer #description, #description.ytd-watch-metadata, [property="og:description"], [name="description"]');
      if (ytDesc) {
        const text = (ytDesc.content || ytDesc.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length > 10 && !/About\s*Press\s*Copyright/i.test(text)) {
          out.mainText = text.slice(0, CAP_TEXT);
          out.excerpt = text.slice(0, 300);
          out.extractionLevel = 'meta-description';
        }
      }

      // 2. Body fallback with aggressive noise stripping
      if (!out.mainText && doc.body) {
        out.extractionLevel = 'body-fallback';
        try {
          const bodyClone = doc.body.cloneNode(true);
          bodyClone.querySelectorAll('script, style, noscript, svg, iframe, template, [aria-hidden="true"], footer, nav, header, aside, form, [id*="footer"], [class*="footer"], [id*="copyright"], [class*="cookie"], [class*="consent"], ytd-masthead, ytd-guide-renderer, tp-yt-app-drawer').forEach(el => el.remove());
          let text = (bodyClone.innerText || bodyClone.textContent || '')
            .replace(/var\s+\w+\s*=\s*\{[\s\S]*?\};?/g, ' ')
            .replace(/\{"responseContext"[\s\S]*?\}/g, ' ')
            .replace(/About\s*Press\s*Copyright[\s\S]*?Google\s*LLC/gi, ' ')
            .replace(/Terms\s*Privacy\s*Policy\s*&\s*Safety/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          if (text && !/About\s*Press\s*Copyright/i.test(text)) {
            out.mainText = text.slice(0, CAP_TEXT);
          }
        } catch (e) {
          // Fall back to clean title/meta
        }
      }
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
    if (!out.excerpt) out.excerpt = (meta('meta[property="og:description"]') || meta('meta[name="description"]')).slice(0, 500);
    
    // Author / Channel / Creator signals
    const authorMeta = meta('meta[name="author"]') || meta('meta[property="og:article:author"]') || meta('meta[property="og:site_name"]');
    if (authorMeta && !GENERIC_KEYWORD_BLACKLIST.has(authorMeta.toLowerCase())) {
      people.add(authorMeta.trim().slice(0, 80));
    }

    // Video Tags (YouTube puts creator hashtags & topics in og:video:tag)
    for (const tagEl of doc.querySelectorAll('meta[property="og:video:tag"], meta[property="video:tag"]')) {
      const vTag = (tagEl.content || '').trim().toLowerCase().slice(0, 50);
      if (vTag && !GENERIC_KEYWORD_BLACKLIST.has(vTag) && !STOP_WORDS.has(vTag)) {
        keywords.add(vTag);
      }
    }

    const metaKw = meta('meta[name="keywords"]');
    if (metaKw) {
      metaKw.split(',').forEach(k => {
        const cleanK = k.trim().toLowerCase().slice(0, 50);
        if (cleanK && !GENERIC_KEYWORD_BLACKLIST.has(cleanK) && !STOP_WORDS.has(cleanK)) {
          keywords.add(cleanK);
        }
      });
    }

    // article:section / og:article:section -> topic tag
    const section = meta('meta[property="article:section"]') || meta('meta[property="og:article:section"]');
    if (section) harvestTags.add(section.trim().toLowerCase().slice(0, 30));

    // Wikipedia human-curated categories (#mw-normal-catlinks)
    for (const a of doc.querySelectorAll('#mw-normal-catlinks a[href^="/wiki/Category:"]')) {
      const name = (a.textContent || '').trim().toLowerCase();
      if (name) keywords.add(name.slice(0, 50));
    }

    // --- Structural Code, Language & Badge Extraction ---
    const { signatures, harvestTags: codeHarvest } = extractCodeAndTechSignals(doc);
    signatures.forEach(s => keywords.add(s));
    codeHarvest.forEach(h => harvestTags.add(h));

    // --- High-Density Pseudo-document for embedding ---
    const pseudoParts = [];
    const title = out.title || '';
    if (title) pseudoParts.push(title, title);
    
    try {
      const pathTokens = loc.pathname.split(/[/\-_]+/).filter(t => t && t.length > 1);
      if (pathTokens.length) pseudoParts.push(pathTokens.join(' '));
    } catch (e) {}
    
    // Clean Headings
    const h1Text = getCleanHeadingText(doc.querySelector('h1'));
    if (h1Text && h1Text !== title) pseudoParts.push(h1Text.slice(0, 120));
    
    const h2s = Array.from(doc.querySelectorAll('h2')).slice(0, 3);
    for (const h2 of h2s) {
      const t = getCleanHeadingText(h2);
      if (t) pseudoParts.push(t.slice(0, 80));
    }

    // Extracted Signatures / Badges
    if (signatures.length) {
      pseudoParts.push(signatures.slice(0, 10).join(' '));
    }

    // Filtered keyword-dense excerpt/mainText (stripping stop words for high signal)
    if (out.mainText) {
      const filteredDenseText = filterStopWords(out.mainText).slice(0, 450);
      if (filteredDenseText) pseudoParts.push(filteredDenseText);
    } else if (out.excerpt) {
      pseudoParts.push(filterStopWords(out.excerpt).slice(0, 200));
    }

    // Local Zero-Network Named Entity Recognition (NER)
    out.entities = extractLocalEntities(doc, out);

    out.pseudoDoc = pseudoParts.filter(Boolean).join(' | ').slice(0, 800);
    out.harvestTags = Array.from(harvestTags);
    out.structured.people = Array.from(people).slice(0, CAP_PEOPLE);
    out.structured.keywords = Array.from(keywords).slice(0, CAP_KEYWORDS);
    return out;
  }

  function extractLocalEntities(doc, out) {
    const entities = new Map();

    const addEntity = (name, type, confidence = 0.95) => {
      if (!name) return;
      const clean = String(name).trim();
      if (clean.length < 2 || clean.length > 80) return;
      const key = clean.toLowerCase();
      if (STOP_WORDS.has(key)) return;
      if (!entities.has(key) || entities.get(key).confidence < confidence) {
        entities.set(key, { name: clean, type, confidence });
      }
    };

    // 1. Structured JSON-LD entities
    if (out.structured) {
      if (out.structured.people) {
        out.structured.people.forEach(p => addEntity(p, 'person', 0.99));
      }
      if (out.structured.headline) {
        addEntity(out.structured.headline, 'work', 0.90);
      }
      if (out.structured.type) {
        addEntity(out.structured.type, 'category', 0.90);
      }
    }

    // 2. Known patterns & dictionaries from title and mainText
    const combinedText = `${out.title || ''} ${out.mainText ? out.mainText.slice(0, 1000) : ''}`;

    // Common technology & frameworks
    const TECH_REGEX = /\b(Python|JavaScript|TypeScript|Rust|C\+\+|Java|Golang|PyTorch|TensorFlow|React|Next\.?js|Vue|Django|FastAPI|PostgreSQL|SQLite|Docker|Kubernetes|Linux|Git|Transformers|Hugging\s*Face)\b/gi;
    let match;
    while ((match = TECH_REGEX.exec(combinedText)) !== null) {
      addEntity(match[1], 'tech', 0.95);
    }

    // Major awards & accolades
    const AWARD_REGEX = /\b(Academy\s*Award|Oscar|Golden\s*Globe|BAFTA|Emmy|Grammy|Nobel\s*Prize|Pulitzer)\b/gi;
    while ((match = AWARD_REGEX.exec(combinedText)) !== null) {
      addEntity(match[1], 'award', 0.98);
    }

    // Years (e.g. 1990 - 2030)
    const YEAR_REGEX = /\b(19\d\d|20[0-2]\d)\b/g;
    while ((match = YEAR_REGEX.exec(combinedText)) !== null) {
      addEntity(match[1], 'year', 0.85);
    }

    // Capitalized multi-word person / work names from title (e.g. "Philip Seymour Hoffman")
    const NAME_REGEX = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
    while ((match = NAME_REGEX.exec(out.title || '')) !== null) {
      const candidate = match[1];
      if (!/^(YouTube|Google|GitHub|Stack\s*Overflow|Microsoft|Reddit|Wikipedia|Hugging\s*Face|Daily\s*Mail|New\s*York\s*Times)$/i.test(candidate)) {
        addEntity(candidate, 'person_or_work', 0.80);
      }
    }

    return Array.from(entities.values()).slice(0, 30);
  }

  globalThis.__tsExtract = __tsExtract;
  globalThis.filterStopWords = filterStopWords;
  globalThis.extractLocalEntities = extractLocalEntities;
})();
