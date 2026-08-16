// nli-select.js
// Zero-shot tab selection by natural-language inference.
//
// WHY THIS EXISTS
// The shipping path hands every candidate to a generative model and asks it to
// pick a set. Measured on bench/commands.jsonl (25 commands, 15-tab pool):
//
//   arm                        set-exact  precision  recall   F1  violations
//   V1 math + qwen2.5-coder:3b     1/25        38%     74%   42%          1
//   NLI zero-shot (22M)           21/25        86%     85%   85%          0
//
// The NLI model is ~70MB and runs on WASM CPU -- zero VRAM, ~190ms/command in
// the bench -- against ~2GB of weights and ~20s per call for the 3B model.
//
// The mechanism is different in kind, not degree. A generative model is asked to
// author a JSON set and can hallucinate ids, drift off-task, or emit the same
// confidence for everything (the shipping model returned confidence 0.8 for all
// ten matches, including three LeetCode tabs it called "entertainment"). An NLI
// model instead scores one hypothesis -- "This browser tab is about X." -- per
// tab and returns a probability. It cannot invent a tab that was not scored, and
// its scores are comparable across tabs, which is what makes a threshold and an
// abstention meaningful.
//
// multi_label matters: a YouTube cricket highlights tab genuinely entails BOTH
// "about sports" (0.99) and "about entertainment" (0.99). Single-label softmax
// forces those to compete and is exactly why "group all entertainment tabs"
// missed YouTube.

