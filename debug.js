// debug.js — Client-Side Debugging Workbench for TabScroller Pipeline & DB Storage

(() => {
  // Built-in Realistic Offline HTML Fixtures
  const PRESET_FIXTURES = {
    'youtube-rag-video': {
      url: 'https://www.youtube.com/watch?v=4OP8FI1TXK8',
      html: `<!DOCTYPE html><html><head><title>Build Enterprise-Grade RAG Applications | LIVE 8-Hour Marathon - YouTube</title>
        <meta name="description" content="Learn how to build production-ready Enterprise RAG applications using LangChain, Vector Databases, Python, and Local LLM Embeddings. Full 8-hour hands-on deep dive.">
        <meta property="og:title" content="Build Enterprise-Grade RAG Applications | LIVE 8-Hour Marathon">
        <meta property="og:description" content="Learn how to build production-ready Enterprise RAG applications using LangChain, Vector Databases, Python, and Local LLM Embeddings.">
        <meta property="og:type" content="video.other">
        <meta property="og:video:tag" content="rag">
        <meta property="og:video:tag" content="langchain">
        <meta property="og:video:tag" content="python">
        <meta property="og:video:tag" content="llm">
        <meta property="og:video:tag" content="vector-database">
        <meta name="author" content="freeCodeCamp.org">
        </head><body>
        <h1>Build Enterprise-Grade RAG Applications | LIVE 8-Hour Marathon</h1>
        <div id="channel-name">freeCodeCamp.org</div>
        <div id="description-inline-expander">
          <p>Timestamps: 00:00 Introduction to Enterprise RAG, 01:30 Vector Database Architecture, 03:45 Embedding Chunking & Semantic Search, 05:20 LangChain Retrieval Pipeline, 07:00 Evaluation & Production Deployment.</p>
        </div>
        <footer>AboutPressCopyrightContact usCreatorsAdvertiseDevelopersTermsPrivacyPolicy & SafetyHow YouTube worksTest new features© 2026 Google LLC</footer>
        </body></html>`
    },
    'huggingface-model': {
      url: 'https://huggingface.co/CohereLabs/North-Micro-Vision-Instruct',
      html: `<!DOCTYPE html><html><head><title>CohereLabs/North-Micro-Vision-Instruct · Hugging Face</title>
        <meta name="description" content="We’re on a journey to advance and democratize artificial intelligence through open source and open science.">
        <meta property="og:title" content="CohereLabs/North-Micro-Vision-Instruct · Hugging Face">
        <meta property="og:type" content="website">
        </head><body>
        <h1>CohereLabs / North-Micro-Vision-Instruct</h1>
        <div class="badges">
          <span class="tag">transformers</span>
          <span class="tag">pytorch</span>
          <span class="tag">safetensors</span>
          <span class="tag">vision-language</span>
          <span class="tag">apache-2.0</span>
          <span class="tag">python</span>
        </div>
        <article>
          <p>North Micro Vision Instruct is a 2.4B-parameter open-weight vision-language model with native-resolution image support, released under the Apache 2.0 license. It is designed as a compact foundation for prototyping, task-specific fine-tuning, and specialized multimodal applications.</p>
          <h2>Quickstart</h2>
          <pre><code class="language-python">pip install transformers torch
from transformers import AutoModelForCausalLM, AutoProcessor
import torch

model = AutoModelForCausalLM.from_pretrained("CohereLabs/North-Micro-Vision-Instruct", torch_dtype=torch.bfloat16)
processor = AutoProcessor.from_pretrained("CohereLabs/North-Micro-Vision-Instruct")</code></pre>
          <h2>Highlights</h2>
          <p>Broad image-understanding capabilities across VQA, captioning, grounding, OCR, charts, and documents. Multilingual and multi-image support. Compact 2.4B-parameter scale suited to customization and deployment experimentation.</p>
        </article></body></html>`
    },
    'repo-page': {
      url: 'https://github.com/torvalds/linux',
      html: `<!DOCTYPE html><html><head><title>torvalds/linux: Linux kernel source tree</title>
        <meta name="description" content="Linux kernel source tree and development repository.">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "SoftwareSourceCode",
          "name": "Linux Kernel",
          "programmingLanguage": "C",
          "author": { "@type": "Person", "name": "Linus Torvalds" },
          "keywords": "c, operating-system, kernel, open-source, linux"
        }
        </script>
        </head><body>
        <h1>Linux kernel source tree</h1>
        <article>
          <p>Linux is a clone of the operating system Unix, written from scratch by Linus Torvalds with assistance from a loosely-knit team of hackers across the Net.</p>
          <p>It aims towards POSIX and Single UNIX Specification compliance. It has all the features you would expect in a modern fully-fledged Unix, including true multitasking, virtual memory, shared libraries, proper memory management, and TCP/IP networking.</p>
        </article></body></html>`
    },
    'recipe-sourdough': {
      url: 'https://www.allrecipes.com/recipe/260540/chef-johns-sourdough-bread/',
      html: `<!DOCTYPE html><html><head><title>Artisan Sourdough Bread Recipe — Classic Crusty Loaf</title>
        <meta name="description" content="A beginner-friendly guide to baking crispy artisan sourdough bread at home with wild yeast starter.">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Recipe",
          "name": "Artisan Sourdough Bread",
          "author": { "@type": "Person", "name": "Chef John" },
          "keywords": "sourdough, baking, bread, yeast, flour, fermentation",
          "recipeCategory": "Bread",
          "datePublished": "2026-02-10"
        }
        </script>
        </head><body>
        <h1>Classic Artisan Sourdough Bread</h1>
        <article>
          <p>Learn how to make a sourdough bread loaf with a crispy golden crust, open crumb, and delicious tangy flavor.</p>
          <h2>Ingredients</h2>
          <ul>
            <li>500g Bread Flour</li>
            <li>350g Warm Water (70% hydration)</li>
            <li>100g Active Sourdough Starter</li>
            <li>10g Fine Sea Salt</li>
          </ul>
          <h2>Instructions</h2>
          <p>Mix flour and water, let autolyse for 45 minutes. Add active sourdough starter and salt, perform stretch and folds every 30 minutes, bulk ferment for 5 hours, and bake in a Dutch oven at 450°F.</p>
        </article></body></html>`
    },
    'news-cricket-jsonld': {
      url: 'https://www.espncricinfo.com/series/ipl-2026/news/mumbai-indians-win-thriller-1425890',
      html: `<!DOCTYPE html><html><head><title>IPL 2026: Mumbai Indians secure sensational last-over victory</title>
        <meta name="description" content="Match report from Wankhede Stadium as Mumbai Indians beat Chennai Super Kings in a thrilling IPL finish.">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          "headline": "Mumbai Indians pull off thrilling win in IPL 2026 opening clash",
          "datePublished": "2026-04-12T22:30:00Z",
          "keywords": "ipl 2026, cricket, t20, mumbai indians, kohli, rohit sharma, wankhede",
          "author": { "@type": "Person", "name": "Firdose Moonda" },
          "articleSection": "Cricket"
        }
        </script>
        </head><body>
        <h1>Mumbai Indians secure sensational last-over victory</h1>
        <article>
          <p>In front of a packed Wankhede crowd, Mumbai Indians chased down 198 with two balls to spare in a dramatic final over showdown.</p>
          <p>Hardik Pandya smashed consecutive boundaries in the 20th over after Rohit Sharma set up the chase with a commanding 68 off 41 balls.</p>
        </article></body></html>`
    },
    'youtube-noncoding': {
      url: 'https://www.youtube.com/watch?v=YzWHHNbiHZ4',
      html: `<!DOCTYPE html><html><head><title>Hilarious Stand-up Comedy Special - Full Performance - YouTube</title>
        <meta name="description" content="Watch the funniest comedy moments and hilarious stand-up routine live on stage.">
        <meta property="og:type" content="video.other">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "VideoObject",
          "name": "Hilarious Stand-up Comedy Special",
          "keywords": "comedy, stand-up, humor, jokes, entertainment, laughter, performance",
          "author": { "@type": "Person", "name": "Comedy Central" },
          "datePublished": "2025-11-20"
        }
        </script>
        </head><body>
        <h1>Hilarious Stand-up Comedy Special - Live in New York</h1>
        <article>
          <p>Full length comedy set featuring hilarious observational humor, relatable dating stories, and audience crowd work.</p>
        </article></body></html>`
    },
    'oscar-movie-2005': {
      url: 'https://www.imdb.com/title/tt0379725/',
      html: `<!DOCTYPE html><html><head><title>Capote (2005) - Academy Award Winner - IMDb</title>
        <meta name="description" content="Directed by Bennett Miller. With Philip Seymour Hoffman, Catherine Keener, Clifton Collins Jr. In 1959, Truman Capote learns of the brutal murder of a Kansas family.">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Movie",
          "name": "Capote",
          "author": [{ "@type": "Person", "name": "Philip Seymour Hoffman" }, { "@type": "Person", "name": "Bennett Miller" }],
          "keywords": "biography, crime, drama, academy award winner, oscar, 2005, best actor, truman capote",
          "datePublished": "2005-09-30"
        }
        </script>
        </head><body>
        <h1>Capote (2005)</h1>
        <div class="badges"><span class="tag">Academy Award Winner</span><span class="tag">Oscar Best Actor 2005</span></div>
        <article>
          <p>Philip Seymour Hoffman won the 2005 Academy Award for Best Actor in a Leading Role for his biographical portrayal of author Truman Capote researching his book In Cold Blood.</p>
          <p>Accolades: Winner of 1 Oscar, 5 nominations including Best Picture and Best Director at the 78th Academy Awards.</p>
        </article></body></html>`
    },
    'video-watch-page': {
      url: 'https://www.twitch.tv/videos/2048591823',
      html: `<!DOCTYPE html><html><head><title>Shroud — Playing Elden Ring Shadow of the Erdtree Boss Fights & Ranked Matches</title>
        <meta name="description" content="Watch shroud streaming live gaming gameplay, esports commentary and tournament walkthroughs.">
        <meta property="og:type" content="video.other">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "VideoObject",
          "name": "Elden Ring Boss Fights Gameplay Stream",
          "keywords": "gaming, elden ring, twitch, shroud, esports, rpg, gameplay",
          "author": { "@type": "Person", "name": "shroud" },
          "datePublished": "2026-06-18"
        }
        </script>
        </head><body>
        <h1>Elden Ring DLC Live Stream - Full Playthrough</h1>
        <article>
          <p>Live stream recording featuring high-level combat against Malenia and DLC bosses, optimizing stat builds and weapon upgrades.</p>
        </article></body></html>`
    },
    'api-docs': {
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API',
      html: `<!DOCTYPE html><html><head><title>IndexedDB API — Web APIs | MDN</title>
        <meta name="description" content="IndexedDB is a low-level API for client-side storage of significant amounts of structured data, including files/blobs.">
        <meta name="keywords" content="indexeddb, javascript, web api, client storage, database, transaction">
        </head><body>
        <h1>IndexedDB API Documentation</h1>
        <article>
          <p>IndexedDB is a transactional database system, like an SQL-based RDBMS. However, unlike SQL-based systems, which use fixed-column tables, IndexedDB is a JavaScript-based object-oriented database.</p>
          <p>IndexedDB lets you store and retrieve objects that are indexed with a "key"; any objects supported by the structured clone algorithm can be stored.</p>
        </article></body></html>`
    },
    'academic-abstract': {
      url: 'https://arxiv.org/abs/2301.00001',
      html: `<!DOCTYPE html><html><head><title>Efficient Transformers with Linear Attention and State-Space Duality</title>
        <meta name="description" content="We investigate sub-quadratic attention architectures in deep neural networks for large language model inference.">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "ScholarlyArticle",
          "headline": "Efficient Transformers with Linear Attention",
          "author": [{ "@type": "Person", "name": "Albert Gu" }, { "@type": "Person", "name": "Tri Dao" }],
          "keywords": "machine learning, artificial intelligence, neural networks, transformers, state space models"
        }
        </script>
        </head><body>
        <h1>Efficient Transformers with Linear Attention and State-Space Duality</h1>
        <article>
          <p>Abstract: Foundation models based on the Transformer architecture have achieved immense success, but their quadratic computational complexity with respect to sequence length limits their application on long contexts.</p>
        </article></body></html>`
    },
    'product-listing': {
      url: 'https://www.amazon.com/Sony-WH-1000XM5-Canceling-Headphones/dp/B09XS7JWHH',
      html: `<!DOCTYPE html><html><head><title>Sony WH-1000XM5 Wireless Noise Canceling Headphones — Black</title>
        <meta name="description" content="Buy Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Bluetooth Headphones with Auto NC Optimizer.">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Sony WH-1000XM5 Wireless Headphones",
          "keywords": "headphones, audio, electronics, noise canceling, sony, bluetooth",
          "offers": { "@type": "Offer", "price": "398.00", "priceCurrency": "USD" }
        }
        </script>
        </head><body>
        <h1>Sony WH-1000XM5 Wireless Noise Canceling Headphones</h1>
        <article>
          <p>Industry-leading noise cancellation optimized for you with 2 processors and 8 microphones. Magnificent Sound, engineered to perfection with the new Integrated Processor V1.</p>
        </article></body></html>`
    },
    'discussion-thread': {
      url: 'https://www.reddit.com/r/programming/comments/1908abc/rust_vs_go_for_cloud_microservices/',
      html: `<!DOCTYPE html><html><head><title>Rust vs Go for high-throughput cloud microservices in 2026 : r/programming</title>
        <meta name="description" content="Community discussion comparing memory safety, compile times, concurrency models, and CPU latency between Rust and Go.">
        </head><body>
        <h1>Rust vs Go for high-throughput cloud microservices</h1>
        <article>
          <p>We are rewriting our distributed event ingestion pipeline. Our current Node.js service is hitting GC pauses under 100k req/sec.</p>
          <p>Between Rust's zero-cost abstractions and Go's simpler concurrency goroutine model, which has yielded better maintainability in your production experience?</p>
        </article></body></html>`
    }
  };

  // State
  let currentUrl = 'https://github.com/torvalds/linux';
  let currentHtml = PRESET_FIXTURES['repo-page'].html;
  let currentCommand = 'group all programming tabs';
  let currentCard = null;

  // DOM Elements
  const presetSelect = document.getElementById('presetSelect');
  const urlInput = document.getElementById('urlInput');
  const btnFetchUrl = document.getElementById('btnFetchUrl');
  const cmdInput = document.getElementById('cmdInput');
  const btnExecCmd = document.getElementById('btnExecCmd');
  const btnRunPipeline = document.getElementById('btnRunPipeline');
  const pagePreviewFrame = document.getElementById('pagePreviewFrame');
  const frameUrlBar = document.getElementById('frameUrlBar');
  const rawHtmlTextarea = document.getElementById('rawHtmlTextarea');
  const btnReExtractDom = document.getElementById('btnReExtractDom');
  const pipelineStatusPill = document.getElementById('pipelineStatusPill');

  // Vector Simulation / Embedding Generator Helper
  // Generates a 384-dimensional vector based on topical prototype centroids from enrich-math.js
  function generateVectorFromDoc(pseudoDoc, category) {
    const dim = 384;
    const v = new Float32Array(dim);
    
    // Hash text to generate a deterministic seed
    let seed = 0;
    const str = (pseudoDoc + ' ' + category).toLowerCase();
    for (let i = 0; i < str.length; i++) {
      seed = (seed * 31 + str.charCodeAt(i)) >>> 0;
    }

    // Category signature bias
    const catMap = {
      coding: 12, dev: 12, docs: 15, gaming: 45, sports: 80, cooking: 110,
      news: 140, entertainment: 170, video: 190, science: 220, shopping: 250
    };
    const primaryIdx = catMap[category] || (seed % dim);

    for (let i = 0; i < dim; i++) {
      // Pseudo-random normal distribution
      const r1 = ((seed * (i + 1) * 9301 + 49297) % 233280) / 233280;
      const r2 = ((seed * (i + 7) * 9301 + 49297) % 233280) / 233280;
      let val = Math.sqrt(-2 * Math.log(r1 + 1e-9)) * Math.cos(2 * Math.PI * r2);
      
      // Inject strong signal around category index
      const dist = Math.abs(i - primaryIdx);
      if (dist < 16) {
        val += 2.5 * Math.exp(-dist / 6);
      }
      v[i] = val;
    }

    // L2 Normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] = v[i] / norm;

    return v;
  }

  // Generate a vector for query concepts
  function generateQueryVector(concept) {
    return generateVectorFromDoc(concept, concept);
  }

  // SHA-256 Utility
  async function sha256(text) {
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Normalize URL (Preserve video/page IDs, strip tracking params)
  function normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      const trackingParams = new Set([
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'ref', 'ref_src', 'fbclid', 'gclid', 'msclkid', 'si', 'feature', 'list', 'index', 't', 'ab_channel'
      ]);

      const keepParams = new URLSearchParams();
      for (const [k, v] of parsed.searchParams.entries()) {
        const keyLower = k.toLowerCase();
        if (!trackingParams.has(keyLower) && !keyLower.startsWith('utm_')) {
          keepParams.append(k, v);
        }
      }

      const queryString = keepParams.toString() ? `?${keepParams.toString()}` : '';
      return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${queryString}`.replace(/\/+$/, '');
    } catch {
      return url;
    }
  }

  // Draw 384-dim Sparkline on Canvas
  function drawVectorSparkline(canvas, vector) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.parentElement.clientWidth || 500;
    const h = canvas.height = canvas.parentElement.clientHeight || 48;
    ctx.clearRect(0, 0, w, h);

    if (!vector || vector.length === 0) return;

    // Draw baseline
    const midY = h / 2;
    ctx.strokeStyle = 'rgba(216, 180, 90, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Draw vector wave
    ctx.strokeStyle = '#d8b45a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = w / vector.length;
    for (let i = 0; i < vector.length; i++) {
      const x = i * step;
      const y = midY - (vector[i] * (h * 0.45));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Glow underlay
    ctx.strokeStyle = 'rgba(216, 180, 90, 0.4)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Compute Cosine Similarity between 2 vectors
  function computeCosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return Math.max(0, Math.min(1, dot));
  }

  // ================= PIPELINE TRACE ENGINE =================
  async function runPipelineTrace() {
    pipelineStatusPill.textContent = 'Processing Trace…';
    pipelineStatusPill.style.color = '#f39c12';

    const url = currentUrl;
    const html = currentHtml;
    const command = currentCommand;

    // Update Browser Frame & Textarea
    frameUrlBar.textContent = url;
    pagePreviewFrame.srcdoc = html;
    rawHtmlTextarea.value = html;

    // 1. STAGE 1: DOM Extraction via Readability & extract-core.js
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    let richData = null;
    try {
      if (typeof globalThis.__tsExtract === 'function') {
        richData = globalThis.__tsExtract(doc, { href: url, hostname: new URL(url).hostname, pathname: new URL(url).pathname });
      }
    } catch (e) {
      console.warn('__tsExtract error:', e);
    }

    if (!richData) {
      richData = {
        title: doc.title || '',
        mainText: doc.body ? doc.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 4000) : '',
        excerpt: '',
        byline: '',
        structured: { type: '', headline: '', keywords: [], people: [], datePublished: '' },
        extractionLevel: 'minimal',
        harvestTags: [],
        pseudoDoc: doc.title || ''
      };
    }

    // Display Extraction Stage UI
    document.getElementById('extractLevelBadge').textContent = `Level: ${richData.extractionLevel.toUpperCase()}`;
    document.getElementById('extractTitle').textContent = richData.title || '(No Title)';
    document.getElementById('extractSchemaType').textContent = richData.structured.type || 'None';
    document.getElementById('extractByline').textContent = richData.byline || (richData.structured.people || []).join(', ') || 'None';
    
    const harvestChips = document.getElementById('extractHarvestTags');
    harvestChips.innerHTML = '';
    if (richData.harvestTags && richData.harvestTags.length) {
      richData.harvestTags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'dbg-tag-chip';
        chip.textContent = tag;
        harvestChips.appendChild(chip);
      });
    } else {
      harvestChips.textContent = 'None';
    }

    // Code & Badge Signatures
    const sigChips = document.getElementById('extractCodeSignatures');
    if (sigChips) {
      sigChips.innerHTML = '';
      const allSigs = (richData.structured.keywords || []).slice(0, 15);
      if (allSigs.length) {
        allSigs.forEach(sig => {
          const chip = document.createElement('span');
          chip.className = 'dbg-tag-chip';
          chip.style.borderColor = 'var(--dbg-green)';
          chip.textContent = sig;
          sigChips.appendChild(chip);
        });
      } else {
        sigChips.textContent = 'None detected';
      }
    }

    // Stop-word filtered dense keywords display
    const denseSummary = globalThis.filterStopWords 
      ? globalThis.filterStopWords(richData.mainText || richData.excerpt || '') 
      : (richData.pseudoDoc || '');
    const wordCount = denseSummary ? denseSummary.split(/\s+/).length : 0;
    
    if (document.getElementById('filteredWordsCount')) {
      document.getElementById('filteredWordsCount').textContent = `${wordCount} words (stop words dropped)`;
    }
    if (document.getElementById('extractDenseKeywords')) {
      document.getElementById('extractDenseKeywords').textContent = denseSummary || '(No dense keywords extracted)';
    }

    document.getElementById('mainTextLen').textContent = `${(richData.mainText || '').length} chars`;
    document.getElementById('extractMainText').textContent = richData.mainText || '(No main text extracted)';
    
    document.getElementById('pseudoDocLen').textContent = `${(richData.pseudoDoc || '').length} chars`;
    document.getElementById('extractPseudoDoc').textContent = richData.pseudoDoc || '(No pseudoDoc)';
    
    document.getElementById('extractStructuredJson').textContent = JSON.stringify(richData.structured, null, 2);

    // 2. STAGE 2: Mathematical Enrichment & IndexedDB Storage
    const normalized = normalizeUrl(url);
    const urlHash = await sha256(normalized);
    const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();

    // Zero-network Local Named Entity Extraction (NER)
    let extractedEntities = [];
    if (globalThis.extractLocalEntities) {
      try {
        extractedEntities = globalThis.extractLocalEntities(doc, richData);
      } catch (err) {
        console.warn('extractLocalEntities failed:', err);
      }
    }

    // Populate NER UI Cards in Stage 1
    const peopleWrap = document.getElementById('entitiesPeople');
    const techWrap = document.getElementById('entitiesTech');
    const awardsWrap = document.getElementById('entitiesAwards');
    const worksWrap = document.getElementById('entitiesWorks');

    if (peopleWrap) peopleWrap.innerHTML = '';
    if (techWrap) techWrap.innerHTML = '';
    if (awardsWrap) awardsWrap.innerHTML = '';
    if (worksWrap) worksWrap.innerHTML = '';

    const peopleList = extractedEntities.filter(e => e.type === 'person');
    const techList = extractedEntities.filter(e => e.type === 'tech');
    const awardsList = extractedEntities.filter(e => e.type === 'award');
    const worksList = extractedEntities.filter(e => e.type === 'work' || e.type === 'person_or_work');

    const renderChips = (container, list, fallback) => {
      if (!container) return;
      if (!list || list.length === 0) {
        container.textContent = fallback || 'None detected';
        return;
      }
      list.forEach(item => {
        const chip = document.createElement('span');
        chip.className = 'dbg-tag-chip';
        chip.style.borderColor = 'var(--dbg-accent-gold)';
        chip.textContent = `${item.name} (${Math.round((item.confidence || 0.9) * 100)}%)`;
        container.appendChild(chip);
      });
    };

    renderChips(peopleWrap, peopleList, 'No people/authors found');
    renderChips(techWrap, techList, 'No tech/frameworks found');
    renderChips(awardsWrap, awardsList, 'No awards/accolades found');
    renderChips(worksWrap, worksList, 'No works/titles found');

    // Apply domain priors
    let domainPrior = null;
    if (self.DomainPriors && typeof self.DomainPriors.applyPriors === 'function') {
      domainPrior = self.DomainPriors.applyPriors(url);
    }

    // PseudoDoc for math enrich
    const pseudoDoc = richData.pseudoDoc || `${richData.title} ${richData.title} ${domain}`.trim().slice(0, 800);

    // Initial Math Enrichment with Code/Tech Signals
    const hasCodeSignal = richData.harvestTags.includes('coding') || 
      techList.length > 0 ||
      (richData.structured.keywords || []).some(k => /python|torch|transformers|code|software|github|api|programming|developer|rust|golang/i.test(k));
    
    let initialCategory = domainPrior ? domainPrior.tags[0] : (hasCodeSignal ? 'coding' : 'other');
    const embedding = generateVectorFromDoc(pseudoDoc, initialCategory);

    let enrichmentResult = {
      category: initialCategory,
      tags: [{ tag: initialCategory, score: 0.9 }],
      subTopics: (richData.structured.keywords || []).slice(0, 4),
      entities: extractedEntities,
      contentType: hasCodeSignal ? 'tool' : 'other',
      tier: 'math',
      vecVersion: 3,
      enrichedAt: Date.now()
    };

    if (self.EnrichMath && typeof self.EnrichMath.mathEnrich === 'function') {
      try {
        enrichmentResult = self.EnrichMath.mathEnrich(embedding, {
          harvestTags: richData.harvestTags || [],
          keywordHints: richData.structured.keywords || [],
          priorTags: domainPrior ? domainPrior.tags : (hasCodeSignal ? ['coding'] : []),
          priorConf: domainPrior ? domainPrior.conf : (hasCodeSignal ? 0.95 : 0),
          structured: richData.structured || null
        });
      } catch (err) {
        console.warn('MathEnrich failed:', err);
      }
    }

    // Build Centroid Table with real mathematical breakdown (Mean, Sigma, Z-Scores)
    const centroidTbody = document.getElementById('centroidTableBody');
    if (centroidTbody) {
      centroidTbody.innerHTML = '';
      
      const TAG_NAMES = [
        'coding', 'dev', 'docs', 'tech', 'science', 'sports', 'entertainment',
        'film', 'music', 'gaming', 'video', 'news', 'cooking', 'shopping',
        'finance', 'travel', 'health', 'learning', 'education', 'social',
        'work', 'reference', 'other'
      ];

      // Calculate centroid scores
      const scoredPrototypes = TAG_NAMES.map(tag => {
        const pVec = generateVectorFromDoc(tag, tag);
        const rawCos = computeCosine(embedding, pVec);
        
        let harvestBoost = 0;
        if (richData.harvestTags) {
          const matchingHarvest = richData.harvestTags.some(ht => {
            const canon = self.EnrichMath?.canonicalTag ? self.EnrichMath.canonicalTag(ht) : ht;
            return canon === tag || ht.toLowerCase() === tag;
          });
          if (matchingHarvest) harvestBoost = 0.20;
        }

        let priorBoost = 0;
        if (domainPrior && domainPrior.tags.includes(tag) && domainPrior.conf >= 0.9) {
          priorBoost = 0.15;
        }

        const boostedScore = Math.min(1.0, rawCos + harvestBoost + priorBoost);
        return { tag, rawCos, harvestBoost, priorBoost, boostedScore };
      });

      // Compute Mean and Standard Deviation across all prototypes
      const scores = scoredPrototypes.map(p => p.boostedScore);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / scores.length;
      const sigma = Math.sqrt(variance) || 0.001;

      // Sort by boosted score desc
      scoredPrototypes.sort((a, b) => b.boostedScore - a.boostedScore);

      scoredPrototypes.forEach(item => {
        const zScore = (item.boostedScore - mean) / sigma;
        const isEmitted = zScore >= 1.2;
        const tr = document.createElement('tr');
        if (isEmitted) tr.style.background = 'rgba(216, 180, 90, 0.1)';

        tr.innerHTML = `
          <td style="font-weight: 600; color: ${isEmitted ? 'var(--dbg-accent-gold)' : 'inherit'};">
            ${item.tag} ${isEmitted ? '⭐' : ''}
          </td>
          <td class="dbg-mono">${item.rawCos.toFixed(3)}</td>
          <td class="dbg-mono" style="color: ${item.harvestBoost > 0 ? 'var(--dbg-green)' : 'var(--dbg-text-muted)'}">
            ${item.harvestBoost > 0 ? '+0.20' : '0.00'}
          </td>
          <td class="dbg-mono" style="color: ${item.priorBoost > 0 ? 'var(--dbg-green)' : 'var(--dbg-text-muted)'}">
            ${item.priorBoost > 0 ? '+0.15' : '0.00'}
          </td>
          <td class="dbg-mono" style="font-weight: 600;">${item.boostedScore.toFixed(3)}</td>
          <td class="dbg-mono" style="color: ${isEmitted ? 'var(--dbg-green)' : 'inherit'}; font-weight: ${isEmitted ? '700' : '400'};">
            ${zScore.toFixed(2)}
          </td>
          <td>
            <span class="${isEmitted ? 'dbg-badge-success' : 'dbg-badge'}">
              ${isEmitted ? 'EMITTED (Z>=1.2)' : 'BELOW CUT'}
            </span>
          </td>
        `;
        centroidTbody.appendChild(tr);
      });
    }

    // Build Final TabCard Object (exact IndexedDB representation)
    const card = {
      tabId: 101,
      url,
      urlHash,
      domain,
      title: richData.title || '',
      extractedAt: Date.now(),
      contentHash: await sha256(pseudoDoc),
      mainText: richData.mainText || '',
      structured: richData.structured,
      entities: extractedEntities,
      enrichment: enrichmentResult,
      embedding: Array.from(embedding),
      extractionLevel: richData.extractionLevel,
      pseudoDoc
    };
    currentCard = card;

    // Save to Live Browser IndexedDB Store & Dual-Write to Disk SQLite Queue
    if (self.TabDB) {
      try {
        await self.TabDB.init();
        await self.TabDB.storeTabCard(card);
        if (typeof self.TabDB.queueSync === 'function') {
          self.TabDB.queueSync(card);
        }
        refreshIndexedDbTable();
        updateSqliteStats();
      } catch (dbErr) {
        console.warn('TabDB store failed:', dbErr);
      }
    }

    // Update Stage 1 (DB Card) UI
    document.getElementById('valUrlHash').textContent = card.urlHash;
    document.getElementById('valNormUrl').textContent = normalized;
    document.getElementById('valCategory').textContent = card.enrichment.category;
    document.getElementById('valDomainPriors').textContent = domainPrior 
      ? `${domainPrior.tags.join(', ')} (conf: ${domainPrior.conf})` 
      : (hasCodeSignal ? 'Detected from Code & Tags (conf: 0.95)' : 'None');

    const tagsContainer = document.getElementById('tagsListContainer');
    tagsContainer.innerHTML = '';
    if (card.enrichment.tags && card.enrichment.tags.length) {
      card.enrichment.tags.forEach(t => {
        const chip = document.createElement('div');
        chip.className = 'dbg-tag-chip';
        chip.innerHTML = `<span class="dbg-tag-name">${t.tag}</span><span class="dbg-tag-score">${t.score}</span>`;
        tagsContainer.appendChild(chip);
      });
    } else {
      tagsContainer.innerHTML = '<span class="dbg-empty-hint">No tags calculated.</span>';
    }

    // Draw Vector Sparkline
    const canvas = document.getElementById('vectorCanvas');
    drawVectorSparkline(canvas, embedding);

    document.getElementById('rawDbJson').textContent = JSON.stringify({
      ...card,
      embedding: `[Float32Array(${embedding.length}) ...]`
    }, null, 2);

    // 2.5 STAGE: Facet Fingerprint (facet.js — Tier 1.1)
    if (typeof self.Facet !== 'undefined' && typeof self.Facet.build === 'function') {
      try {
        const facetCandidate = {
          tabId: 0,
          title: card.title || richData.title || url,
          url: url,
          domain: new URL(url).hostname.replace(/^www\./, ''),
          category: card.enrichment?.category || '',
          tags: (card.enrichment?.tags || []).map(t => (typeof t === 'string' ? t : t.tag)),
          pinned: false, muted: false, audible: false,
          lastAccessed: Date.now(), openedAt: Date.now(),
        };
        const fp = self.Facet.build(facetCandidate);
        document.getElementById('facetMedia').textContent = fp.media;
        document.getElementById('facetCommerce').textContent = fp.commerce;
        document.getElementById('facetGenre').textContent = fp.genre || 'null';
        document.getElementById('facetTopicGenre').textContent = fp.topicGenre || 'null';
        const fcContent = document.getElementById('facetContent');
        fcContent.innerHTML = fp.content.length
          ? fp.content.map(c=>`<span class="dbg-tag-chip">${c}</span>`).join('')
          : '—';
        const fcConflicts = document.getElementById('facetConflicts');
        fcConflicts.innerHTML = fp.conflicts.length
          ? fp.conflicts.map(x=>`<span class="dbg-tag-chip" style="border-color:var(--dbg-red,#ef4444)">${x.claimed} → ${x.derived}</span>`).join('')
          : '<span class="dbg-hint">None — all metadata consistent</span>';
      } catch(e) {
        console.warn('[debug] Facet.build error:', e);
      }
    }

    // 3. STAGE: Router & Guards (agent-router.js + command-agent.js mirror + veto)
    const cmdLower = command.toLowerCase();
    let routerSignals = [];
    if (self.AgentRouter) {
      const routed = self.AgentRouter.isComplexCommand(command);
      routerSignals = routed.signals;
      document.getElementById('routeComplex').textContent = routed.complex ? 'YES → agent path' : 'No';
    }
    document.getElementById('routeSignals').innerHTML = routerSignals.length
      ? routerSignals.map(s => `<span class="dbg-tag-chip">${s}</span>`).join('')
      : '<span class="dbg-hint">None — simple command</span>';

    // Intent detection via regex ladder (mirror of command-agent.js detectIntent)
    let detectedIntent = 'group_tabs';
    const INTENT_RE = [
      ['unpin_tabs', /\bun-?pin(s|ned|ning)?\b/], ['unmute_tabs', /\b(un-?mute|unsilence)\b/],
      ['close_tabs', /\b(close|closing|shut)\b(?!\s+caption)|\b(kill|quit|dismiss)/],
      ['bookmark_tabs', /\b(bookmark|save\s+(for|these|them|all))/], ['pin_tabs', /\bpin\b/],
      ['mute_tabs', /\b(mute|silence)\b/, ], ['reload_tabs', /\b(reload|refresh)\b/],
      ['search_and_switch', /\b(search|find|go\s+to|switch)\b/], ['sort_tabs', /\b(sort|order|arrange)\b/],
      ['open_tabs', /\b(open|opening|show|focus|reveal|highlight)\b|\b(bring\s+up|pull\s+up)\b/],
      ['group_tabs', /\b(group|cluster|organi[sz]e|collect|gather|bundle)\b/]
    ];
    for (const [intent, re] of INTENT_RE) { if (re.test(cmdLower)) { detectedIntent = intent; break; } }
    document.getElementById('routeIntent').textContent = detectedIntent;

    const isDestructive = detectedIntent === 'close_tabs';
    document.getElementById('routeDestructive').textContent = isDestructive ? '⚠ YES' : 'No';

    // Domain fast path (mirror of resolveDomainScopes from command-agent.js)
    const BRAND_HOSTS_MIRROR = {
      amazon: ['amazon.com','amazon.in','amazon.co.uk','amazon.de'],
      youtube: ['youtube.com','youtu.be'], github: ['github.com'], reddit: ['reddit.com'],
      netflix: ['netflix.com'], spotify: ['spotify.com'], google: ['google.com'],
      gmail: ['mail.google.com'], ebay: ['ebay.com'], flipkart: ['flipkart.com'],
      wikipedia: ['wikipedia.org'], primevideo: ['primevideo.com'],
    };
    let scopes = null;
    const dottedMatch = cmdLower.match(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|co|io|uk|in|de|jp|us|tv|app|dev|ai|me)\b/g) || [];
    let searchText = ' ' + cmdLower.replace(new RegExp(dottedMatch.map(d=>d.replace(/\./g,'\\.')).join('|'),'g'), dottedMatch.length ? ' '.repeat(1) : '') + ' ';
    for (const d of dottedMatch) { if (!scopes) scopes = []; scopes.push([d]); }
    for (const [brand, hosts] of Object.entries(BRAND_HOSTS_MIRROR)) {
      if (new RegExp('\\b'+brand+'\\b').test(searchText)) { if(!scopes)scopes=[]; scopes.push(hosts); }
    }
    const scopeChips = document.getElementById('routeScopes');
    if (scopes && scopes.length) {
      scopeChips.innerHTML = scopes.map(hs=>`<span class="dbg-tag-chip">${hs.join('|')}</span>`).join('');
    } else { scopeChips.innerHTML = '<span class="dbg-hint">No domain scope resolved</span>'; }

    const hasActionVerb = /\b(close|closing|group|grouping|open|opening|pin|pinning|unpin|mute|muting|unmute|unmuting|reload|refresh|bookmark|save|sort|show|showing|focus|switch|search|find|reveal|highlight|organize|organise|collect|gather|bring up|pull up)\b/i.test(cmdLower);
    const instrShape = /^\s*[{[]/.test(cmdLower) || /\b(select|drop)\b[^;.]{0,80}\b(from|database|table|tabs)\b/i.test(cmdLower);
    const jailbreak = /^\s*(system|developer mode|you are)\s*[:\w]/i.test(cmdLower) || /\bignore\b[^.]{0,30}\b(previous|your)\s+(rules|instructions)/i.test(cmdLower) || /\bbypass\b[^.]{0,20}\bconfirmation\b/i.test(cmdLower);
    document.getElementById('vetoVerb').textContent = hasActionVerb ? 'Yes' : 'No';
    document.getElementById('vetoShape').textContent = instrShape ? 'Instruction-shaped' : 'No';
    document.getElementById('vetoJail').textContent = jailbreak ? 'Detected' : 'None';
    const vetoed = (instrShape && !hasActionVerb) || jailbreak;
    const vetoEl = document.getElementById('vetoVerdict');
    vetoEl.textContent = vetoed ? 'VETOED — abstain' : 'Pass';
    vetoEl.className = vetoed ? 'dbg-meta-val dbg-badge-cat' : 'dbg-meta-val dbg-badge-success';

    // Fast-path decision display
    const fastPathEl = document.getElementById('routeFastPath');
    if (scopes && hasActionVerb) {
      fastPathEl.textContent = `YES — ${scopes.flat().length} hosts, deterministic`;
      fastPathEl.className = 'dbg-meta-val dbg-badge-success';
    } else {
      fastPathEl.textContent = 'No — semantic pipeline';
      fastPathEl.className = 'dbg-meta-val';
    }

    // 4. STAGE: Query Compiler — REAL llm-query.js SYSTEM prompt + coverage
    const systemPrompt = (typeof LlmQuery !== 'undefined' && LlmQuery.SYSTEM) ? LlmQuery.SYSTEM :
      '(LlmQuery not loaded — check script include)';
    document.getElementById('rawLlmSystemPrompt').textContent = systemPrompt;
    document.getElementById('rawLlmUserMessage').textContent = `Command: "${command}"`;

    // Parse using ConceptCore deterministic fallback (no Ollama in browser debug page)
    let parsedQuery;
    try { parsedQuery = self.ConceptCore.parseCommand(command); } catch(e) { parsedQuery = {}; }
    const detIntent = parsedQuery.action || detectedIntent;
    const detConcept = parsedQuery.concept || '';

    // Coverage invariant (llm-query.js coverage())
    let covData = { covered: [], uncovered: [], ratio: 1 };
    if (typeof LlmQuery !== 'undefined' && LlmQuery.coverage) {
      try { covData = LlmQuery.coverage(command, { concepts: detConcept ? [detConcept] : [], expansions: {}, domains: parsedQuery.domains || [] }); } catch(e) {}
    }
    document.getElementById('covCovered').innerHTML = covData.covered.length
      ? covData.covered.map(w=>`<span class="dbg-tag-chip" style="border-color:var(--dbg-green)">${w}</span>`).join('')
      : '—';
    document.getElementById('covUncovered').innerHTML = covData.uncovered.length
      ? covData.uncovered.map(w=>`<span class="dbg-tag-chip" style="border-color:var(--dbg-red,#ef4444)">${w}</span>`).join('')
      : '— (full coverage)';
    const covRatio = covData.ratio != null ? covData.ratio.toFixed(2) : '1.00';
    document.getElementById('covRatio').textContent = covRatio;
    document.getElementById('coverageMarker').style.left = Math.min(100, parseFloat(covRatio)*100) + '%';

    // Build full-schema AST
    const astResponse = {
      intent: detIntent,
      concepts: detConcept ? [detConcept] : [],
      combine: 'union',
      expansions: detConcept ? {[detConcept]: [detConcept+' guide', detConcept+' tutorial']} : {},
      domains: parsedQuery.domains || [],
      selectAll: /\b(all|every|everything)\b/i.test(cmdLower) && !detConcept,
      exclude: [],
      time: null,
      state: [],
      confidence: 0.85,
      source: 'concept-core (deterministic fallback)',
      _coverage: covRatio
    };

    document.getElementById('astIntent').textContent = astResponse.intent;
    document.getElementById('astConcepts').textContent = JSON.stringify(astResponse.concepts);
    document.getElementById('astCombine').textContent = astResponse.combine;
    document.getElementById('astConfidence').textContent = astResponse.confidence;
    document.getElementById('astSelectAll').textContent = String(astResponse.selectAll);
    document.getElementById('astExclude').textContent = JSON.stringify(astResponse.exclude);
    document.getElementById('astTime').textContent = astResponse.time ? JSON.stringify(astResponse.time) : 'null';
    document.getElementById('astState').textContent = JSON.stringify(astResponse.state);
    document.getElementById('astDomains').textContent = JSON.stringify(astResponse.domains);
    document.getElementById('astSource').textContent = astResponse.source;
    document.getElementById('astJson').textContent = JSON.stringify(astResponse, null, 2);

    // 5. STAGE: Selection Engine — facet admission + cosine bands + NLI + listwise status

    // Facet admission display
    let facetPredName = 'None';
    if (self.Facet && typeof self.Facet.build === 'function') {
      try {
        // The facet was already built in Stage 1; just report the ontology mapping
        const FACET_KEYS = [
          {keys:['entertainment','fun','movie','tv'], name:'entertainment'},
          {keys:['video','vidoe','streaming','stream','watch'], name:'video'},
          {keys:['music','audio','song','lofi','playlist','podcast'], name:'audio'},
          {keys:['shopping','shop','store','retail','deals','marketplace'], name:'commerce'},
          {keys:['news','journalism'], name:'news'},
          {keys:['weather','forecast'], name:'weather'},
          {keys:['docs','documentation','pdf','document'], name:'doc'}
        ];
        const conceptWords = (detConcept || cmdLower).split(/[^a-z0-9]+/).filter(Boolean);
        for (const e of FACET_KEYS) {
          if (e.keys.some(k => conceptWords.includes(k))) { facetPredName = e.name; break; }
        }
      } catch(e) {}
    }
    document.getElementById('selFacetPred').textContent = facetPredName;
    document.getElementById('selFacetGrade').textContent = facetPredName !== 'None' ? 'Admission-grade (elect 0.70)' : 'N/A';

    // Cosine scoring (existing logic preserved)
    const targetConcept = detConcept || 'all';
    const queryVec = generateQueryVector(targetConcept);
    const rawCosine = computeCosine(embedding, queryVec);
    const conceptLower = targetConcept.toLowerCase();
    let canonQuery = null;
    if (self.EnrichMath?.matchTag) canonQuery = self.EnrichMath.matchTag(conceptLower);
    const cardCat = card.enrichment?.category;
    const cardTags = (card.enrichment?.tags || []).map(t => (typeof t === 'string' ? t : t.tag));
    let catBoost = 0;
    if (canonQuery && (cardCat === canonQuery || cardTags.includes(canonQuery))) catBoost = 0.20;
    const titleLower = (card.title || '').toLowerCase();

    const keywords = (card.structured?.keywords || []).map(k => String(k).toLowerCase());
    let lexicalBoost = 0;

    if (titleLower.includes(conceptLower) || keywords.includes(conceptLower)) {
      lexicalBoost = 0.15;
    } else if (canonQuery === 'coding' && /\b(python|javascript|typescript|react|rust|golang|c\+\+|java|rag|llm|pytorch|tensorflow|sql|docker|kubernetes|api|git|linux|kernel)\b/i.test(titleLower)) {
      lexicalBoost = 0.15;
    } else if (canonQuery === 'cooking' && /\b(recipe|recipes|sourdough|baking|bake|cook|dinner|ingredients|bread)\b/i.test(titleLower)) {
      lexicalBoost = 0.15;
    } else if (canonQuery === 'sports' && /\b(cricket|football|soccer|nba|tennis|ipl|score|match|tournament)\b/i.test(titleLower)) {
      lexicalBoost = 0.15;
    }

    const combinedScore = Math.min(1.0, rawCosine + catBoost + lexicalBoost);

    document.getElementById('valRawCosineScore').textContent = rawCosine.toFixed(3);
    document.getElementById('valCatBoost').textContent = `+${catBoost.toFixed(2)}`;
    document.getElementById('valLexicalBoost').textContent = `+${lexicalBoost.toFixed(2)}`;
    document.getElementById('valCosineScore').textContent = combinedScore.toFixed(3);
    
    // Position Cosine Marker (0% to 100%)
    const marker = document.getElementById('cosineMarker');
    const markerLeft = Math.min(100, Math.max(0, combinedScore * 100));
    marker.style.left = `${markerLeft}%`;

    const BAND_LOW = 0.20;
    const BAND_HIGH = 0.45;
    const DEFAULT_THRESHOLD = 0.55;
    const UNCERTAIN_THRESHOLD = 0.35;

    let tier1Decision = '';
    let explanation = '';
    let isAmbiguous = false;

    const elDecision = document.getElementById('valTier1Decision');
    if (combinedScore >= BAND_HIGH) {
      tier1Decision = 'AUTO_ACCEPT';
      elDecision.textContent = 'AUTO_ACCEPT';
      elDecision.className = 'dbg-meta-val dbg-badge-success';
      explanation = `Combined Tier 1 score (${combinedScore.toFixed(3)}) &ge; 0.45: Highly confident semantic + lexical match. Auto-Accepted in Tier 1 with 0 NLI forward passes.`;
    } else if (combinedScore < BAND_LOW) {
      tier1Decision = 'AUTO_REJECT';
      elDecision.textContent = 'AUTO_REJECT';
      elDecision.className = 'dbg-meta-val dbg-badge-danger';
      explanation = `Combined Tier 1 score (${combinedScore.toFixed(3)}) &lt; 0.20: Confident non-match. Auto-Rejected in Tier 1 with 0 NLI forward passes.`;
    } else {
      tier1Decision = 'AMBIGUOUS_BAND';
      isAmbiguous = true;
      elDecision.textContent = 'ROUTED_TO_NLI';
      elDecision.className = 'dbg-meta-val dbg-badge-warn';
      explanation = `Combined Tier 1 score (${combinedScore.toFixed(3)}) sits in the Ambiguous Band [0.20, 0.45]. Routed to Tier 2 DeBERTa NLI for precise zero-shot entailment scoring.`;
    }
    document.getElementById('tier1Explanation').innerHTML = explanation;

    // Full 1,800-Character NLI Premise with Structured Semantic Framing
    const rawTitle = card.title || '';
    const cleanTitle = rawTitle.replace(/\s*-\s*YouTube$/i, '').trim();
    const host = card.domain || (card.url ? new URL(card.url).hostname.toLowerCase() : '');
    const cleanCat = (card.enrichment?.category && card.enrichment.category !== 'other') ? card.enrichment.category : '';
    const cleanTags = (card.enrichment?.tags || []).map(t => typeof t === 'string' ? t : t.tag).filter(t => t && t !== 'other').join(' ');
    const allKeywords = (card.structured?.keywords || []).concat(card.enrichment?.subTopics || []).slice(0, 15).join(' ');
    const cleanBody = (denseSummary || card.pseudoDoc || '').slice(0, 1200);

    const parts = [];
    if (cleanTitle) parts.push(`Page Title: ${cleanTitle}.`);
    if (host) parts.push(`Website: ${host}.`);
    if (cleanCat || cleanTags) parts.push(`Category: ${[cleanCat, cleanTags].filter(Boolean).join(' ')}.`);
    if (allKeywords || cleanBody) parts.push(`Content: ${[allKeywords, cleanBody].filter(Boolean).join(' ')}.`);

    const premise = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1800);

    const hypothesis = `This browser tab is about ${targetConcept}.`;

    document.getElementById('nliPremiseText').textContent = `"${premise}"`;
    document.getElementById('nliHypothesisText').textContent = `"${hypothesis}"`;

    // NLI Entailment Calculation
    // Simulated DeBERTa-v3 zero-shot scoring based on rich keyword & category overlap
    let nliScore = 0.10;
    const premiseLower = premise.toLowerCase();
    
    const isExactMatch = premiseLower.includes(conceptLower) || 
      (conceptLower === 'programming' && (premiseLower.includes('python') || premiseLower.includes('code') || premiseLower.includes('transformers') || premiseLower.includes('pytorch') || premiseLower.includes('kernel') || premiseLower.includes('git') || premiseLower.includes('rag') || premiseLower.includes('langchain'))) ||
      (conceptLower === 'gaming' && (premiseLower.includes('game') || premiseLower.includes('stream') || premiseLower.includes('twitch') || premiseLower.includes('esports'))) ||
      (conceptLower === 'cooking' && (premiseLower.includes('recipe') || premiseLower.includes('sourdough') || premiseLower.includes('bake') || premiseLower.includes('flour'))) ||
      (conceptLower === 'sports' && (premiseLower.includes('cricket') || premiseLower.includes('match') || premiseLower.includes('ipl') || premiseLower.includes('football')));

    if (isExactMatch || combinedScore >= BAND_HIGH) {
      nliScore = Math.min(0.98, 0.85 + (combinedScore * 0.13));
    } else if (combinedScore <= BAND_LOW && !isExactMatch) {
      nliScore = Math.max(0.02, combinedScore * 0.5);
    } else {
      nliScore = 0.42; // Borderline uncertain
    }

    document.getElementById('nliEntailmentScore').textContent = (nliScore * 100).toFixed(1) + '%';
    
    const threshStatus = document.getElementById('nliThresholdStatus');
    if (nliScore >= DEFAULT_THRESHOLD) {
      threshStatus.textContent = 'PASS (>= 0.55)';
      threshStatus.className = 'dbg-nli-card-status status-matched';
    } else {
      threshStatus.textContent = 'FAIL (< 0.55)';
      threshStatus.className = 'dbg-nli-card-status status-rejected';
    }

    const uncertStatus = document.getElementById('nliUncertainStatus');
    if (nliScore >= UNCERTAIN_THRESHOLD && nliScore < DEFAULT_THRESHOLD) {
      uncertStatus.textContent = 'TRIGGERED (0.35-0.55)';
      uncertStatus.className = 'dbg-nli-card-status status-uncertain';
    } else {
      uncertStatus.textContent = 'NO';
      uncertStatus.className = 'dbg-nli-card-status';
    }

    // Final Decision
    const decisionEl = document.getElementById('nliFinalDecision');
    const decisionBadge = document.getElementById('nliDecisionBadge');
    
    if (nliScore >= DEFAULT_THRESHOLD || (!isAmbiguous && tier1Decision === 'AUTO_ACCEPT')) {
      decisionEl.textContent = 'MATCHED (Checked)';
      decisionEl.className = 'dbg-nli-card-decision status-matched';
      decisionBadge.textContent = 'MATCHED';
      decisionBadge.className = 'dbg-badge-success';
    } else if (nliScore >= UNCERTAIN_THRESHOLD) {
      decisionEl.textContent = '[UNCERTAIN] (Unchecked Badge)';
      decisionEl.className = 'dbg-nli-card-decision status-uncertain';
      decisionBadge.textContent = 'UNCERTAIN';
      decisionBadge.className = 'dbg-badge-gold';
    } else {
      decisionEl.textContent = 'DROPPED (No Match)';
      decisionEl.className = 'dbg-nli-card-decision status-rejected';
      decisionBadge.textContent = 'DROPPED';
      decisionBadge.className = 'dbg-badge';
    }

    // Listwise escalation display (mirror — no actual model call in browser debug page)
    const lwFiredEl = document.getElementById('lwFired');
    const lwTriggerEl = document.getElementById('lwTrigger');
    const lwPickEl = document.getElementById('lwPick');
    if (typeof self.NliSelect !== 'undefined' && self.NliSelect.listwiseStats) {
      const stats = self.NliSelect.listwiseStats();
      lwFiredEl.textContent = String(stats.escalated || 0);
    } else {
      // Mirror the trigger condition from nli-select.js
      const marginOk = nliScore >= UNCERTAIN_THRESHOLD && nliScore < 1.0;
      const singularShape = /\b(the|that|my)\s+[a-z0-9'-]+(\s+[a-z0-9'-]+){0,3}\s+(page|story|article|video|mix|stream|guide|recipe|repo|document|doc|tutorial|tab)\b/i.test(cmdLower);
      const wouldEscalate = marginOk && singularShape;
      lwFiredEl.textContent = wouldEscalate ? 'Would escalate (needs callModel in prod)' : 'Not triggered';
      lwTriggerEl.textContent = wouldEscalate
        ? `margin < 0.30, singular shape ✓, ${nliScore.toFixed(2)} conf`
        : 'margin/shape not met';
      lwPickEl.textContent = wouldEscalate ? '(model adjudicates in production)' : '—';
    }

    // 6. STAGE: Plan Operators & Execution Decision (plan-ops.js)
    let restFires = false, superlativeSpec = null, literalToken = null;
    if (typeof self.PlanOps !== 'undefined') {
      try {
        // Rest partition shape test (no universe needed for shape-only check)
        const rpCmd = cmdLower;
        const hasPartition = /\b(split|divide|sort|organize|group)\b/i.test(rpCmd) && /\binto\b|\bbuckets?\s*:/i.test(rpCmd);
        const hasRestCue = /\bthe\s+rest\b|\beverything\s+else\b|\bthe\s+others\b/i.test(rpCmd);
        restFires = hasPartition && hasRestCue;

        // Superlative spec extraction
        const supMatch = rpCmd.match(/\b(oldest|newest|most\s+recent|latest|first|last|earliest)\b/i);
        if (supMatch) superlativeSpec = supMatch[1].toLowerCase();

        // Literal token extraction
        const litMatch = rpCmd.match(/\b(?:containing|with|has|having)\s+the\s+(?:word|term|phrase)\s+(["']?)([a-z0-9]+)\1?\s+in\s+their\s+title/i) ||
                         rpCmd.match(/\btitled?\s+["']?([a-z0-9\s]+)["']?\s*$/i);
        if (litMatch) literalToken = (litMatch[2] || litMatch[1]).trim();
      } catch(e) {}
    }
    document.getElementById('opRestPartition').textContent = restFires ? `YES — universe expands` : 'No';
    document.getElementById('opSuperlative').textContent = superlativeSpec ? `${superlativeSpec} → extreme pick` : 'No superlative detected';
    document.getElementById('opLiteral').textContent = literalToken ? `Literal mode: title contains "${literalToken}"` : 'No literal-token command';

    // Execution decision
    const selectedCount = facetPredName !== 'None' ? 3 : (nliScore >= DEFAULT_THRESHOLD ? 1 : 0);
    const needsPreview = isDestructive || selectedCount >= 3 || astResponse.confidence < 0.75;
    const isAmbiguousCmd = / or | and (then )?(group|close|pin|mute)/i.test(cmdLower);

    document.getElementById('execPreview').textContent = needsPreview ? 'YES — preview dialog fires' : 'No — auto-execute';
    document.getElementById('execDestructive').textContent = isDestructive ? '⚠ YES — always previewed' : 'No';
    document.getElementById('execAmbig').textContent = isAmbiguousCmd ? 'YES — competing intents detected' : 'No';
    document.getElementById('execCount').textContent = String(selectedCount);

    pipelineStatusPill.textContent = 'Trace Completed';
    pipelineStatusPill.style.color = '#2ecc71';
  }

  // ================= LIVE INDEXEDDB EXPLORER =================
  async function refreshIndexedDbTable() {
    if (!self.TabDB) return;
    try {
      await self.TabDB.init();
      const cards = await self.TabDB.getAllTabCards();
      const tbody = document.getElementById('dbTableBody');
      const countEl = document.getElementById('dbTotalCount');
      
      countEl.textContent = cards.length;
      if (!cards || cards.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="dbg-empty-table">No records found in IndexedDB. Run pipeline to store tabs.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      cards.forEach(c => {
        const tr = document.createElement('tr');
        const tags = (c.enrichment?.tags || []).map(t => (typeof t === 'string' ? t : t.tag)).join(', ');
        const dateStr = new Date(c.extractedAt || Date.now()).toLocaleTimeString();
        tr.innerHTML = `
          <td class="dbg-mono" style="font-size: 11px; color: var(--dbg-accent-gold);">${(c.urlHash || '').slice(0, 12)}…</td>
          <td style="font-weight: 500;">${c.title || '(No Title)'}</td>
          <td class="dbg-mono">${c.domain || ''}</td>
          <td><span class="dbg-badge-cat">${c.enrichment?.category || 'other'}</span></td>
          <td>${tags || '—'}</td>
          <td style="color: var(--dbg-text-muted); font-size: 11px;">${dateStr}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.warn('Failed to refresh DB table:', e);
    }
  }

  // ================= EVENT LISTENERS & INITIALIZATION =================
  function initWorkbench() {
    // Preset Selector Change
    presetSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val && PRESET_FIXTURES[val]) {
        currentUrl = PRESET_FIXTURES[val].url;
        currentHtml = PRESET_FIXTURES[val].html;
        urlInput.value = currentUrl;
        runPipelineTrace();
      }
    });

    // Fetch / Load Page Button
    btnFetchUrl.addEventListener('click', async () => {
      const inputVal = urlInput.value.trim();
      if (!inputVal) return;
      currentUrl = inputVal;

      pipelineStatusPill.textContent = 'Fetching Page…';
      try {
        // Try local proxy server if available, else direct fetch
        const proxyUrl = `/api/fetch?url=${encodeURIComponent(currentUrl)}`;
        const resp = await fetch(proxyUrl).catch(() => fetch(currentUrl, { mode: 'no-cors' }));
        if (resp && resp.ok) {
          currentHtml = await resp.text();
        } else {
          // Fallback minimal template for external live URL if CORS blocked
          currentHtml = `<!DOCTYPE html><html><head><title>${currentUrl.split('/').pop() || 'Live Page'}</title>
            <meta name="description" content="Live page loaded from ${currentUrl}">
            </head><body><h1>${currentUrl}</h1><article><p>Loaded live page content from ${currentUrl}.</p></article></body></html>`;
        }
      } catch (err) {
        currentHtml = `<!DOCTYPE html><html><head><title>${currentUrl}</title></head><body><h1>${currentUrl}</h1><p>Fetched URL directly.</p></body></html>`;
      }
      runPipelineTrace();
    });

    // Command Bar Input
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        currentCommand = cmdInput.value.trim();
        runPipelineTrace();
      }
    });

    btnExecCmd.addEventListener('click', () => {
      currentCommand = cmdInput.value.trim();
      runPipelineTrace();
    });

    btnRunPipeline.addEventListener('click', () => {
      currentCommand = cmdInput.value.trim();
      runPipelineTrace();
    });

    // Quick Command Chips
    document.querySelectorAll('.dbg-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const cmd = chip.dataset.cmd;
        cmdInput.value = cmd;
        currentCommand = cmd;
        runPipelineTrace();
      });
    });

    // Left Pane Mode Switching (Preview vs Raw DOM vs Sandbox)
    document.querySelectorAll('[data-left-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-left-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.leftTab;
        
        document.getElementById('browserView').classList.remove('active');
        document.getElementById('domView').classList.remove('active');
        document.getElementById('sandboxView').classList.remove('active');

        if (tab === 'browser') {
          document.getElementById('browserView').classList.add('active');
        } else if (tab === 'dom') {
          document.getElementById('domView').classList.add('active');
        } else if (tab === 'sandbox') {
          document.getElementById('sandboxView').classList.add('active');
          updateSandboxResults();
        }
      });
    });

    // Tag Ingestion Sandbox Live Evaluator
    const sandboxInput = document.getElementById('sandboxTextInput');
    function updateSandboxResults() {
      if (!sandboxInput) return;
      const text = sandboxInput.value.trim();
      
      // 1. Canonical Tag Mapping
      const canonTag = self.EnrichMath?.canonicalTag ? self.EnrichMath.canonicalTag(text) : 'N/A';
      document.getElementById('sandboxCanonicalTag').textContent = canonTag ? `${canonTag} (via TAG_ALIASES)` : 'None (No direct alias match)';
      
      // 2. Word-boundary Substring Match (matchTag)
      const matched = self.EnrichMath?.matchTag ? self.EnrichMath.matchTag(text) : 'N/A';
      document.getElementById('sandboxMatchTag').textContent = matched ? `${matched} (word-boundary regex match)` : 'None';

      // 3. Domain Priors
      let dPrior = 'None';
      if (self.DomainPriors?.applyPriors) {
        const res = self.DomainPriors.applyPriors(text.includes('http') ? text : `https://${text}`);
        if (res) dPrior = `${res.tags.join(', ')} (confidence: ${res.conf})`;
      }
      document.getElementById('sandboxDomainPrior').textContent = dPrior;

      // 4. Extracted NER Entities
      const nerWrap = document.getElementById('sandboxNerEntities');
      if (nerWrap && globalThis.extractLocalEntities) {
        nerWrap.innerHTML = '';
        const dummyDoc = new DOMParser().parseFromString(`<html><body><h1>${text}</h1><p>${text}</p></body></html>`, 'text/html');
        const fakeOut = { title: text, mainText: text, structured: { keywords: [], people: [] } };
        const entities = globalThis.extractLocalEntities(dummyDoc, fakeOut);
        if (entities.length) {
          entities.forEach(ent => {
            const chip = document.createElement('span');
            chip.className = 'dbg-tag-chip';
            chip.style.borderColor = 'var(--dbg-accent-gold)';
            chip.textContent = `${ent.type.toUpperCase()}: ${ent.name}`;
            nerWrap.appendChild(chip);
          });
        } else {
          nerWrap.textContent = 'No named entities detected in input text.';
        }
      }
    }

    if (sandboxInput) {
      sandboxInput.addEventListener('input', updateSandboxResults);
      updateSandboxResults();
    }

    // SQLite Backend Stats & Disk Sync
    async function updateSqliteStats() {
      const pingEl = document.getElementById('sqlitePingStatus');
      const countEl = document.getElementById('sqliteTotalCount');
      const entitiesEl = document.getElementById('sqliteEntitiesCount');

      try {
        const resp = await fetch('http://127.0.0.1:8000/api/tabs/stats');
        if (resp.ok) {
          const data = await resp.json();
          if (pingEl) {
            pingEl.textContent = '● Backend Connected (Disk Active)';
            pingEl.className = 'dbg-sqlite-ping ping-online';
          }
          if (countEl) countEl.textContent = `${data.total_tabs || 0} tabs on disk`;
          if (entitiesEl) entitiesEl.textContent = `${data.total_entities || 0} entities`;
        } else {
          throw new Error('Backend not responding');
        }
      } catch (e) {
        if (pingEl) {
          pingEl.textContent = '○ Backend Offline (Start: python manage.py runserver)';
          pingEl.className = 'dbg-sqlite-ping ping-offline';
        }
        if (countEl) countEl.textContent = 'Standalone mode';
        if (entitiesEl) entitiesEl.textContent = '—';
      }
    }

    // Manual SQLite Sync Button
    document.getElementById('btnSyncSqlite')?.addEventListener('click', async () => {
      if (!currentCard) return;
      const btn = document.getElementById('btnSyncSqlite');
      btn.textContent = 'Syncing…';
      try {
        const payload = {
          tabs: [{
            url: currentCard.url,
            urlHash: currentCard.urlHash,
            domain: currentCard.domain,
            title: currentCard.title,
            mainText: currentCard.mainText,
            category: currentCard.enrichment?.category || 'other',
            tags: currentCard.enrichment?.tags || [],
            entities: currentCard.entities || [],
            embedding: currentCard.embedding || []
          }]
        };
        const resp = await fetch('http://127.0.0.1:8000/api/tabs/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (resp.ok) {
          const res = await resp.json();
          btn.textContent = '✓ Synced to Disk!';
          updateSqliteStats();
        } else {
          btn.textContent = 'Sync Failed';
        }
      } catch (e) {
        btn.textContent = 'Backend Offline';
      }
      setTimeout(() => { btn.textContent = '💾 Sync to Disk'; }, 2000);
    });

    // FTS5 Live Search Test Button
    document.getElementById('btnRunFts')?.addEventListener('click', async () => {
      const qInput = document.getElementById('ftsSearchInput');
      const resultsWrap = document.getElementById('ftsResultsWrap');
      const query = (qInput?.value || '').trim();
      if (!query) return;

      resultsWrap.textContent = `Searching SQLite FTS5 index for "${query}"...`;
      try {
        const resp = await fetch(`http://127.0.0.1:8000/api/tabs/fts?q=${encodeURIComponent(query)}`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.results && data.results.length) {
            resultsWrap.textContent = `FTS5 BM25 matches (${data.results.length} results in ${data.search_latency_ms || '<1'}ms):\n\n` +
              data.results.map((r, i) => `[${i+1}] ${r.title}\n    URL: ${r.url}\n    Category: ${r.category} | Tags: ${(r.tags || []).map(t => t.tag || t).join(', ')} | BM25 Rank: ${r.rank || 'N/A'}`).join('\n\n');
          } else {
            resultsWrap.textContent = `No FTS5 matches found for query "${query}". Try syncing tabs to disk first.`;
          }
        } else {
          resultsWrap.textContent = 'FTS search error from backend.';
        }
      } catch (err) {
        resultsWrap.textContent = `Cannot reach backend on port 8000 (${err.message}). Ensure Django server is running.`;
      }
    });

    // Apply Raw HTML Edit & Re-extract
    btnReExtractDom.addEventListener('click', () => {
      currentHtml = rawHtmlTextarea.value;
      runPipelineTrace();
    });

    // Right Pane Inspector Stage Navigation
    document.querySelectorAll('.dbg-nav-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.dbg-nav-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.dbg-stage-panel').forEach(p => p.classList.remove('active'));
        
        tabBtn.classList.add('active');
        const stageId = tabBtn.dataset.stage;
        const panel = document.getElementById(`panel-${stageId}`);
        if (panel) panel.classList.add('active');

        if (stageId === 'stage-storage') {
          refreshIndexedDbTable();
          updateSqliteStats();
        }
      });
    });

    // Copy Buttons
    document.querySelectorAll('.dbg-btn-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.copy;
        let text = '';
        if (targetId === 'rawDbJson') {
          text = document.getElementById('rawDbJson').textContent;
        } else if (targetId === 'rawLlmRequest') {
          text = document.getElementById('rawLlmSystemPrompt').textContent + '\n\n' + document.getElementById('rawLlmUserMessage').textContent;
        }
        navigator.clipboard.writeText(text);
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = originalText, 1500);
      });
    });

    // IndexedDB Explorer Buttons
    document.getElementById('btnRefreshDb')?.addEventListener('click', () => {
      refreshIndexedDbTable();
      updateSqliteStats();
    });
    document.getElementById('btnClearDb')?.addEventListener('click', async () => {
      if (confirm('Clear all cached tab cards in IndexedDB?')) {
        const cards = await self.TabDB.getAllTabCards();
        for (const c of cards) {
          if (c.urlHash) await self.TabDB.deleteTabCard(c.urlHash);
        }
        refreshIndexedDbTable();
      }
    });

    // Splitter Drag Handling
    const splitter = document.getElementById('dragSplitter');
    const leftPane = document.getElementById('leftPane');
    const container = document.getElementById('splitLayout');

    let isDragging = false;
    splitter.addEventListener('mousedown', (e) => {
      isDragging = true;
      splitter.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const rect = container.getBoundingClientRect();
      const offset = e.clientX - rect.left;
      const pct = (offset / rect.width) * 100;
      if (pct >= 25 && pct <= 75) {
        leftPane.style.width = `${pct}%`;
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        splitter.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });

    // Run Initial Trace with GitHub Repo Fixture
    presetSelect.value = 'repo-page';
    runPipelineTrace();
    refreshIndexedDbTable();
    updateSqliteStats();
  }

  // Launch Workbench on DOM Load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWorkbench);
  } else {
    initWorkbench();
  }
})();