(() => {
  const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

  // Tuned on bench/commands.jsonl. Entailment probabilities for this model are
  // well separated -- correct matches cluster high, non-matches low -- so the
  // exact value is not delicate.
  const DEFAULT_THRESHOLD = 0.55;
  // Below threshold but not clearly out: surfaced as "uncertain" so destructive
  // actions can show them unchecked rather than silently dropping or including.
  const UNCERTAIN_THRESHOLD = 0.35;

  // DeBERTa-v3 context window is 512 tokens (~2000 chars). After hypothesis (~20 tokens),
  // up to 1800 chars of high-density semantic context (title, URL, code signatures,
  // badges, and stop-word filtered mainText) can be evaluated.
  const MAX_TAB_CHARS = 1800;

  // Expansion terms are OFF, and this number is measured, not chosen
  // (bench/expansion-sweep.js, 112 commands):
  //
  //     w      set-exact   prec  recall  violations
  //     0.0    100/112      92%    95%       3     <- here
  //     0.5    100/112      92%    95%       3
  //     0.6     88/112      89%   100%      12
  //     1.0     63/112      78%   100%      21
  //
  // Trusting expansions equally with the typed concept was actively harmful:
  // asked to expand "cricket" the parser returned ["test match","ipl","football"],
  // and that one bad term pulled both football tabs into every cricket command.
  // Recall goes to 100% because expansions match everything -- which is the
  // failure, not the win.
  //
  // This sat at 0.4 first, on the reasoning that a discounted expansion could
  // still nudge a borderline tab. LATENCY settled it. Every expansion is a
  // separate forward pass per tab, and the parser emits 3 of them for 67 of 112
  // commands -- so 0.4 was paying a 4x scoring cost for an accuracy delta of
  // exactly zero across the whole 0-0.5 range. In the browser that 4x was 90
  // seconds instead of 23.
  //
  // Turning them off is not a regression. It is the same score, four times
  // cheaper. If a curated synonym table ever lands, it should be applied at
  // PARSE time as an alternate concept, not here as an extra forward pass.
  //
  // Note what this means: the LLM's value is concept EXTRACTION (typos, filler
  // stripping, intent), not world knowledge. Knowledge-gap cases like "the
  // ashes" remain unsolved, and the honest fix is that curated table.
  const EXPANSION_WEIGHT = 0;

  // ---- The uncertain band ------------------------------------------------
  //
  // WHY THIS EXISTS AT ALL
  //
  // NLI costs one forward pass per tab, measured at 1423ms in the real service
  // worker. Scanning a 453-tab window is 10.7 MINUTES. Every previous attempt to
  // survive that was a cap -- shortlist 30, then 12, then a 25s clock -- and
  // every one of them silently truncated real matches. That is why "group
  // programming tabs" returned neither LeetCode nor Codeforces: the model never
  // saw them.
  //
  // Bundling the SIMD wasm did not help (1495 -> 1423ms). The reason is in the
  // model graph: nli-deberta-v3-xsmall's "quantized" export is 74 MatMulInteger
  // ops against 1896 fp32 MatMuls -- about 4% quantized -- and MatMulInteger is
  // the op WASM SIMD actually accelerates. A shootout across four MNLI models
  // (bench/model-shootout.js) found no accurate replacement: deberta 99/112, the
  // next best 75/112. The per-pass cost is not fixable.
  //
  // So the answer is to stop paying it per tab.
  //
  // Every card already carries a MiniLM embedding computed at index time. Cosine
  // between the query and a stored vector is a dot product -- no model call, no
  // per-tab cost, and it scores EVERY tab, which is the property the caps
  // destroyed. Measured alone it reaches 83/112 (bench/cosine-vs-nli.js): good
  // enough to sort the obvious cases, not good enough to decide the hard ones.
  //
  // Hybrid: cosine decides the confident cases for free; NLI is spent only on
  // the ambiguous middle. Measured (bench/hybrid-bench.js, 112 commands):
  //
  //     band          set-exact  prec  recall  NLI passes/cmd
  //     cosine only     83/112    83%    93%        0.0
  //     0.20-0.45      100/112    92%    94%        1.9   <- here
  //     0.20-0.90       97/112    89%    92%        3.0
  //     NLI on all     100/112    92%    95%       15.0
  //
  // Same accuracy as scanning every tab with NLI, at an eighth of the model
  // calls -- because the tabs NLI was being spent on were ones cosine already
  // knew the answer to.
  //
  // These are cosine bounds, not a tab count and not a clock. They do not scale
  // with how many tabs are open, they do not truncate a ranked list, and a tab
  // that clears BAND_HIGH is selected no matter how many other tabs did too.
  const BAND_LOW = 0.20;   // below: cosine is confident it does not match
  const BAND_HIGH = 0.45;  // above: cosine is confident it does

  let classifier = null;
  let loading = null;
  // What ort-config.js actually applied, so the browser log can prove which WASM
  // build loaded instead of us assuming the fix took effect.
  let ortStatus = null;

  // (term, tabText) -> entailment score. Expansions mean the same tab is scored
  // against several related terms, and concepts repeat across commands, so this
  // removes most of the duplicated forward passes within a session.
  const scoreCache = new Map();
  const SCORE_CACHE_MAX = 5000;

  // Query-side embeddings. A concept repeats across commands ("programming" in
  // every phrasing of the same request), so this makes the cosine stage free on
  // repeat. Small and bounded by the number of distinct concepts a user types.
  const conceptVecCache = new Map();

  // The embedder. Injected rather than imported so the bench can supply one and
  // the extension can pass self.Embed -- and so its absence is a supported state
  // (no embedder means every tab routes to NLI, which is slow but correct).
  let embedFn = null;
  function setEmbedder(fn) { embedFn = fn; conceptVecCache.clear(); }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d ? dot / d : 0;
  }

  function sha(s) {
    // Small non-crypto hash: this only has to be a stable cache key.
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  async function load() {
    if (classifier) return classifier;
    if (loading) return loading;
    loading = (async () => {
      let mod;
      try {
        mod = require('@xenova/transformers');
      } catch {
        mod = self?.transformers;
      }
      if (!mod || !mod.pipeline) throw new Error('transformers.js unavailable');
      // Point onnxruntime at the bundled SIMD build. See ort-config.js -- this
      // is the difference between ~1495ms and a usable per-pass cost, and it
      // must happen before pipeline() instantiates a session.
      const OC = (typeof self !== 'undefined' && self.OrtConfig) || require('./ort-config.js');
      ortStatus = OC.configureOrt(mod);
      classifier = await mod.pipeline('zero-shot-classification', MODEL_ID);
      return classifier;
    })();
    return loading;
  }

  // Ensures the WebGPU offscreen document exists and is listening before sending runtime messages
  async function makeSureOffscreenReady() {
    if (typeof chrome === 'undefined' || !chrome.offscreen) return false;
    
    // 1. Ensure document is created
    if (typeof self.ensureOffscreenDocument === 'function') {
      try { await self.ensureOffscreenDocument(); } catch (e) {}
    } else {
      try {
        if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
          // Document exists
        } else {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['WORKERS'],
            justification: 'Hardware-accelerated WebGPU ML inference for tab clustering'
          });
        }
      } catch (e) {
        if (!e.message || !e.message.includes('Only a single')) {
          console.warn('[nli-select] offscreen create warning:', e.message);
        }
      }
    }

    // 2. Ping handshake with retry to guarantee the offscreen onMessage listener is mounted
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const ping = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }, (resp) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(resp);
          });
        });
        if (ping && ping.ok) return true;
      } catch (err) {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    return false;
  }

  // WebGPU-accelerated batched inference helper via offscreen document
  async function inferZeroShotBatch(premises, candidates, options) {
    if (!Array.isArray(premises) || premises.length === 0) return [];
    
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage && typeof chrome.offscreen !== 'undefined') {
      try {
        await makeSureOffscreenReady();
        const resp = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Offscreen WebGPU batch inference timeout (30000ms)')), 30000);
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_NLI_BATCH',
            premises,
            candidates,
            options
          }, (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response || !response.success) {
              reject(new Error(response?.error || 'Empty offscreen batch response'));
            } else {
              resolve(response.results);
            }
          });
        });
        return resp;
      } catch (err) {
        console.warn('[NLI] Offscreen WebGPU batch failed, falling back to local model:', err.message);
      }
    }

    const localClassifier = await load();
    const res = await localClassifier(premises, candidates, options);
    return Array.isArray(res) ? res : [res];
  }

  // WebGPU-accelerated inference helper via offscreen document, with fallback to local classifier
  async function inferZeroShot(premise, candidates, options) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage && typeof chrome.offscreen !== 'undefined') {
      try {
        await makeSureOffscreenReady();
        const resp = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Offscreen WebGPU inference timeout (30000ms)')), 30000);
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_NLI_ZERO_SHOT',
            premise,
            candidates,
            options
          }, (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response || !response.success) {
              reject(new Error(response?.error || 'Empty offscreen response'));
            } else {
              resolve(response.result);
            }
          });
        });
        return resp;
      } catch (err) {
        console.warn('[NLI] Offscreen WebGPU inference error, falling back to local model:', err.message);
      }
    }

    const localClassifier = await load();
    return localClassifier(premise, candidates, options);
  }

  // The text the hypothesis is tested against.
  //
  // The FULL url is included, not just the hostname. This is not cosmetic: URL
  // paths carry most of the topical signal for sites whose domain is opaque.
  // "group my keyboard tabs" matches
  //     forums.keebtalk-example.com/t/best-budget-mechanical-keyboards-2026
  // only because the path says "mechanical-keyboards" -- the hostname says
  // nothing about keyboards. Scoring hostname-only dropped this command and one
  // other, 21/25 -> 19/25, when measured against the same gold set.
  const NLI_STOP_WORDS = new Set([
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
    'you', 'your', 'yours', 'yourself', 'yourselves'
  ]);

  function filterNliStopWords(text) {
    if (!text) return '';
    return text
      .split(/\s+/)
      .filter(w => {
        const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
        return clean.length > 2 && !NLI_STOP_WORDS.has(clean);
      })
      .join(' ');
  }

  function cleanMainUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const u = new URL(rawUrl);
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return String(rawUrl).split('?')[0].split('#')[0];
    }
  }

  function tabText(card) {
    const rawTitle = card.title || '';
    const title = rawTitle.replace(/\s*-\s*YouTube$/i, '').trim();
    const host = hostOf(card.url || card.domain || '');
    
    // Clean category & tags (drop noise like 'other' and deduplicate)
    const category = (card.enrichment?.category && card.enrichment.category !== 'other') 
      ? card.enrichment.category 
      : '';
    const rawTags = (card.enrichment?.tags || [])
      .map(t => (typeof t === 'string' ? t : t.tag))
      .filter(t => t && t !== 'other');
    const uniqueCatTags = Array.from(new Set([category, ...rawTags].filter(Boolean))).join(' ');

    const keywords = (card.structured?.keywords || [])
      .concat(card.enrichment?.subTopics || [])
      .filter(k => k && !['video', 'sharing', 'camera phone', 'video phone', 'free', 'upload'].includes(k.toLowerCase()))
      .slice(0, 15)
      .join(' ');

    // Filter stop words from mainText/pseudoDoc to maximize substantive keyword density
    let body = card.mainText || card.pseudoDoc || card.excerpt || '';
    if (body) {
      body = filterNliStopWords(body).slice(0, 1200);
    }

    // Structured Semantic Framing: Prevents subword token cross-attention false positives
    const parts = [];
    if (title) parts.push(`Page Title: ${title}.`);
    if (host) parts.push(`Website: ${host}.`);
    if (uniqueCatTags) parts.push(`Category: ${uniqueCatTags}.`);
    if (keywords || body) parts.push(`Content: ${[keywords, body].filter(Boolean).join(' ')}.`);

    const combined = parts.join(' ').replace(/\s+/g, ' ').trim();
    return combined.slice(0, MAX_TAB_CHARS);
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  }

  // A domain token is an exact host filter, not a fuzzy topic.
  //
  // Asking an NLI model whether a tab "is about youtube.com" is the wrong
  // question -- it is a string containment test, and entailment returned nothing
  // for every domain command until this short-circuit was added (bench: 16/25 ->
  // 19/25). The same bug exists in the generative path, which relies on the model
  // noticing the domain by itself.
  function matchDomains(candidates, domains) {
    return candidates.filter(c => {
      const host = hostOf(c.url) || (c.domain || '').toLowerCase();
      return domains.some(d => {
        const bare = d.replace(/^www\./, '');
        return host === bare || host.endsWith('.' + bare) || host.includes(bare);
      });
    });
  }

  /**
   * Select the tabs matching a command.
   *
   * opts.query  a structured query from llm-query.js. When absent, falls back to
   *             the deterministic concept-core parse, so this works with no
   *             model available.
   *
   * Returns the same shape reasonOverCandidates() produces, so runSemanticPipeline
   * can consume either without branching:
   *   { decision, matches: [{tabId, reason, confidence}], needDetails: [] }
   */
  async function select(cmd, candidates, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    const C = self.ConceptCore || require('./concept-core.js');
    const det = C.parseCommand(cmd);

    // The structured query, whether from the model or the deterministic parser.
    const q = opts.query || {
      concepts: det.concept ? [det.concept] : [],
      combine: 'union',
      expansions: {},
      domains: det.domains,
      isSelectAll: det.isSelectAll
    };
    const isSelectAll = q.isSelectAll ?? det.isSelectAll;
    const domains = (q.domains && q.domains.length) ? q.domains : det.domains;

    // "reload everything" names no concept: every candidate is the answer.
    if (isSelectAll) {
      return {
        decision: 'final',
        mode: 'select_all',
        matches: candidates.map(c => ({
          tabId: c.tabId, reason: 'Command targets all tabs', confidence: 1.0
        })),
        needDetails: []
      };
    }

    if (domains.length) {
      const hits = matchDomains(candidates, domains);
      return {
        decision: 'final',
        mode: 'domain',
        matches: hits.map(c => ({
          tabId: c.tabId,
          reason: `Domain match: ${domains.join(', ')}`,
          confidence: 1.0
        })),
        needDetails: []
      };
    }

    const concepts = (q.concepts && q.concepts.length) ? q.concepts : (det.concept ? [det.concept] : []);
    if (!concepts.length) {
      return { decision: 'final', mode: 'no_concept', matches: [], needDetails: [] };
    }

    console.log(`🤖 [NLI Select] Starting tab selection for concept(s): [${concepts.join(', ')}] across ${candidates.length} candidate tabs`);

    const zs = await load();

    // ---- Stage 1: cosine over EVERY tab, no model calls ------------------
    //
    // The query is embedded once (per concept, cached). Each tab already has its
    // embedding from index time, so this is a dot product per tab. Every tab
    // gets a score -- nothing is dropped, nothing is truncated, and the cost does
    // not grow with a model.
    const t0 = Date.now();
    let passes = 0, cached = 0, embedCalls = 0;
    // Tabs that needed a forward pass, counted once per tab rather than per
    // term, so it is directly comparable to the candidate count.
    const nliTabIds = new Set();

    const conceptVecs = new Map();
    if (embedFn) {
      for (const concept of concepts) {
        let v = conceptVecCache.get(concept);
        if (!v) {
          try {
            v = await embedFn(concept);
            embedCalls++;
            conceptVecCache.set(concept, v);
          } catch (e) {
            console.warn('[NLI] concept embed failed:', e.message);
          }
        }
        if (v) conceptVecs.set(concept, v);
      }
    }

    // cosineOf returns null when either side has no embedding -- a card built
    // before the embedder was warm, or no embedder at all. Null means "cosine
    // has no opinion", which routes the tab to NLI rather than silently
    // rejecting it. Degradation must not look like a decision.
    const cosScores = new Map();
    let stage1Accepted = 0, stage1Rejected = 0;
    for (const c of candidates) {
      let best = null;
      const cv = c.embedding && c.embedding.length ? c.embedding : null;
      if (cv) {
        for (const concept of concepts) {
          const qv = conceptVecs.get(concept);
          if (!qv) continue;
          const s = cosine(qv, cv);
          if (best === null || s > best) best = s;
        }
      }
      cosScores.set(c.tabId, best);
      if (best !== null && best >= BAND_HIGH) stage1Accepted++;
      else if (best !== null && best < BAND_LOW) stage1Rejected++;
    }

    let nliPending = 0;
    for (const c of candidates) {
      const cs = cosScores.get(c.tabId);
      if (cs === null || (cs < BAND_HIGH && cs >= BAND_LOW)) nliPending++;
    }
    
    console.log(`📊 [NLI Select] Stage 1 (Pure Cosine): ${stage1Accepted} confident yes (>=${BAND_HIGH}), ${stage1Rejected} confident no (<${BAND_LOW}), ${nliPending} uncertain band tabs routed to NLI`);

    if (typeof opts.onCosineDone === 'function') {
      try { opts.onCosineDone(nliPending, candidates.length); } catch (e) { /* UI only */ }
    }

    // ---- Stage 2: NLI only where cosine is uncertain ---------------------
    //
    // Confident yes (>= BAND_HIGH) and confident no (< BAND_LOW) are decided for
    // free. Only the middle band -- and tabs cosine could not score at all --
    // cost a forward pass. Measured at 1.9 passes/command versus 15 for scanning
    // everything, at identical set-exact.
    const perConcept = [];
    for (const concept of concepts) {
      const expansions = (q.expansions && q.expansions[concept]) || [];
      const expW = opts.expansionWeight ?? EXPANSION_WEIGHT;
      const terms = [
        { text: concept, w: 1 },
        ...(expW > 0 ? expansions.map(t => ({ text: t, w: expW })) : [])
      ];
      const scores = new Map();
      
      // Separate candidates: confident ones get assigned immediately, uncertain ones get batched
      const uncertainCandidates = [];
      for (const c of candidates) {
        const cs = cosScores.get(c.tabId);
        if (cs !== null && cs >= BAND_HIGH) {
          scores.set(c.tabId, Math.max(threshold, cs));
        } else if (cs !== null && cs < BAND_LOW) {
          scores.set(c.tabId, 0);
        } else {
          uncertainCandidates.push(c);
          nliTabIds.add(c.tabId);
        }
      }

      if (uncertainCandidates.length > 0) {
        for (const { text, w } of terms) {
          // Identify un-cached candidates for this term
          const toInfer = [];
          for (const c of uncertainCandidates) {
            const key = sha(text + '||' + tabText(c));
            if (!scoreCache.has(key)) {
              toInfer.push({ candidate: c, key, premise: tabText(c) });
            } else {
              cached++;
            }
          }

          // Execute un-cached candidates in batched WebGPU tensor passes
          if (toInfer.length > 0) {
            console.log(`🚀 [NLI Select] Stage 2: Dispatching ${toInfer.length} tabs to Offscreen Worker for batched NLI scoring against "${text}"...`);
            if (typeof opts.onProgress === 'function') {
              try { opts.onProgress(nliTabIds.size, nliPending); } catch (e) { /* UI only */ }
            }
            try {
              const premises = toInfer.map(item => item.premise);
              const batchOut = await inferZeroShotBatch(premises, [text], {
                multi_label: true,
                hypothesis_template: 'This browser tab is about {}.'
              });
              
              batchOut.forEach((res, idx) => {
                const s = Array.isArray(res?.scores) ? res.scores[0] : 0;
                scoreCache.set(toInfer[idx].key, s);
                passes++;
              });
              console.log(`✅ [NLI Select] Stage 2: Received batched NLI scores for ${batchOut.length} tabs`);
            } catch (err) {
              console.warn('⚠️ [NLI Select] Batch scoring error, falling back individually:', err.message);
              for (const item of toInfer) {
                try {
                  const singleOut = await inferZeroShot(item.premise, [text], {
                    multi_label: true,
                    hypothesis_template: 'This browser tab is about {}.'
                  });
                  const s = Array.isArray(singleOut?.scores) ? singleOut.scores[0] : 0;
                  scoreCache.set(item.key, s);
                  passes++;
                } catch (e) {
                  scoreCache.set(item.key, 0);
                }
              }
            }
            if (scoreCache.size > SCORE_CACHE_MAX) scoreCache.clear();
          }

          // Assign best scores for each uncertain candidate
          for (const c of uncertainCandidates) {
            const key = sha(text + '||' + tabText(c));
            const s = scoreCache.get(key) || 0;
            const weighted = s * w;
            const prev = scores.get(c.tabId) || 0;
            if (weighted > prev) scores.set(c.tabId, weighted);
          }
        }
      }
      perConcept.push(scores);
    }

    // Soft boolean algebra over the graded scores. Thresholding each concept to
    // a hard true/false before combining would bake a calibration decision into
    // the middle of the pipeline; min/max keeps the grading intact so a single
    // threshold at the end is the only cutoff.
    const combine = q.combine === 'intersection' ? 'intersection' : 'union';
    const matches = [];
    for (const c of candidates) {
      const vals = perConcept.map(m => m.get(c.tabId) ?? 0);
      const score = combine === 'intersection' ? Math.min(...vals) : Math.max(...vals);
      if (score >= UNCERTAIN_THRESHOLD) {
        matches.push({
          tabId: c.tabId,
          // Below `threshold` this lands under 0.5, which runSemanticPipeline
          // already routes to `uncertain` -- so abstention needs no new plumbing.
          confidence: score >= threshold ? score : score * 0.5,
          reason: score >= threshold
            ? `Entails "${concepts.join(combine === 'intersection' ? ' AND ' : ' OR ')}" (${score.toFixed(2)})`
            : `Weak match (${score.toFixed(2)})`
        });
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);
    const elapsed = Date.now() - t0;

    // Every tab is scored. There is no truncation to report and no budget to
    // trip -- what this line now shows is how the work SPLIT: how many tabs
    // cosine settled for free versus how many needed a forward pass. If passes
    // ever approaches the tab count, the band has stopped discriminating and
    // that is the thing to investigate.
    const msPer = passes ? Math.round(elapsed / passes) : 0;
    const nliTabs = nliTabIds.size;
    const decidedFree = candidates.length - nliTabs;
    console.log(
      `[NLI] ${candidates.length} tabs: ${decidedFree} by cosine (free), ${nliTabs} by NLI ` +
      `-> ${passes} passes (+${cached} cached, ${embedCalls} embeds) in ${elapsed}ms` +
      (passes ? ` = ${msPer}ms/pass` : '') +
      (ortStatus ? `  [simd=${ortStatus.simd ?? '?'}]` : '')
    );
    return {
      decision: 'final', mode: 'nli', concepts, combine, matches,
      needDetails: [],
      stats: {
        passes, cached, embedCalls, ms: elapsed, msPerPass: msPer,
        scanned: candidates.length, available: candidates.length,
        nliTabs, cosineTabs: decidedFree
      }
    };
  }

  const NliSelect = {
    select, load, tabText, setEmbedder, MODEL_ID,
    DEFAULT_THRESHOLD, UNCERTAIN_THRESHOLD, BAND_LOW, BAND_HIGH,
    // Exposed so the extension can report which WASM build actually loaded
    // rather than assuming the configuration took effect.
    ortStatus: () => ortStatus,
    // Test seam: lets a bench inject a fake classifier instead of downloading
    // 83MB, and lets tests assert how many forward passes were actually spent.
    __setClassifierForTest(fn) { classifier = fn; loading = null; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NliSelect;
  if (typeof self !== 'undefined') self.NliSelect = NliSelect;
})();
