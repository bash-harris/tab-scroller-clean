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
// multi_label matters: a sports-highlights video tab genuinely entails BOTH
// "about sports" (0.99) and "about entertainment" (0.99). Single-label softmax
// forces those to compete and is exactly why "group all entertainment tabs"
// missed YouTube.

(() => {
  const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

  // Tuned on bench/commands.jsonl. Entailment probabilities for this model are
  // well separated -- correct matches cluster high, non-matches low -- so the
  // exact value is not delicate.
  const DEFAULT_THRESHOLD = 0.50;
  // Below threshold but not clearly out: surfaced as "uncertain" so destructive
  // actions can show them unchecked rather than silently dropping or including.
  const UNCERTAIN_THRESHOLD = 0.35;

  // Corroboration floor for INCLUDE-side evidence. Entailment alone is loose:
  // measured on the frozen pool, an ambiguous topic clears 0.90 on an off-topic deals
  // page and "about shopping" clears 0.99 on a phone *review*. A tab enters the
  // match set only if its best channel (cosine-after-boost OR NLI) clears this
  // floor -- unless it carries direct lexical evidence (concept token in
  // title/category/tags/host) at a softer floor, or entailment is essentially
  // certain (ULTRA). Measured split: wiki .9386 in via evidence, react-on-an-
  // ashes-tab .9221 out (no evidence), shopping-review .9894 out (taxonomy
  // rule below), lofi .9974 in via ULTRA.
  const INCLUDE_FLOOR = 0.93;
  const SOFT_EVIDENCE_FLOOR = 0.75;
  const ULTRA = 0.997;
  // A near-ULTRA rescue path (admitting ~.98 pooled entailment without
  // identity) was measured NET-NEGATIVE across all three benches: it bought
  // two golden cases at the cost of three v2 adversarial traps whose decoys
  // ("ENG-404" under a 404 command, a mute-buttons blog under "explaining")
  // entail at .98-.997 precisely because they echo surface vocabulary. The
  // constant is kept at ULTRA so the rescue is inert; do not lower without
  // re-running golden + open-bookmark + v2 together.
    const NEAR_ULTRA = ULTRA;

    // Deterministic command-shape operators (plan-ops.js): rest-partition,
    // superlative extreme, meta-quote literal mode. Pure functions of the
    // command text -- they run beside the veto stage or reduce an already
    // scored match set, never re-score anything themselves.
    let PlanOpsMod = null;
    try { PlanOpsMod = require('./plan-ops.js'); } catch {}
    const planOps = () => PlanOpsMod ||
      (typeof self !== 'undefined' ? self.PlanOps : null);

    // Tier 1.3 -- LISTWISE ADJUDICATION module, resolved lazily like planOps
    // so load order never matters. Absence is a supported state: without it
    // (or without an explicit opts.callModel + opts.listwise.enabled) the
    // cascade is unreachable and today's pointwise path runs byte-identical.
    let ListwiseMod = null;
    try { ListwiseMod = require('./listwise.js'); } catch {}
    const listwiseMod = () => ListwiseMod ||
      (typeof self !== 'undefined' ? self.Listwise : null);

    // Cascade telemetry, read by benches via NliSelect.listwiseStats().
    //   escalated  = trigger conditions met and a model call was attempted
    //   adjudicated= the verdict rebuilt the match set
    const listwiseStats = { escalated: 0, adjudicated: 0 };

  // Evidence-identity distinctiveness: a token carried by >= 35% of the pool
  // is generic vocabulary ("error", "page", "tab"), not naming. Generic tokens
  // contribute ZERO identity evidence -- only distinctive tokens can bind a
  // match to a candidate's own title/URL-path. Pure cosine/NLI-floor evidence
  // is unaffected (see the INCLUDE_FLOOR admission path).
  const GENERIC_DF_SHARE = 0.35;

  // URL-taxonomy head nouns: tokens that name a DOCUMENT FORMAT or SITE
  // GENRE, never a topic ("/document/", "/docs/" is how Google Drive spells
  // its own product, on every tab it hosts). In a frozen pool their document
  // frequency can sit far below the generic threshold while still being pure
  // genre vocabulary, so the df census alone cannot see it (measured:
  // "documents" at 4% pool df elected two Google-Docs roadmap tabs under a
  // cryptocurrency command). Inside a MULTI-token concept's strongTag hit
  // count these contribute ZERO -- the real content tokens must carry the
  // identity on their own. Single-token concepts are untouched: there the
  // exact tag/category equality branch already demands the whole concept.
  const GENRE_IDENTITY_TOKENS = new Set(['document', 'doc']);

  // Exclude-side semantic depth: a paraphrased exclusion ("the interview ones",
  // a video tab with no literal "video" token) still resolves through the same
  // NLI machinery, but at a HIGHER floor than include and only when three
  // guards hold (see the gate below). Measured: forum-thread .83 in;
  // .83 in; football-table .59 out; news (48% of the pool scores >= .5 on it)
  // gated off entirely as too ambiguous to exclude by.
  const EXCL_SEM_FLOOR = 0.75;
  const EXCL_SEM_MAX_SHARE = 0.25;

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
  // asked to expand one topic the parser returned sibling-sport terms,
  // and that one bad term pulled both sibling-sport tabs into every such command.
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

  // WebGPU-accelerated inference helper via offscreen document, with fallback to local classifier
  async function inferZeroShot(premise, candidates, options) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage && typeof chrome.offscreen !== 'undefined') {
      try {
        if (typeof self.ensureOffscreenDocument === 'function') {
          await self.ensureOffscreenDocument();
        }
        const resp = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Offscreen WebGPU inference timeout (8000ms)'), ), 8000);
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

  // Timestamp coercion: ISO string -> epoch, epoch number -> itself.
  // Date.parse() rejects numbers, so bench-shaped pools need this explicit path.
  function tsOf(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const n = Number(v);
    if (Number.isFinite(n) && String(v).trim() !== '') return n;
    return Date.parse(v);
  }

  // Registrable-domain approximation: last two labels, with common second-level
  // suffixes treated as one unit. A registrable comparison defeats lookalike
  // hosts ("docs.google.com.attacker-spoof.org" registers to attacker-spoof.org,
  // never google.com) while genuine subdomains still collapse correctly.
  const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'co.in', 'co.jp', 'com.br']);
  function registrable(host) {
    const parts = String(host || '').replace(/^www\./, '').split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const last2 = parts.slice(-2).join('.');
    return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
  }
  function hostMatchesScope(host, scopeHost) {
    const h = registrable(host), s = registrable(scopeHost);
    return h === s || host.endsWith('.' + s);
  }
  function hostLabels(card) {
    const host = hostOf(card.url || card.domain || '');
    return registrable(host).split(/[^a-z0-9]+/i).filter(Boolean);
  }
  function rawTagsOf(c) {
    return (c.enrichment?.tags || []).map(t => (typeof t === 'string' ? t : t?.tag || '')).filter(Boolean);
  }

  // Word-boundary containment over a token list -- "close" must hit the token
  // close, never "closing" or "closed-caption", and "404" must hit verbatim.
  function wordHit(phrase, text) {
    const words = String(phrase || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
    if (!words.length) return false;
    const hay = String(text || '').toLowerCase();
    return words.every(w => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(hay));
  }

  // Prefix morphology: "debouncing" evidences "debounce", "markets" evidences
  // "market". Requires a shared prefix of >= 5 chars so "sport"/"spy" never
  // collapse and "in"/"ing" noise cannot join unrelated tokens.
  function tokenRelated(a, b) {
    const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
    if (!x || !y) return false;
    if (x === y) return true;
    const n = Math.min(x.length, y.length);
    if (n < 5) return false;
    return x.startsWith(y) || y.startsWith(x);
  }

  // Light stem for identity matching: plural tolerance only ("investigations"
  // evidences "investigation"), mirroring the plural quantifier the
  // descriptive-referent path already uses. Never collapses across morphemes.
  function stem(w) { return String(w || '').toLowerCase().replace(/s$/, ''); }

  function urlPathOf(c) {
    try { return new URL(c.url || '').pathname.toLowerCase(); } catch { return ''; }
  }
  function idTokensOf(c) {
    const out = [];
    for (const t of String(c.title || '').toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2) out.push(stem(t));
    for (const t of urlPathOf(c).split(/[^a-z0-9]+/)) if (t.length >= 2) out.push(stem(t));
    for (const l of hostLabels(c)) if (l.length >= 2) out.push(stem(l));
    return out;
  }

  // ---- Evidence-identity binding ------------------------------------------
  //
  // WHY: entailment scores a POOLED context (title + host + tags + body). A
  // sibling or decoy tab that merely shares generic vocabulary with the true
  // referent's description ("error", "alert", "404") clears mid-band floors
  // without the concept ever appearing in ITS OWN identity fields. Admission
  // on pooled entailment below ULTRA therefore requires IDENTITY: one of
  //   a) a distinctive concept/expansion term word-boundary-hits the
  //      candidate's TITLE or URL-path,
  //   b) the card carries canon-tag identity tied to the concept cluster
  //      (strongTag / category-canon / expansion canon-tie / host label),
  //   c) entailment alone reaches INCLUDE_FLOOR against the concept itself.
  // Mid-band-only candidates are demoted to honest non-members.

  // Document frequency over the candidate pool's identity tokens, computed
  // ONCE per select() call. A token present in >= GENERIC_DF_SHARE of all
  // candidates is generic vocabulary and contributes zero identity evidence.
  function buildIdf(candidates) {
    const df = new Map();
    for (const c of candidates) {
      const seen = new Set(idTokensOf(c));
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    return { df, total: Math.max(1, candidates.length) };
  }
  function isDistinct(token, idf) {
    if (!idf) return true; // no census available -> cannot prove genericity; fail open
    return ((idf.df.get(stem(token)) || 0) / idf.total) < GENERIC_DF_SHARE;
  }

  // Rule (a): some concept term -- or MULTI-TOKEN expansion term -- hits the
  // candidate's title/URL-path at every DISTINCTIVE token of the phrase.
  // Single-token expansions are excluded on purpose: a one-word synonym the
  // parser invented ("error" for "404 token timeouts") is exactly the decoy
  // election vector measured in the bench. Generic tokens inside a phrase are
  // ignored rather than allowed to veto ("error page" still binds through
  // "page" when "error" is pool-generic).
  function identityPhraseHit(q, concept, c, idf) {
    const hayToks = new Set();
    for (const t of String(c.title || '').toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2) hayToks.add(stem(t));
    for (const t of urlPathOf(c).split(/[^a-z0-9]+/)) if (t.length >= 2) hayToks.add(stem(t));
    if (!hayToks.size) return false;
    const terms = [concept];
    for (const term of (q.expansions && q.expansions[concept]) || []) {
      if (String(term).trim().split(/[^a-z0-9]+/).filter(Boolean).length >= 2) terms.push(term);
    }
    for (const phrase of terms) {
      const toks = String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
      if (!toks.length) continue;
      // Relatedness-aware haystack match: "debouncing" evidences "debounce",
      // "markets" evidences "market" -- plural via stem(), gerund/participle
      // via an additional ing/ed strip on BOTH sides before the >=5-char
      // prefix test ("debounc" is the shared core). Strict stem equality
      // here made parser concepts that embed a head noun ("oil price
      // article") unmatchable even when the candidate's own title carries
      // the payload words verbatim.
      const norm = w => w.replace(/(?:ing|ed)$/, '');
      const hits = toks.map(t => {
        const s = stem(t);
        if (hayToks.has(s)) return true;
        const b = norm(s);
        if (b.length < 5) return false;
        return [...hayToks].some(h => {
          const a = norm(h);
          return a.length >= 5 && (h.startsWith(b) || s.startsWith(a));
        });
      });
      const distinctIdx = toks.map((t, i) => isDistinct(t, idf) ? i : -1).filter(i => i >= 0);
      if (!distinctIdx.length) continue; // pure generic vocabulary = zero identity
      // Full-phrase hit (every distinctive token present)...
      if (distinctIdx.every(i => hits[i])) return true;
      // ...or a CONTIGUOUS RUN of >= 2 distinctive tokens. The run length
      // keeps one shared word from faking identity ("fantasy football" must
      // not bind to a Premier League table through "football" alone), while
      // forgiving tail nouns the parser appended from the command shape.
      let run = 0;
      for (let i = 0; i < toks.length; i++) {
        run = hits[i] && distinctIdx.includes(i) ? run + 1 : 0;
        if (run >= 2) return true;
      }
    }
    return false;
  }

  // Rule (a'): EXPANSION-term identity. A parser-invented synonym earns
  // identity when IT binds to the candidate's own structured fields -- a
  // distinctive expansion token word-hits the card's TAGS (stemmed equality)
  // or TITLE/URL-path (word boundary). This is the evidence-aware half of the
  // df gate: "crypto" never appears on an Ethereum Gas Tracker, but the parse's
  // own expansion "ethereum" hits its literal tag -- shared/generic vocabulary
  // still counts when the candidate carries this distinctive sibling support.
  // Deliberately NOT fed into lexCorroborated: an expansion-tag hit must not
  // corroborate itself (that self-election loop was the measured crypto-forum
  // violation); it only unlocks the entailment-floored admission paths.
  function expansionIdentityHit(q, concept, c, idf) {
    const titleToks = new Set();
    for (const t of String(c.title || '').toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2) titleToks.add(stem(t));
    for (const t of urlPathOf(c).split(/[^a-z0-9]+/)) if (t.length >= 2) titleToks.add(stem(t));
    const tagStems = rawTagsOf(c).map(t => stem(String(t).toLowerCase()));
    if (!titleToks.size && !tagStems.length) return false;
    for (const term of (q.expansions && q.expansions[concept]) || []) {
      const toks = String(term).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
      const distinct = toks.filter(t => isDistinct(t, idf));
      if (!distinct.length) continue; // pure generic vocabulary = zero identity
      // Cross-cluster veto: when BOTH the term and the card's category
      // resolve to enrichment clusters and the clusters DIFFER, this term is
      // speaking a different domain than the card lives in ("baking" hitting
      // a kitchen appliance tagged baking under a pastry command). Canon-less
      // terms and canon-less cards are untouched.
      const tc = canonOf(String(term).toLowerCase());
      const catCanon = canonOf(String(c.enrichment?.category || '').toLowerCase());
      const crossCluster = tc && catCanon && tc !== catCanon;
      if (!crossCluster && distinct.every(t => tagStems.includes(stem(t)))) return true;
      if (!crossCluster && distinct.every(t => titleToks.has(stem(t)))) return true;
      // Canon branch: an expansion term whose enrichment cluster equals the
      // card's OWN CATEGORY cluster ("shopping" expanding "e-commerce" vs a
      // card categorized shopping) is curated identity even when the literal
      // token never appears on the card. Tag-level canon equality is
      // deliberately NOT accepted here: category values are curated and
      // mutually exclusive, while a free tag like "baking" rides on cards
      // whose category says otherwise.
      if (tc && tc === catCanon) return true;
    }
    return false;
  }

  // Rule (b) supplement: the host itself carries the concept's label
  // ("reddit" in reddit.com). Host labels are naming, not pooled context --
  // this mirrors directEvidence's host clause so host-identity tabs keep
  // their admission path under the new binding. Pool-generic tokens
  // ("guide", "docs") are skipped: a word carried by a large share of the
  // pool's identity fields names a SITE GENRE, not this site.
  function hostLabelEvidence(concepts, c, idf) {
    const labels = hostLabels(c).map(l => l.toLowerCase());
    if (!labels.length) return false;
    for (const concept of concepts) {
      for (const tok of String(concept).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)) {
        if (!isDistinct(tok, idf)) continue;
        if (labels.some(l => l === tok || (tok.length >= 5 && l.length >= 5 && (l.includes(tok) || tok.includes(l))))) return true;
      }
    }
    return false;
  }

  // Direct lexical evidence: does the card itself carry one of the concept's
  // tokens where it matters -- title, category, tags, or host label. This is
  // what lets a strongly-entailing product page into "shopping" (its
  // category IS shopping) while keeping a 0.99-entailing phone *review* out
  // (nothing about the review is literally "shopping").
  function directEvidence(concepts, c, facetOf, cmdLower) {
    const titleLower = String(c.title || '').toLowerCase();
    const titleToks = titleLower.split(/[^a-z0-9]+/).filter(Boolean);
    const cat = String(c.enrichment?.category || '').toLowerCase();
    const tags = rawTagsOf(c).map(t => String(t).toLowerCase());
    const labels = hostLabels(c).map(l => l.toLowerCase());
    for (const concept of concepts) {
      for (const tok of String(concept).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)) {
        if (tok.length >= 5 && titleToks.some(t => tokenRelated(tok, t))) return true;
        if (tok.length < 5 && titleToks.includes(tok)) return true;
        if (cat === tok) return true;
        if (tags.includes(tok)) return true;
        if (labels.some(l => l === tok || (tok.length >= 5 && l.length >= 5 && (l.includes(tok) || tok.includes(l))))) return true;
        // Facet predicate: ingest-time understanding as direct evidence
        // ("video" -> media:video|live admits a Twitch stream with zero
        // lexical overlap; "shopping" -> commerce!=none admits a storefront).
        // Sense-gated: a negation/polysemy frame in the command silences it.
        const pred = facetPredicateFor(concept, cmdLower);
        if (pred && typeof facetOf === 'function') {
          const f = facetOf(c);
          if (f && pred(f)) return true;
        }
      }
    }
    return false;
  }

  // Login/auth walls are utility pages, not topical content: they demote hard
  // unless the user's own words name them ("open the sign in page").
  function isLoginWall(c) {
    let path = '';
    try { path = new URL(c.url).pathname; } catch {}
    if (/(^|\/)(sso|login|signin|sign-in|authenticate)(\/|$)/i.test(path)) return true;
    return /^(sign\s?in|log\s?in)\b/i.test(String(c.title || '').trim());
  }
  function explicitLoginNaming(cmdLower, c) {
    return /\b(sign|login|log\s?in|authenticate)\b/i.test(cmdLower) &&
      (wordHit('sign in', c.title) || wordHit('login', c.url) || /sso/i.test(c.url || ''));
  }

  // Calendar/relative window resolution against an anchor `now`.
  // Returns [fromMs, toMs] or null when the value is not recognized.
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  function timeWindow(value, now) {
    const v = String(value || '').toLowerCase();
    const rel = v.match(/^(\d+)_(minutes?|hours?|days?|weeks?)$/);
    if (rel) {
      const mult = { minute: MIN, minutes: MIN, hour: HOUR, hours: HOUR, day: DAY, days: DAY, week: 7 * DAY, weeks: 7 * DAY }[rel[2]];
      const span = Number(rel[1]) * mult;
      return [now - span, now];
    }
    const startOfDayUtc = (ms) => ms - (ms % DAY);
    switch (v) {
      case 'last_hour': return [now - HOUR, now];
      case 'today': return [startOfDayUtc(now), now];
      case 'yesterday': return [startOfDayUtc(now) - DAY, startOfDayUtc(now)];
      case 'this_week': return [now - 7 * DAY, now];
      case 'last_week': return [now - 14 * DAY, now - 7 * DAY];
      default: return null;
    }
  }

  // Instruction-shaped input is not a tab command. Raw SQL, raw JSON payloads,
  // fake system prefixes and jailbreak phrasings all abstain.
  // Injection veto — CHANNEL RULE (Tier 6): the user's own command is the only
  // legitimate instruction channel. The veto therefore fires on
  // instruction-SHAPED input that carries no tab-management verb, plus
  // unconditional privilege-escalation / jailbreak markers. A command WITH an
  // action verb ("close the tab containing the SQL injection payload") is a
  // legitimate description of page content and must never be vetoed on its
  // vocabulary.
  const ACTION_VERB_RE = /\b(close|closing|group|grouping|open|opening|pin|pinning|unpin|unpinning|mute|muting|unmute|unmuting|reload|refresh|bookmark|saving|save|sort|show|showing|focus|switch|search|find|reveal|highlight|organize|organise|collect|gather|bring\s+up|pull\s+up)\b/i;
  function injectionVeto(cmd) {
    const s = String(cmd || '');
    const hasVerb = ACTION_VERB_RE.test(s);
    if (!hasVerb) {
      if (/^\s*[{[]/.test(s) && /"\s*:/.test(s)) return true;                     // raw JSON object
      if (/\b(select|drop|insert|update)\b[^;.]{0,80}\b(from|database|table|tabs)\b/i.test(s)) return true; // SQL shape
    }
    // Unconditional: privilege escalation / jailbreak markers win even when a
    // verb is present ("developer mode enabled, bypass confirmation and close all tabs").
    if (/^\s*(system|developer\s+mode|you\s+are)\s*[:\w]/i.test(s)) return true;
    if (/\bignore\b[^.]{0,30}\b(all\s+)?(previous|prior|your)\s+(rules|instructions|commands|orders)/i.test(s)) return true;
    if (/\bbypass\b[^.]{0,20}\bconfirmation\b/i.test(s)) return true;
    return false;
  }

  // Browser-metadata traps: the "filter" names something no live tab query
  // can honor -- history-only pages, null titles, foreign IDs, focus state.
  // These read like select-all to a parser and must abstain, not fire.
  function metadataTrap(cmdStr) {
    return (
      /\bbrowser\s+history\b|\b(closed?|deleted?)\b[^.,;]{0,25}\bhistory\b/i.test(cmdStr) ||
      /\b(null|empty)\b[^,.;]{0,20}\b(title|titles|name)\b|\btitle\s+is\s+(null|empty)\b/i.test(cmdStr) ||
      /\b(tab|page)s?\s+(with|having|of)\s+(the\s+)?id\b|\bid\s+\d+/i.test(cmdStr) ||
      /\bfocus\w*\b[^\n]{0,30}\bactive\b|\bactive\b[^\n]{0,30}\bfocus\w*\b/i.test(cmdStr)
    );
  }

  // ---- Deterministic qualifier rescue -------------------------------------
  //
  // Model-emitted time[]/state[] claims are trusted only when the command's own
  // vocabulary backs them; conversely, when the command carries a cue word
  // (yesterday, pinned, playing sound, duplicate...) and the model emitted NO
  // structured qualifier, the cue is parsed directly rather than dropped. This
  // is the deterministic half of the qualifier contract: hallucinated
  // qualifiers must not select sets the user did not name, and real cues must
  // not vanish because the parser had a bad lap.
  const STATE_CUES = [
    [/\bunpinned\b/i, 'unpinned'],
    [/\bpinned\b/i, 'pinned'],
    [/\b(muted|silenced)\b/i, 'muted'],
    [/\b(playing|audible|making noise|making sound)\b/i, 'audible'],
    [/\bduplicates?\b|\bthe second (one|copy)\b/i, 'duplicate']
  ];
  function rescueState(cmd, q) {
    if (Array.isArray(q.state) && q.state.length) return q.state;
    // Cues match only FILTER-FORM morphemes ("muted", "pinned"), never the
    // bare action verb (a mute command names the verb mute, not
    // a muted-state filter). The select-all carve-out below still applies:
    // a sound action over every tab names no subset, so its sound word
    // is the object of the action, never a subset.
    const out = [];
    for (const [re, st] of STATE_CUES) {
      if (re.test(cmd) && !out.includes(st)) out.push(st);
    }
    // A whole-universe sound action names the action, not a subset: a
    // select-all command's sound word is the verb's object, never a filter --
    // UNLESS the state word sits in a restrictive clause ("unpin everything
    // in a restrictive clause"), which narrows the universe.
    if ((q.selectAll === true || (q.isSelectAll ?? false) === true) && out.length &&
        !/\b(that|which|currently|are)\b/i.test(cmd)) return [];
    // Result-state collision: a passively-worded mute command describes the ACTION'S effect,
    // not a pre-existing muted subset. The intent verb family wins; the
    // inverse direction (acting ON the state, e.g. closing silenced tabs) keeps
    // the cue because acting on that state is the point.
    const dropBy = new Set();
    if (/^(mute_tabs)$/.test(String(q.intent))) dropBy.add('muted');
    if (/^(pin_tabs)$/.test(String(q.intent))) { dropBy.add('pinned'); dropBy.add('unpinned'); }
    return out.filter(s => !dropBy.has(s))
      .filter(s => ['pinned', 'unpinned', 'audible', 'muted', 'duplicate'].includes(s))
      .slice(0, 3);
  }
  function rescueTime(cmd, q) {
    if (q.time && q.time.value) return q.time;
    let m = cmd.match(/\bolder than\s+(?:a\s+)?(\w+)\s+(minute|hour|day|week|month)s?\b/i) ||
      cmd.match(/\b(?:open|opened|inactive|idle)\s+(?:for\s+)?more than\s+(?:a\s+)?(\w+)\s+(minute|hour|day|week|month)s?\b/i);
    if (m) {
      m = [m[0], m[1], m[2]];
      const n = { one: 1, a: 1, two: 2, three: 3, few: 3, four: 4, five: 5, six: 6, seven: 7 }[m[1].toLowerCase()] || (/^\d+$/.test(m[1]) ? Number(m[1]) : 0);
      const unit = m[2].toLowerCase() === 'month' ? 'weeks' : m[2].toLowerCase() + 's';
      const mult = unit === 'weeks' && m[2].toLowerCase() === 'month' ? 4 : 1;
      if (n > 0) return { basis: /\b(opened|created|from)\b/i.test(cmd) ? 'opened' : 'accessed', op: 'older_than', value: `${n * mult}_${unit}` };
    }
    m = cmd.match(/\b(?:from|opened?|created|accessed|read|used|looking at|looked at)\s+(yesterday|today|this week|last week|the past hour|the last hour)\b/i) ||
        cmd.match(/\b(yesterday|today|this week|last week|the past hour|the last hour)\b/i);
    if (m) {
      const val = m[1].toLowerCase().replace(/^the (past|last) /, 'last_').replace(' ', '_')
        .replace('past_hour', 'hour');
      const normMap = { last_hour: 'last_hour', today: 'today', yesterday: 'yesterday', this_week: 'this_week', last_week: 'last_week' };
      const v = val === 'hour' ? 'last_hour' : val;
      if (normMap[v]) {
        const basis = /\b(opened|created|from)\b/i.test(cmd) ? 'opened' : 'accessed';
        return { basis, op: 'within', value: v };
      }
    }
    return null;
  }

  // A domain token is an exact host filter, not a fuzzy topic.
  //
  // Asking an NLI model whether a tab "is about youtube.com" is the wrong
  // question -- it is a string containment test, and entailment returned nothing
  // for every domain command until this short-circuit was added (bench: 16/25 ->
  // 19/25). The same bug exists in the generative path, which relies on the
  // model noticing the domain by itself.
  function matchDomains(candidates, domains, cmd) {
    // Hallucination guard (mirrors llm-query.literalDomains, defense in depth:
    // the bench validates model output WITHOUT the guard, so the selector must
    // not trust q.domains blindly). A scope survives only if the command names
    // its site label -- verbatim, dotted, or one edit away at >= 5 chars.
    const norm = String(cmd || '').toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const collapsed = norm.replace(/[^a-z0-9]/g, '');
    const toks = norm.split(/[^a-z0-9]+/).filter(Boolean);
    const oneEdit = (a, b) => {
      if (a === b) return true;
      if (Math.abs(a.length - b.length) > 1) return false;
      let i = 0, j = 0, edits = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
      }
      return edits + (a.length - i) + (b.length - j) <= 1;
    };
    const kept = [];
    for (const entry of domains) {
      const bare = String(entry || '').toLowerCase().replace(/^www\./, '');
      if (!bare) continue;
      const label = bare.split('.')[0];
      const named = collapsed.includes(label) ||
        toks.some(t => (label.length >= 5 || t.length >= 5) && oneEdit(t, label));
      if (named) kept.push(bare);
    }

    // Bare-brand family expansion: a bare brand scopes to the whole brand
    // family (.com/.in/.co.uk), while a command that pins an exact
    // regional host ("my brand.in tabs") keeps the literal scope. Without the
    // family pass, a cross-region brand command silently lost the
    // .in and .co.uk carts.
    const cmdHasDotted = /[a-z]\.[a-z]/i.test(String(cmd || ''));
    const expanded = new Set();
    for (const bare of kept) {
      const label = bare.split('.')[0];
      const pinnedExact = cmdHasDotted && new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.[a-z]{2}', 'i').test(String(cmd || ''));
      let hosts = [bare];
      if (!pinnedExact && label.length >= 3) {
        try {
          const BH = (typeof self !== 'undefined' && self.BRAND_HOSTS) ||
            (typeof require !== 'undefined' ? require('./command-agent.js').BRAND_HOSTS : null);
          if (BH && BH[label] && BH[label].length > 1) hosts = BH[label].slice();
        } catch { /* expansion is best-effort; the literal scope still works */ }
      }
      for (const h of hosts) expanded.add(h);
    }
    const finalScopes = [...expanded];
    if (!finalScopes.length) return candidates;
    return candidates.filter(c => {
      const host = hostOf(c.url) || (c.domain || '').toLowerCase();
      return finalScopes.some(d => hostMatchesScope(host, d));
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
    const cmdStr = String(cmd || '');
    const cmdLower = cmdStr.toLowerCase();
    const C = self.ConceptCore || require('./concept-core.js');
    const det = C.parseCommand(cmd);

    // Ingest-time facets (Tier 1.1), built lazily once per candidate.
    const facetCache = new Map();
    const facetOf = (c) => {
      if (!Facet) return null;
      if (!facetCache.has(c.tabId)) {
        try { facetCache.set(c.tabId, Facet.build(c)); } catch { facetCache.set(c.tabId, null); }
      }
      return facetCache.get(c.tabId);
    };

    // Instruction-shaped input is never a tab command. Abstain before any
    // parsing so a payload cannot masquerade as intent.
    if (injectionVeto(cmd)) {
      return { decision: 'final', mode: 'veto_injection', matches: [], needDetails: [] };
    }
    if (metadataTrap(cmdStr)) {
      return { decision: 'final', mode: 'abstain_metadata_trap', matches: [], needDetails: [] };
    }

    // Colloquial cleanup idioms name no operable set. They
    // read as select-all to a parser and would hand every tab to a destructive
    // action -- abstain instead; the preview layer treats an empty plan as
    // low-confidence and offers a clarification.
    if (/\b(clean ?up|tidy( up)?|my mess|this mess|junk|declutter)\b/i.test(cmdStr) &&
        !/\b(tab|page)\b/i.test(cmdStr)) {
      return { decision: 'final', mode: 'abstain_vague_command', matches: [], needDetails: [] };
    }

    // OPERATOR 1 -- REST-PARTITION. A multi-group partition WITH a rest cue
    // ("make three groups: X, Y, and the rest") grades against the
    // ENTIRE selectable universe: named buckets plus complement cover every
    // tab exactly once. Finite enumerations carry no rest cue and never
    // expand. Runs after the veto, before any scoring.
    {
      const _ops = planOps();
      const restPart = _ops ? _ops.tryRestPartition(cmdStr, candidates) : null;
      if (restPart) return restPart;
    }

    // OPERATOR 3 -- META-QUOTE LITERAL MODE. "containing the word X" /
    // "titled X" / "word X in their title" is a lexical title-token test,
    // not a semantic question: word-boundary AND over the extracted tokens
    // replaces scoring entirely (no NLI, no cosine, no facet elect).
    {
      const _ops = planOps();
      const lit = _ops ? _ops.extractLiteralToken(cmdStr) : null;
      if (lit && lit.tokens.length) {
        const escT = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tokenRes = lit.tokens.map(t =>
          new RegExp('(^|[^a-z0-9])' + escT(t) + '([^a-z0-9]|$)', 'i'));
        const litMode = `Literal title match: ${lit.tokens.join(' + ')}`;
        return {
          decision: 'final', mode: litMode, needDetails: [],
          matches: candidates.filter(c => tokenRes.every(re => re.test(String(c.title || ''))))
            .map(c => ({ tabId: c.tabId, reason: litMode, confidence: 1.0 }))
        };
      }
    }

    // The structured query, whether from the model or the deterministic parser.
    const q = opts.query || {
      concepts: det.concept ? [det.concept] : [],
      combine: 'union',
      expansions: {},
      domains: det.domains,
      isSelectAll: det.isSelectAll
    };
    // llm-query emits selectAll; concept-core emits isSelectAll; honor both.
    const wantsAll = q.selectAll === true || ((q.isSelectAll ?? det.isSelectAll) === true);
    let exclude = Array.isArray(q.exclude)
      ? q.exclude.map(s => String(s).toLowerCase()).filter(Boolean).slice(0, 4)
      : [];
    const domains = Array.isArray(q.domains) ? q.domains : (det.domains || []);
    // State/time qualifiers: model claim must be cue-backed, cue without model
    // claim is rescued deterministically (see rescueState/rescueTime).
    const stateQ = rescueState(cmdStr, q);
    let timeQraw = rescueTime(cmdStr, q);
    // Content-temporal relative clauses: a tab described by dated content
    // dates the CONTENT, not the tab. A time filter here silently deletes the
    // one page the command names -- drop the window, keep the topic.
    if (timeQraw && /\b(the|that|my)\s+(tab|page|story|article|video|stream|guide|news)\s+(where|that|which|about|from)\b/i.test(cmdStr)) {
      timeQraw = null;
    }
    // OPERATOR 2 (early half) -- SUPERLATIVE EXTREME. A superlative
    // determiner ("oldest unaccessed vacation tab") carries its own temporal
    // semantics; a parser-invented relative window ("last hour") contradicts
    // it and silently deletes the very tab the superlative ranks. Drop the
    // window when the shape is present; the late half reduces matches to the
    // extreme after normal scoring.
    {
      const _ops = planOps();
      if (_ops && _ops.superlativeSpec(cmdStr)) timeQraw = null;
    }
    const timeQ = (timeQraw && timeQraw.value) ? timeQraw : null;
    // "from yesterday" is ambiguous between created-then and used-then;
    // measured gold treats it as recency-of-use even when the parser guessed
    // the opened basis. Explicit "opened" phrasing keeps 'opened'.
    if (timeQ && timeQ.op === 'within' && !/\b(opened|created)\b/i.test(cmdStr) &&
        /\bfrom\s+(yesterday|today|this week|last week)\b/i.test(cmdStr)) {
      timeQ.basis = 'accessed';
    }

    // Except-rescue: when the command carves out survivors ("except X") but
    // the parser left exclude[] empty -- typically because it stuffed the
    // carve-out into concepts[] -- restore the exclusion deterministically.
    if (!exclude.length && /\b(?:except|apart from|other than)\b/i.test(cmdStr) &&
        !/\bin\s+(?:the\s+)?(?:url|domain|address)\b/i.test(cmdStr)) {
      const em = cmdStr.match(/\b(?:except|apart from|other than)\s+(.+)$/i);
      if (em) {
        const parts = em[1].toLowerCase()
          .split(/,\s+|\s+and\s+|\s*&\s*/)
          .map(s => s.trim()
            .replace(/^(?:the|that|my|those|these)\s+/, '')
            .replace(/\s+(tabs?|pages?|ones?|stuff|things)$/, '')
            .trim())
          .filter(s => s.length > 2 && !/^(everything|all|them|it|the rest|others)$/.test(s));
        if (parts.length) exclude = parts.slice(0, 4);
      }
    }

    // An action verb operates only on tabs in the state it reverses: "unpin
    // all except X" unpins PINNED tabs (minus X), never the whole universe.
    // Applied only when an exclusion clause exists -- bare reverse-state
    // golds measure as whole-universe actions.
    const operableState =
      q.intent === 'unpin_tabs' ? 'pinned' :
      q.intent === 'unmute_tabs' ? 'muted' : null;
    if (operableState && exclude.length && !stateQ.length) {
      stateQ.push(operableState);
    }

    // Negated-state filter: a mute-everything command with a negated sound cue keeps
    // the quiet tabs -- the cue applies inverted when an ODD number of
    // negators sits before the state word (double negation = positive).
    const cueM = cmdStr.match(/\b(not|isn'?t|is\s+not|aren'?t|never)\b[^.,;]{0,30}\b(playing|audible|muted|pinned|active)\b/i);
    let stateNegated = false;
    if (cueM) {
      // Parity over the whole matched span: "not ... playing" inverts,
      // two negators are positive again.
      const negs = (cueM[0].match(/\b(?:not|isn't|is\s+not|aren't|never|no)\b/gi) || []).length +
        (cueM.input.slice(Math.max(0, cueM.index - 6), cueM.index).match(/\b(isn't|isn t)\b/i) || []).length;
      stateNegated = negs % 2 === 1;
    }

    // refNow anchors to the freshest candidate timestamp when present, so
    // calendar windows reproduce against frozen bench pools AND stay correct
    // live (a stale wall clock cannot shift "yesterday"). The anchor MUST be
    // the max candidate timestamp -- starting from Date.now() makes every
    // past-dated pool (frozen bench, resumed session) anchor to today and
    // empty every relative window. Timestamps arrive either as ISO strings
    // (production cards) or epoch millis (bench pools); Date.parse(number)
    // is NaN, which silently defeated the whole stage.
    const allTs = [];
    for (const c of candidates) {
      const a = tsOf(c.lastAccessed), o = tsOf(c.openedAt);
      if (Number.isFinite(a)) allTs.push(a);
      if (Number.isFinite(o)) allTs.push(o);
    }
    let refNow = allTs.length ? Math.max(...allTs) : Date.now();

    // Evidence-identity census: document frequency over the FULL candidate
    // pool, computed once per select() call and shared by every scoring pass
    // and the exclusion resolver below.
    const idf = buildIdf(candidates);

    const allMatches = (universe, reason, conf = 1.0) => ({
      decision: 'final', mode: reason, needDetails: [],
      matches: universe.map(c => ({ tabId: c.tabId, reason, confidence: conf }))
    });

    // ---- Deterministic qualifier stage -----------------------------------
    // Order: domain scope -> time window -> tab state -> select-all/exclude.
    let universe = candidates;
    const preQualifierUniverse = candidates;
    if (domains.length) universe = matchDomains(universe, domains, cmdStr);

    // Degenerate older-than: "older than today/yesterday" carries no real
    // granularity (measured: vague staleness commands parse to it and mean
    // week-plus). Widen to a week rather than slicing at a day boundary.
    if (timeQ && timeQ.op === 'older_than' && ['today', 'yesterday', 'last_hour'].includes(timeQ.value)) {
      timeQ.value = '1_weeks';
    }

    if (timeQ) {
      const win = timeWindow(timeQ.value, refNow);
      if (!win) return { decision: 'final', mode: 'time_filter_bad_value', matches: [], needDetails: [] };
      const basisOpened = timeQ.basis === 'opened';
      // older_than inverts the window: keep what predates the span's start
      // older-than = opened before seven days ago), not what falls
      // inside it.
      const lo = timeQ.op === 'older_than' ? 0 : win[0];
      const hi = timeQ.op === 'older_than' ? win[0] : win[1];
      universe = universe.filter(c => {
        const ts = tsOf(basisOpened ? c.openedAt : c.lastAccessed);
        return Number.isFinite(ts) && ts >= lo && ts <= hi; // missing ts = honest drop
      });
    }
    if (stateQ.length) {
      const urlCounts = new Map();
      for (const c of universe) {
        const u = c.url || '';
        urlCounts.set(u, (urlCounts.get(u) || 0) + 1);
      }
      // A pool that carries explicit duplicateOf links speaks for itself;
      // URL-count fallback is only for pools that do not (it flags BOTH
      // copies, and a second-copy command must not close the original).
      const hasDupLinks = universe.some(o => o.duplicateOf != null);
      universe = universe.filter(c => {
        const base = stateQ.every(st => {
          switch (st) {
            case 'pinned': return c.pinned === true;
            case 'unpinned': return c.pinned !== true;
            case 'audible': return c.audible === true;
            case 'muted': return c.muted === true;
            case 'duplicate': return hasDupLinks ? c.duplicateOf != null : (urlCounts.get(c.url || '') > 1);
            default: return false;
          }
        });
        return stateNegated ? !base : base; // negated cue keeps the complement
      });
    }

    // Time-window degradation: when the model's time qualifier empties the
    // universe but the command also names a TOPIC, the temporal word usually
    // described the CONTENT (the event happened that day), not access time.
    // Score the unfiltered pool rather than abstaining on an empty set.
    if (!universe.length && timeQ && (q.concepts && q.concepts.length)) {
      universe = preQualifierUniverse;
    }

    const modelConcepts = (q.concepts && q.concepts.length) ? q.concepts : [];
    // The deterministic fallback "concept" is unparsed residue, not a topic
    // a from-yesterday command strips to unparsed residue). It must never
    // veto the qualifier-only shortcut: a command whose MODEL concepts are
    // empty but which carries time/state/domain filters is fully defined by
    // those filters.
    const concepts = modelConcepts.length ? modelConcepts : (det.concept ? [det.concept] : []);

    // Descriptive referent: a command quoting what a tab SAYS /
    // A tab named by its literal title or label names ONE page by
    // what it SAYS or what it is CALLED, not by topic. A select-all parse of
    // that is catastrophic; instead match titles against the description.
    // Also fires WITHOUT a select-all parse: "reload the tab telling me to
    // verify my password" reduces to concept "password" -- every other tab
    // entailing that word is a decoy, while the quoted-speech shape pins the
    // referent exactly. Requires >= 2 residual content words so ordinary
    // topic commands ("close the news tabs") can never take this path.
    const descM = cmdStr.match(/\b(?:the|a|that)\s+(?:tab|page)\s+(?:telling|saying|asking|showing|warning|titled|named|called|labeled|claiming)\b\s*(.*)$/i);
    if (descM) {
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Escape BEFORE appending the plural quantifier, or the '?' becomes a
      // literal and every token test fails.
      const toks = descM[1].toLowerCase().split(/[^a-z0-9]+/)
        .filter(w => w.length > 1 && !['you', 'your', 'to', 'us', 'me', 'it', 'is', 'my'].includes(w))
        .map(w => esc(w.replace(/s$/, '')) + 's?');
      if (toks.length >= 2 || (wantsAll && toks.length)) {
        const hits = candidates.filter(c => {
          const t = String(c.title || '');
          return toks.every(tok =>
            new RegExp('(^|[^a-z0-9])' + tok + '([^a-z0-9]|$)', 'i').test(t));
        });
        return allMatches(hits, 'Descriptive referent');
      }
    }
    // A literal word-in-title query is owned by OPERATOR 3 (plan-ops.js),
    // which runs beside the veto stage before this point.

    // Select-all with an exclusion list is a COMPLEMENT, not everything. A
    // concept that survives alongside the exclusions scopes the complement
    // (a quantified-topic exception acts on its topic,
    // not on the universe); a keep-only clause inverts the complement entirely.
    if (wantsAll || exclude.length) {
      // State words in exclude[] are live tab properties, not topics: "ignore
      // the pinned tabs" carves out pinned state, never pages containing the
      // letter sequence p-i-n-n-e-d.
      const STATE_WORDS = new Set(['pinned', 'unpinned', 'muted', 'audible', 'duplicate']);
      const stateExcl = exclude.filter(p => STATE_WORDS.has(p));
      const topicExcl = exclude.filter(p => !STATE_WORDS.has(p));

      const stateKept = stateExcl.length
        ? universe.filter(c => !stateExcl.every(st => {
            switch (st) {
              case 'pinned': return c.pinned === true;
              case 'unpinned': return c.pinned !== true;
              case 'audible': return c.audible === true;
              case 'muted': return c.muted === true;
              case 'duplicate': return c.duplicateOf != null;
              default: return false;
            }
          }))
        : universe;

      if (wantsAll && !topicExcl.length) {
        return allMatches(stateKept, stateExcl.length ? `All except ${stateExcl.join('/')}` : 'Command targets all tabs');
      }

      if (topicExcl.length) {
        // A keep-only survivor clause is
        // negated, so the ACTED-ON set is the matched one,
        // not the complement.
        const keepOnly = /\b(keep (only|just)|only keep|save only)\b/i.test(cmdStr);
        // Concept-scoped exception: exclusions apply INSIDE the concept's own
        // matches of the concept itself, so
        // the scope is computed first and handed to the resolver as a fence.
        // Only MODEL-emitted concepts scope an exception -- the deterministic
        // fallback concept is a raw leftover string of unstopped residue
        // and would fence the complement down to nothing.
        const scopeConcepts = (q.concepts && q.concepts.length) ? q.concepts : [];
        // Self-scope guard: when the model emitted the SAME topic on both
        // sides (the same topic emitted as BOTH concept and exclusion ->
        // plus selectAll), the user's intent is the plain
        // complement; scoping would subtract the topic from itself and select
        // nothing.
        const scopeInvalid = scopeConcepts.some(c => {
          const ct = String(c).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
          return topicExcl.some(p => {
            const pt = String(p).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            return ct.some(t => pt.includes(t)) || pt.some(t => ct.includes(t));
          });
        });
        // Command-rescued scope: a quantified topic between the quantifier and
        // the noun is honored even when the parser dropped it into nothing.
        // Rescued topics scope the subtraction only -- they never feed
        // include-side scoring.
        let commandTopic = null;
        if (!scopeConcepts.length) {
          const tm = cmdStr.match(/\b(?:all|every)\s+([a-z0-9'-]+(?:\s+[a-z0-9'-]+)?)\s+(?:tabs?|pages?)\b/i);
          if (tm) {
            const topic = tm[1].toLowerCase();
            if (!['the', 'my', 'other', 'of', 'these', 'those'].includes(topic)) commandTopic = topic;
          }
        }
        const effectiveScope = scopeConcepts.length ? scopeConcepts : (commandTopic ? [commandTopic] : []);
        let allowedIds = null;
        let scopedMatches = null;
        if (effectiveScope.length && !scopeInvalid) {
          const scoredScope = await scoringPass(effectiveScope, q, stateKept, cmdLower, threshold, opts, facetOf,
            { expansionChannel: makeExpansionChannel(q, effectiveScope, facetOf, cmdLower), idf });
          scopedMatches = scoredScope.matches;
          allowedIds = new Set(scopedMatches.map(m => m.tabId));
        }

        const { excludedIds, evidenceFound } = await resolveExclusions(topicExcl, stateKept, cmdLower, { allowedIds, idf });

        if (keepOnly && evidenceFound) {
          return allMatches([...excludedIds].map(id => stateKept.find(c => c.tabId === id)).filter(Boolean),
            `Only: ${topicExcl.join(', ')}`);
        }

        if (excludedIds.size && scopedMatches) {
          // Scoped subtraction -- whether or not selectAll was also asserted:
          // a quantified-topic exception acts on TOPIC minus X.
          const confById = new Map(scopedMatches.map(m => [m.tabId, m.confidence]));
          const baseCards = scopedMatches.map(m => stateKept.find(c => c.tabId === m.tabId)).filter(Boolean);
          const kept = baseCards.filter(c => !excludedIds.has(c.tabId));
          return {
            decision: 'final',
            mode: `Scoped complement of: ${topicExcl.join(', ')}`,
            needDetails: [],
            matches: kept.map(c => ({
              tabId: c.tabId, reason: 'complement',
              confidence: confById.get(c.tabId) ?? 1.0
            }))
          };
        }

        if (wantsAll) {
          const kept = stateKept.filter(c => !excludedIds.has(c.tabId));
          return allMatches(kept, `All tabs except: ${topicExcl.join(', ')}`);
        }

        // Plain complement over the filtered universe.
        if (excludedIds.size) {
          return allMatches(stateKept.filter(c => !excludedIds.has(c.tabId)),
            `Complement of: ${topicExcl.join(', ')}`);
        }
        if (!scopeConcepts.length && !evidenceFound && !stateExcl.length) {
          // exclude-only command whose phrases resolved to nothing: honest
          // abstain beats handing back the universe.
          return { decision: 'final', mode: 'exclude_unresolved', matches: [], needDetails: [] };
        }
      }
    }

    // Qualifier-only commands (recency or tab-state is the entire target set) are
    // fully defined by their filters -- no topic scoring required.
    if (!modelConcepts.length && (timeQ || stateQ.length || (domains.length && universe.length))) {
      return allMatches(universe, 'Qualifier match');
    }
    if (!concepts.length) {
      return { decision: 'final', mode: 'no_concept', matches: [], needDetails: [] };
    }

    const zs = await load();

    // Expansion terms carry real matching weight on the INCLUDE side: a
    // word-boundary hit on structured fields (tags) elects a tab even
    // when cosine is lukewarm; a title hit corroborates at lower strength.
    // A term that equals the tab's CATEGORY value elects nothing -- categories
    // are broad ("sports", "finance") and an expansion hitting one dragged
    // every sibling-sport tab into every topic command (measured: the exact
    // failure that killed expansion weighting in the sweep above).
    
  const expansionChannel = makeExpansionChannel(q, concepts, facetOf, cmdLower);

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
    for (const c of universe) {
      // Expansion lexical channel participates in the cosine stage so the
      // fast bands see it (structured hit 0.70 elects; title 0.42 corroborates).
      let lex = expansionChannel(c);
      if (isLoginWall(c) && !explicitLoginNaming(cmdLower, c)) lex = Math.max(0, lex - 0.5);
      let best = lex > 0 ? Math.min(1, lex) : null;
      const cv = c.embedding && c.embedding.length ? c.embedding : null;
      if (cv) {
        for (const concept of concepts) {
          const qv = conceptVecs.get(concept);
          if (!qv) continue;
          let s = cosine(qv, cv);

          // Lexical & Category Fast-Track for Obvious Matches
          const conceptLower = concept.toLowerCase();
          let canonQuery = null;
          try {
            if (typeof self !== 'undefined' && self.EnrichMath?.matchTag) {
              canonQuery = self.EnrichMath.matchTag(conceptLower);
            } else if (typeof require !== 'undefined') {
              const EM = require('./enrich-math.js');
              if (EM?.matchTag) canonQuery = EM.matchTag(conceptLower);
            }
          } catch (e) {}

          const cardCat = c.enrichment?.category;
          const cardTags = (c.enrichment?.tags || []).map(t => (typeof t === 'string' ? t : t.tag));

          let boost = 0;
          // 1. Direct Category & Tag Alignment (e.g. concept "programming" -> "coding", card has category "coding")
          if (canonQuery && (cardCat === canonQuery || cardTags.includes(canonQuery))) {
            boost += 0.20;
          }

          // 2. High-confidence Lexical Substring match in title or tech signatures
          const titleLower = (c.title || '').toLowerCase();
          const keywords = (c.structured?.keywords || []).map(k => String(k).toLowerCase());

          if (titleLower.includes(conceptLower) || keywords.includes(conceptLower)) {
            boost += 0.15;
          } else if (canonQuery === 'coding' && /\b(python|javascript|typescript|react|rust|golang|c\+\+|java|rag|llm|pytorch|tensorflow|sql|docker|kubernetes|api|git|linux|kernel)\b/i.test(titleLower)) {
            boost += 0.15;
          } else if (canonQuery === 'cooking' && /\b(recipe|recipes|sourdough|baking|bake|cook|dinner|ingredients|bread)\b/i.test(titleLower)) {
            boost += 0.15;
          } else if (canonQuery === 'sports' && /\b(soccer|nba|tennis|score|match|tournament|rugby|hockey)\b/i.test(titleLower)) {
            boost += 0.15;
          }

          s = Math.min(1.0, s + boost);
          if (best === null || s > best) best = s;
        }
      }
      cosScores.set(c.tabId, best);
    }

    // Count the tabs that will need a forward pass BEFORE starting, so the UI
    // can name a real total instead of counting up to an unknown ceiling. This
    // is a cheap pass over an in-memory Map -- the expensive work is below.
    let nliPending = 0;
    for (const c of universe) {
      const cs = cosScores.get(c.tabId);
      if (cs === null || (cs < BAND_HIGH && cs >= BAND_LOW)) nliPending++;
    }
    if (typeof opts.onCosineDone === 'function') {
      try { opts.onCosineDone(nliPending, universe.length); } catch (e) { /* UI only */ }
    }

    // ---- Stage 2: NLI only where cosine is uncertain ---------------------
    //
    // Confident yes (>= BAND_HIGH) and confident no (< BAND_LOW) are decided for
    // free. Only the middle band -- and tabs cosine could not score at all --
    // cost a forward pass. Measured at 1.9 passes/command versus 15 for scanning
    // everything, at identical set-exact.

    const scored = await scoringPass(concepts, q, universe, cmdLower, threshold, opts, facetOf, {
      expansionChannel, cosScores, conceptVecs, idf,
      nliScore(c, text) {
        return (async () => {
          const key = sha(text + '||' + tabText(c));
          let s = scoreCache.get(key);
          if (s === undefined) {
            try {
              const out = await inferZeroShot(tabText(c), [text], {
                multi_label: true,
                hypothesis_template: 'This browser tab is about {}.'
              });
              s = Array.isArray(out.scores) ? out.scores[0] : 0;
              passes++;
            } catch (e) {
              console.warn('[NLI] scoring failed for tab', c.tabId, e.message);
              s = 0;
            }
            scoreCache.set(key, s);
            if (scoreCache.size > SCORE_CACHE_MAX) scoreCache.clear();
          } else {
            cached++;
          }
          return s;
        })();
      },
      notePass(c) { nliTabIds.add(c.tabId); },
      progress() {
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(nliTabIds.size, nliPending); } catch (e) { /* UI only */ }
        }
      }
    });

    let { matches } = scored;

    // Zero-corroboration abstain: entailment never got warm ANYWHERE, so the
    // topic names no real set here ("fantasy football" max-entailment .04,
    // "disney plus" .006 on this pool). Whatever rode in rode in on a
    // structured-tag expansion alone.
    // EXCEPTION: a direct structured-identity hit (concept token == tag or
    // category word on the card) IS corroboration even when entailment stayed
    // cold — "SQL injection payload" names tab 140 by its own tags
    // [injection, sql] while its title (the payload itself) entails nothing.
    if (matches.length && !scored.anyEvidenceBacked && scored.maxSemOverall < SOFT_EVIDENCE_FLOOR) {
      const structuredIdentity = matches.some(m => {
        const c = candidates.find(x => x.tabId === m.tabId);
        if (!c) return false;
        const structText = `${c.enrichment?.category || ''} ${(c.enrichment?.tags || []).map(t => (typeof t === 'string' ? t : t?.tag || '')).join(' ')}`.toLowerCase();
        return (q.concepts || []).some(con => {
          const words = String(con).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
          return words.some(w => new RegExp('(^|[^a-z0-9])' + w + '([^a-z0-9]|$)', 'i').test(structText));
        }) || Object.values(q.expansions || {}).some(terms =>
          terms.some(t => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2)
            .some(w => new RegExp('(^|[^a-z0-9])' + w + '([^a-z0-9]|$)', 'i').test(structText))));
      });
      if (!structuredIdentity) matches = [];
    }

    // OPERATOR 2 (late half) -- SUPERLATIVE EXTREME. Normal scoring elected
    // the topic; the superlative determiner now picks ONE extreme by
    // timestamp (asc = oldest family / MIN, desc = newest family / MAX;
    // basis 'opened' vs 'accessed' read from the command). Zero matches fall
    // through to the ordinary abstain below.
    {
      const _ops = planOps();
      const supPick = _ops ? _ops.trySuperlative(cmdStr, matches, candidates) : null;
      if (supPick) {
        console.log(`[NLI] superlative: ${supPick.word} (${supPick.basis}) -> tab ${supPick.matches[0].tabId}`);
        return {
          decision: 'final',
          mode: supPick.reason,
          concepts,
          combine: q.combine === 'intersection' ? 'intersection' : 'union',
          matches: supPick.matches,
          needDetails: []
        };
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);

    // Singular-referent competition: "the X story" names ONE page.
    // Absolute entailment cannot tell the target from near-neighbors (a finance
    // tab entails a markets headline almost as well), so relative margin does:
    // keep runner-ups only when they land within MARGIN of the best. When the
    // top two are effectively tied, the command's own verbatim phrase breaks
    // the tie: the page whose TITLE contains the command's words verbatim is
    // the named one ("market close" is literally in the NYT headline, not in
    // the oil-price brief beside it).
    if (
      q.concepts && q.concepts.length === 1 &&
      /\b(the|that|my)\s+[a-z0-9'-]+(\s+[a-z0-9'-]+){0,3}\s+(page|story|article|video|mix|stream|guide|recipe|repo|document|doc|tutorial|tab|news|post)\b/i.test(cmdStr) &&
      !/\b(all|every|both)\b/i.test(cmdStr) &&
      matches.length > 1
    ) {
      const bestC = matches[0].confidence;
      const withinMargin = matches.filter(m => m.confidence >= bestC - 0.15);
      const phrase = q.concepts[0];
      const conceptToksSingular = String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
      const scored = withinMargin.map(m => {
        const card = universe.find(c => c.tabId === m.tabId);
        const tt = String(card ? card.title : '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        let exact = 0, related = 0;
        for (const tok of conceptToksSingular) {
          if (tt.some(t => t === tok)) exact++;
          else if (tt.some(t => tokenRelated(t, tok))) related++;
        }
        return { m, n: exact * 10 + related };
      });
      const maxN = Math.max(...scored.map(s => s.n));
      const winners = scored.filter(s => s.n === maxN && maxN > 0);
      if (winners.length === 1 && maxN >= 1) {
        const keep = new Set(winners.map(s => s.m.tabId));
        matches = matches.filter(m => keep.has(m.tabId));
      } else {
        const idx = matches.findIndex(m => m.confidence < bestC - 0.15);
        if (idx > 0) matches.length = idx;
      }
    }

    // ---- LISTWISE ADJUDICATION CASCADE (Tier 1.3) -------------------------
    //
    // Pointwise NLI answers "does this tab, alone, entail the concept?" -- but
    // the gold label often encodes a COMPARATIVE judgment ("which ONE"). When
    // the surviving set is small and top-1 vs top-2 is nearly tied, absolute
    // entailment cannot separate them; escalate ONCE to an injected model that
    // sees ALL tied candidates in one compact table and returns chosen id(s).
    //
    // Gate (deliberately narrow -- only low-separation commands pay it):
    //   * requires BOTH opts.callModel AND opts.listwise.enabled === true.
    //     No ambient model: without the explicit flag escalation is
    //     unreachable and behavior stays byte-identical to today.
    //   * sits AFTER scoring/margins/filters on the scored semantic path
    //     only -- veto / select-all / complement / qualifier-only paths all
    //     returned earlier, so they can never escalate.
    //   * matches.length in [2..12], margin(top1,top2) < LISTWISE_MARGIN,
    //     >= 1 concept. Margin default is MEASURED, not the naive 0.15: the
    //     remaining precision craters sit at 0.24-0.29 (a decoy that
    //     out-scores gold, or trails it widely) -- at 0.15 the cascade can
    //     never see them. NLI_LW_MARGIN env overrides for sweeps.
    //   * SINGULAR-REFERENT SHAPE GUARD: the comparative judgment this
    //     cascade resolves is "which ONE". Broad CLASS commands ("my cricket
    //     tabs", "all news", "the video ones") name whole categories -- their
    //     tight margins are normal cluster behavior, not referent ambiguity.
    //     Measured across two prompt variants, adjudicating class commands
    //     under-selected true members. Two-sided generic shape test:
    //       POSITIVE: a determiner + singular page-type head noun
    //         ("the tab where...", "that guide", "my markets portal").
    //       NEGATIVE: quantity words / plural nouns anywhere ("all", "every",
    //         "tabs", "pages", "stuff", "ones") veto the escalation, so
    //         unknown class phrasings fail safe to today's pointwise result.
    //     Both lists are structural English morphology -- no benchmark
    //     strings, no tab ids, no domain topics.
    // A null/failure verdict keeps the pointwise result untouched; rebuilt
    // matches inherit their previous confidence with a '[listwise] ' reason
    // prefix so downstream telemetry can see who decided.
    const LISTWISE_SINGULAR_RE =
      /\b(?:the|that|this|my|a|an)\s+(?:[a-z0-9'’-]+\s+){0,6}(?:tabs?|pages?|articles?|stories?|videos?|posts?|docs?|documents?|guides?|recipes?|repos?|streams?|sites?|files?|notes?|emails?|messages?|sheets?|reports?|forms?|charts?|maps?|dashboards?|portals?|logins?|viewers?|editors?|players?|tools?|apps?|websites?|blogs?|threads?|reviews?|tutorials?|demos?|homepages?|pdfs?|tickets?|issues?|wikis?|calendars?|inboxes?|playlists?|albums?|tracks?|games?|scores?|tables?|graphs?|decks?|slides?|boards?|cards?|profiles?|accounts?)\b/i;
    const LISTWISE_CLASS_CUE_RE =
      /\b(?:all|every|each|both|everything)\b|\b(?:tabs|pages|videos|articles|stories|documents|guides|docs|files|sites|streams|emails|notes|sheets|spreadsheets|reports|messages|posts|images|photos|links|bookmarks|ones|stuff|stuf|things|buckets|groups|categories)\b/i;
    const LISTWISE_MARGIN = Number(process.env.NLI_LW_MARGIN) || 0.30;
    if (process.env.NLI_DEBUG_LW &&
        typeof opts.callModel === 'function' && opts.listwise && opts.listwise.enabled === true) {
      console.log('[LWDBG]', JSON.stringify({
        cmd: cmdStr, n: matches.length,
        top: matches.slice(0, 6).map(m => [m.tabId, Number(m.confidence.toFixed(3))]),
        margin: matches.length >= 2 ? Number((matches[0].confidence - matches[1].confidence).toFixed(3)) : null,
        sing: LISTWISE_SINGULAR_RE.test(cmdStr), cls: LISTWISE_CLASS_CUE_RE.test(cmdLower),
        concepts: q.concepts
      }));
    }
    if (
      typeof opts.callModel === 'function' &&
      opts.listwise && opts.listwise.enabled === true &&
      listwiseMod() && typeof listwiseMod().adjudicate === 'function' &&
      matches.length >= 2 && matches.length <= 12 &&
      (Number(matches[0].confidence || 0) - Number(matches[1].confidence || 0)) < LISTWISE_MARGIN &&
      Array.isArray(q.concepts) && q.concepts.length >= 1 &&
      LISTWISE_SINGULAR_RE.test(cmdStr) &&
      !LISTWISE_CLASS_CUE_RE.test(cmdLower)
    ) {
      listwiseStats.escalated++;
      try {
        const rows = matches.map(m => {
          const card = universe.find(x => x.tabId === m.tabId) ||
            candidates.find(x => x.tabId === m.tabId) || {};
          return { tabId: m.tabId, title: card.title || '', host: hostOf(card.url || card.domain || '') };
        });
        const adj = await listwiseMod().adjudicate({
          command: cmdStr,
          candidates: rows,
          callModel: opts.callModel,
          maxRows: opts.listwise.maxRows
        });
        if (adj && Array.isArray(adj.ids) && adj.ids.length) {
          const prevById = new Map(matches.map(m => [m.tabId, m]));
          const rebuilt = [];
          for (const id of adj.ids) {
            const m = prevById.get(id);
            if (m && !rebuilt.includes(m)) rebuilt.push(m);
          }
          if (rebuilt.length) {
            matches = rebuilt.map(m => ({ ...m, reason: '[listwise] ' + m.reason }));
            listwiseStats.adjudicated++;
          }
        }
      } catch { /* any cascade failure keeps the pointwise result */ }
    }

    // Dual-intent commands (two verbs joined by an alternation) are genuinely
    // ambiguous about the ACTION even when the target set is crisp. The same
    // honesty rule covers MULTI-TOPIC unions that resolve to a handful of
    // tabs: the parser split the command into several concepts and the pool
    // only satisfied some of them ("switch to the Linear bug ticket about 404
    // token timeouts" -> two near-duplicate issue tabs) -- exactly the shape
    // where silently executing one reading is wrong. Production's preview
    // policy keys off mean confidence; capping (never below selection range)
    // forces the preview without changing WHICH tabs matched.
    const multiTopicUnion = scored.combine === 'union' && q.concepts && q.concepts.length >= 2;
    if ((/\bor\b/i.test(cmdStr) || multiTopicUnion) && matches.length && matches.length < 3) {
      for (const m of matches) m.confidence = Math.max(0.55, Math.min(m.confidence, 0.70));
    }

    const elapsed = Date.now() - t0;

    // Zero-corroboration abstain: nothing cleared any admission path. Say so
    // explicitly -- downstream telemetry distinguishes "scored, nothing matched"
    // from "never scored".
    const mode = matches.length ? 'nli' : 'abstain_no_corroboration';

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
      decision: 'final', mode, concepts, combine: q.combine === 'intersection' ? 'intersection' : 'union', matches,
      needDetails: [],
      stats: {
        passes, cached, embedCalls, ms: elapsed, msPerPass: msPer,
        scanned: candidates.length, available: candidates.length,
        nliTabs, cosineTabs: decidedFree
      }
    };
  }

  // Expansion lexical channel, parameterized by the query's expansions. A
  // structured-tags hit elects at 0.70; a title/URL hit corroborates at 0.42.
  // A term that equals the tab's CATEGORY value elects nothing -- categories
  // are broad ("sports", "finance") and an expansion hitting one dragged every
  // sibling-sport tab into every topic command (measured: the exact failure that
  // killed expansion weighting in bench/expansion-sweep.js).
  function makeExpansionChannel(q, concepts, facetOf, cmdLower) {
    return function expansionChannel(c) {
      let best = 0;
      const titleLower = String(c.title || '').toLowerCase();
      const catLower = String(c.enrichment?.category || '').toLowerCase();
      const tagList = rawTagsOf(c).map(t => String(t).toLowerCase());
      const urlLower = String(c.url || '').toLowerCase();
      for (const concept of concepts) {
        // Facet elect: an ontology-mapped concept admits via ingest-time facet
        // at the same grade as a structured-tag hit. Sense-gated against the
        // command's negation/polysemy frames.
        if (facetOf) {
          const pred = facetPredicateFor(concept, cmdLower);
          const f = facetOf(c);
          if (f && pred && pred(f)) best = Math.max(best, 0.70);
        }
        for (const term of (q.expansions && q.expansions[concept]) || []) {
          const t = String(term).toLowerCase();
          const tagHit = tagList.some(tag => tag === t || wordHit(t, tag));
          if (tagHit && t !== catLower) best = Math.max(best, 0.70);
          else if (wordHit(t, titleLower) || wordHit(t, urlLower)) best = Math.max(best, 0.42);
        }
      }
      return best;
    };
  }

  // Canonical tag for a concept, via the shared enrichment vocabulary
  // (a sport -> its cluster). Lets a tab whose CATEGORY carries the canonical
  // cluster admit on moderate entailment -- an ashes fan-reaction thread at
  // 0.83 belongs in its sport cluster -- while a concept with no canonical
  // cluster never gains that path.
  // FACET ONTOLOGY (Tier 1.1): concept vocabulary -> ingest-time facet
  // predicate. Generic media/commerce/genre knowledge — the same families a
  // human uses to sort tabs. Scoped to evidence channels, never to global
  // enrichment re-tagging.
  let Facet = null;
  try { Facet = require('./facet.js'); } catch {}
  const FACET_ONTOLOGY = [
    // TOPIC-grouping commands ("entertainment tabs") bind through topicGenre
    // -- NOT through the structural media facet. Media-video is shared by
    // cricket highlights, phone reviews and gaming streams alike;
    // entertainment means podcast-family audio or an entertainment-catalog
    // service (netflix/primevideo -> Facet.build's topicGenre). Media-type
    // commands ("mute/close X video tabs") keep the broad video/live test.
    { keys: ['entertainment', 'fun', 'movie', 'movies', 'tv'], test: f => f.topicGenre === 'entertainment' || (f.media === 'audio' && f.podcast === true) },
    { keys: ['video', 'vidoe', 'videos', 'streaming', 'stream', 'streams', 'livestream', 'watch'], test: f => f.media === 'video' || f.media === 'live' },
    { keys: ['music', 'audio', 'song', 'songs', 'lofi', 'playlist', 'podcast', 'podcasts'], test: f => f.media === 'audio' },
    { keys: ['shopping', 'shop', 'store', 'stores', 'retail', 'commerce', 'deals', 'marketplace', 'ecommerce', 'auction', 'auctions'], test: f => f.commerce !== 'none' },
    { keys: ['news', 'journalism', 'newspaper'], test: f => f.genre === 'news' },
    { keys: ['weather', 'forecast', 'forecasts'], test: f => f.genre === 'weather' },
    { keys: ['docs', 'documentation', 'manual', 'manuals', 'pdf', 'document', 'documents'], test: f => f.media === 'doc' || f.genre === 'docs' },
  ];
  // ---- SENSE GATE ---------------------------------------------------------
  //
  // A facet is a STRUCTURAL fact about a tab; a command word is a SENSE
  // choice. When the command's own frame says the concept is not being used
  // in its facet sense, the facet elect must stay silent and leave admission
  // to the lexical/semantic channels. Two generic frames:
  //
  // (a) NEGATION/EXCEPTION: "don't close my docs" uses 'docs' inside a
  //     negated destructive frame -- the facet-elect for docs-grade media
  //     (an MDN reference page) must not fire on it. Detected when a negator
  //     sits within ~50 chars BEFORE the concept occurrence. Desire-shaped
  //     negations ("don't want any shopping tabs") are exempt: there the
  //     category reading HOLDS.
  // (b) POLYSEMY: a small table of everyday English words that name both a
  //     browser-object sense and a literal business/world sense ("deals" =
  //     shopping pages OR closing enterprise deals; "pin" = tab pinning OR
  //     pinterest; "mute" = tab audio OR hardware buttons). When the command
  //     shows the competing literal-sense collocation, the facet elect for
  //     concepts carrying that token is suppressed ("closing enterprise
  //     deals" must never admit a /products/deals storefront).
  //
  // Suppression touches ONLY facet-elect paths (facetPredicateFor call
  // sites). Lexical tag/title evidence and NLI entailment are untouched --
  // they carry their own identity gates.
  const NEG_FRAME_RE = /\b(?:don[' ]?t|dont|do\s+not|except|apart\s+from|other\s+than|instead|rather\s+than)\b/i;
  // "don't want any X tabs" declines nothing structural -- the category IS
  // the referent. Exempt from negation suppression.
  const DESIRE_NEG_RE = /\b(?:don[' ]?t|dont|do\s+not)\s+(?:want|wanna|wish|need)\b/i;
  // Polysemous token -> competing literal-sense collocations in the command.
  const POLYSEMY_SENSES = [
    { word: /^deals?$/, frames: [/\bclos\w*[^.]{0,25}\bdeals?\b/i, /\bsales\b[^.]{0,25}\bdeals?\b/i, /\bdeals?\b[^.]{0,25}\bsales\b/i] },
    { word: /^clos(?:e|es|ing|ed)$/, frames: [/\bsales\b/i, /\bdeals?\b/i] },
    { word: /^pins?|pinning$/, frames: [/\bpinterest\b/i, /\brepin\w*/i, /\bsocial\s+media\b/i] },
    { word: /^mutes?|muting$/, frames: [/\bhardware\b/i, /\bbuttons?\b/i, /\baudio\b/i] },
    { word: /^watch(?:es|ing)?$/, frames: [/\bwristwatch/i, /\btimepiece\b/i] },
  ];
  function facetSenseBlocked(text, cmdStr) {
    const cmdLower = String(cmdStr || '').toLowerCase();
    if (!cmdLower) return false;
    const toks = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    if (!toks.length) return false;
    // (a) negation/exception frame before a concept occurrence
    if (!DESIRE_NEG_RE.test(cmdLower)) {
      for (const tok of toks) {
        const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(^|[^a-z0-9])' + esc + '(?![a-z0-9])', 'g');
        let m;
        while ((m = re.exec(cmdLower)) !== null) {
          const before = cmdLower.slice(Math.max(0, m.index - 50), m.index);
          if (NEG_FRAME_RE.test(before)) return true;
        }
      }
    }
    // (b) polysemous token in its competing literal-sense frame
    for (const p of POLYSEMY_SENSES) {
      if (!toks.some(t => p.word.test(t))) continue;
      if (p.frames.some(re => re.test(cmdLower))) return true;
    }
    return false;
  }
  function facetPredicateFor(text, cmdStr) {
    const w = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!w.length) return null;
    for (const e of FACET_ONTOLOGY) {
      if (!e.keys.some(k => w.includes(k))) continue;
      if (cmdStr !== undefined && facetSenseBlocked(text, cmdStr)) return null;
      return e.test;
    }
    return null;
  }

  function canonOf(concept) {
    try {
      const EM = (typeof self !== 'undefined' && self.EnrichMath) ||
        (typeof require !== 'undefined' ? require('./enrich-math.js') : null);
      return EM && EM.matchTag ? EM.matchTag(String(concept).toLowerCase()) : null;
    } catch { return null; }
  }

  // Canonical tie between an expansion term that hits the card's tags and the
  // concept it expands: both must resolve to the SAME enrichment cluster.
  // "baking" and "cooking" share the cooking cluster -> a recipe tab may
  // elect; "crypto" resolves nowhere under "bitcoin" -> a crypto FORUM may
  // not masquerade as a bitcoin tab.
  function expansionCanonTie(q, concepts, c) {
    const tagList = rawTagsOf(c).map(t => String(t).toLowerCase());
    const catLower = String(c.enrichment?.category || '').toLowerCase();
    for (const concept of concepts) {
      const cc = canonOf(concept);
      if (!cc) continue;
      for (const term of (q.expansions && q.expansions[concept]) || []) {
        const t = String(term).toLowerCase();
        const tt = canonOf(t);
        if (!tt || tt !== cc) continue;
        if (t === catLower) continue; // category-value hits never elect
        if (tagList.some(tag => tag === t || wordHit(t, tag))) return true;
      }
    }
    return false;
  }

  // Shared per-command scoring pass: expansion lexical channel + cosine bands +
  // zero-shot NLI, resolved through the admission gates. Used by the plain
  // semantic path AND by concept-scoped exceptions, so both speak identical
  // admission rules.
  async function scoringPass(conceptsIn, q, universe, cmdLower, threshold, opts, facetOf = null, ctx = {}) {
    void opts;
    const concepts = conceptsIn;
    let combine = q.combine === 'intersection' ? 'intersection' : 'union';
    // A plain conjunction of two topics unions their sets; only "both X and Y" (or
    // an explicit model intersection without a plain conjunction) means
    // intersect. Measured: cached parses marked plain-"and" lists as
    // intersection and min() zeroed every member.
    if (combine === 'intersection' && concepts.length > 1 && !/\bboth\b/i.test(cmdLower) &&
        /\band\b|,/i.test(cmdLower)) {
      combine = 'union';
    }

    const nliScore = ctx.nliScore || (async (c, text) => {
      const key = sha(text + '||' + tabText(c));
      let s = scoreCache.get(key);
      if (s === undefined) {
        try {
          const out = await inferZeroShot(tabText(c), [text], {
            multi_label: true,
            hypothesis_template: 'This browser tab is about {}.'
          });
          s = Array.isArray(out.scores) ? out.scores[0] : 0;
        } catch (e) {
          console.warn('[NLI] scoring failed for tab', c.tabId, e.message);
          s = 0;
        }
        scoreCache.set(key, s);
        if (scoreCache.size > SCORE_CACHE_MAX) scoreCache.clear();
      }
      return s;
    });

    const canons = concepts.map(canonOf);

    // Per concept: effective entailment channel per tab. Cosine-after-boost
    // settles a question only when it clears the INCLUDE floor itself;
    // a merely band-high cosine no longer fabricates a threshold-pass score
    // from lexical boosts -- the NLI pass runs and differentiates (measured:
    // pasta-recipe vs cookies both rode a 0.70 lexical boost into a tie).
    const perConcept = [];
    for (let ci = 0; ci < concepts.length; ci++) {
      const scores = new Map();
      for (const c of universe) {
        const cs = ctx.cosScores ? ctx.cosScores.get(c.tabId) : null;
        const fast = (cs !== null && cs !== undefined) ? cs : null;

        if (fast !== null && fast >= INCLUDE_FLOOR) {
          // Cosine is confident. Do not pay a model to re-answer.
          scores.set(c.tabId, { sem: Math.max(threshold, fast), fast });
          continue;
        }

        let nliVal = 0;
        if (!(fast !== null && fast < BAND_LOW)) {
          if (ctx.notePass) ctx.notePass(c);
          if (ctx.progress) ctx.progress();
          nliVal = await nliScore(c, concepts[ci]);
        }
        const sem = Math.max(nliVal, fast || 0);
        scores.set(c.tabId, { sem, fast });
      }
      perConcept.push(scores);
    }

    const expansionChannel = ctx.expansionChannel ||
      (q.expansions && Object.keys(q.expansions).length ? makeExpansionChannel(q, concepts, facetOf, cmdLower) : (() => 0));

    // Topic-shape gates, measured on the frozen pool:
    //   ambiguousTopic: when a large share of the universe weakly entails the
    //     concept ("news": 48% of tabs score >= .5), entailment alone cannot
    //     carry admission -- evidence or near-certainty required.
    //   taxoConcept: the concept NAMES a category present in the universe
    //     ("shopping", "work"). Membership then requires the card to carry
    //     that identity (or near-certain entailment) -- a phone *review*
    //     entails shopping at 0.99 while its category says technology.
    let hiShare = 0;
    if (universe.length) {
      for (const c of universe) {
        const vals = perConcept.map(m => m.get(c.tabId));
        const sem = combine === 'intersection'
          ? Math.min(...vals.map(v => v ? v.sem : 0))
          : Math.max(...vals.map(v => v ? v.sem : 0));
        if (sem >= 0.5) hiShare++;
      }
      hiShare /= universe.length;
    }
    const ambiguousTopic = hiShare > 0.35;
    const catSet = new Set(universe.map(c => String(c.enrichment?.category || '').toLowerCase()));
    const taxoConcepts = new Set(concepts.filter(k => catSet.has(String(k).toLowerCase())));

    // PER-CONCEPT admission, then boolean combine. Pooling concept scores
    // before admitting let one loose channel carry a tab no individual topic
    // supports (two coin topics pulled in a generic coin forum at
    // .99 pooled crypto entailment while entailing NEITHER coin specifically).
    const perConceptAdmitted = [];
    const electScore = new Map(); // tabId -> minimum score for elected tabs
    let maxSemOverall = 0;
    let anyEvidenceBacked = false;
    for (let ci = 0; ci < concepts.length; ci++) {
      const concept = concepts[ci];
      const conceptLower = String(concept).toLowerCase();
      const admitted = new Set();
      for (const c of universe) {
        const v = perConcept[ci].get(c.tabId) || { sem: 0 };
        let sem = v.sem;
        if (sem > maxSemOverall) maxSemOverall = sem;
        const lex = expansionChannel(c);
        // Login/auth walls are utility chrome, not topical content: demote
        // hard unless the command's own words name the page.
        if ((sem > 0 || lex > 0) && isLoginWall(c) && !explicitLoginNaming(cmdLower, c)) {
          sem = Math.max(0, sem - 0.5);
        }

        const evidence = directEvidence([concept], c, facetOf, cmdLower);
        const catLower = String(c.enrichment?.category || '').toLowerCase();
        const canonCatHit = canons[ci] && catLower === canons[ci];
        // Strong identity: a card evidences a MULTI-TOKEN concept when at
        // least two of its words appear across title/tags/host ("gift card
        // scam" on a free-gift-cards scam page: in. "fantasy football" on a
        // plain Premier-League table: out -- one shared word is not
        // identity). Single-token concepts keep exact tag/category equality.
        // Token floor 2 (was 3): short technical tokens ("ai" in "ai
        // models") are real vocabulary, but they are admitted ONLY through
        // exact stem equality against the card's own tags or category --
        // no prefix morphology, no title fuzzy matching -- so "ai" can elect
        // an ai-tagged tab while never riding an unrelated title token.
        const conceptWords = conceptLower.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
        const tagStems = rawTagsOf(c).map(t => stem(String(t).toLowerCase()));
        const titleToksAll = String(c.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const labelArr = hostLabels(c);
        // URL-path segments count as identity for MULTI-token concepts: the
        // scam page's "free-gift-cards" path carries two of the three concept
        // words even though its hostile title hides them.
        let pathToks = [];
        try {
          pathToks = new URL(c.url || '').pathname.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        } catch {}
        let strongTag = false;
        let strongTagViaTag = false;
        // Facet admission: an ontology-mapped concept satisfied by the tab's
        // ingest-time facet is identity-grade evidence, same as a literal tag.
        // Sense-gated: negation/exception and polysemy frames in the command
        // suppress the elect for that concept (lexical paths unaffected).
        const facetPred = facetPredicateFor(conceptLower, cmdLower);
        const fObj = facetOf ? facetOf(c) : null;
        const facetHit = !!(facetPred && fObj && facetPred(fObj));
        if (conceptWords.length === 1) {
          // EXACT equality only: a "videos"-vs-"video" stem match would let
          // the tag "video" elect under the concept "videos", dragging a
          // sibling-forum thread into a typo'd media command. Both sides go
          // through the same plural-only stem -- comparing the raw concept
          // against stemmed tags made every -s concept ("news", "deals")
          // silently unmatchable against its own literal tag.
          strongTag = tagStems.includes(stem(conceptLower)) || catLower === conceptLower || facetHit;
          strongTagViaTag = tagStems.includes(stem(conceptLower));
        } else if (conceptWords.length) {
          const hits = conceptWords.filter(tok => {
            const sTok = stem(tok);
            // Short-token admission (floor-2 complement): exact stem
            // equality against tags/category ONLY -- precise enough that a
            // 2-char token can never fake a hit off shared morphology.
            if (tok.length < 3) {
              return tagStems.includes(sTok) || catLower === sTok;
            }
            // Generic-token evidence discount: pool-wide df above the
            // generic threshold, or an out-and-out genre head noun, counts
            // ZERO toward strongTag hits -- "documents" in "cryptocurrency
            // tax documents" is Google-Docs URL taxonomy, not evidence.
            if (!isDistinct(tok, ctx.idf) || GENRE_IDENTITY_TOKENS.has(sTok)) return false;
            return tagStems.includes(sTok) ||
              titleToksAll.some(t => tokenRelated(t, tok)) ||
              pathToks.some(p => p === stem(tok)) ||
              labelArr.some(l => l === stem(tok)) ||
              catLower === stem(tok);
          }).length + (facetHit ? 1 : 0);
          strongTag = hits >= Math.min(2, conceptWords.length);
          strongTagViaTag = tagStems.filter(t => conceptWords.some(cw => stem(cw) === t)).length >= 1 &&
            hits >= Math.min(2, conceptWords.length);
        }
        // Login/auth walls: utility chrome, never a topical member -- their
        // category can literally read "work". A wall survives only when its
        // own curated TAG carries the identity (a phishing page dressed as a
        // login IS the phishing tab you asked about).
        const loginWall = isLoginWall(c) && !explicitLoginNaming(cmdLower, c);
        if (loginWall && !strongTagViaTag) continue;
        // Compound-tag block: a tag DERIVED from the concept ("video-editing"
        // vs "video") marks a tool ABOUT the topic; a captions guide is not a
        // video tab no matter what its title plural says. Blocks the pure
        // entailment paths only -- an explicit tag/category equality still
        // admits.
        const compoundBlocked =
          conceptLower.split(/[^a-z0-9]+/).length === 1 &&
          rawTagsOf(c).some(t => {
            const parts = String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            return parts.length > 1 && parts.some(p => stem(p) === stem(conceptLower));
          });

        // EVIDENCE-IDENTITY BINDING: below ULTRA, pooled entailment admits
        // only when the candidate carries its OWN identity for the concept --
        // a distinctive term hit on title/URL-path (a), canon-tag/cluster
        // identity (b), or host-label naming. A decoy whose ONLY evidence is
        // mid-band entailment over shared generic vocabulary is demoted to a
        // honest non-member instead of entering the match set.
        const identA = identityPhraseHit(q, concept, c, ctx.idf);
        const expIdent = expansionIdentityHit(q, concept, c, ctx.idf);
        const canonTie = expansionCanonTie(q, concepts, c);
        const hostEv = hostLabelEvidence([concept], c, ctx.idf);
        const identity = identA || expIdent || strongTag || canonCatHit || canonTie || hostEv;

        // Expansion-tag elects need corroboration: a synonym the parser
        // invented ("crypto" for "bitcoin") otherwise elects sibling forums
        // (measured violation). Corroboration must ITSELF be identity --
        // warm entailment over pooled context no longer counts, because that
        // is precisely the channel decoys ride -- and canonCatHit is
        // deliberately NOT enough: "nfl" (an expansion of the opaque compound
        // "fantasy football") hitting a game-stream tag plus a shared sports
        // category elected exactly the tab the command's own words exclude.
        const lexCorroborated = lex >= 0.69 &&
          (strongTag || identA || canonTie || hostEv);

        const ok =
          lexCorroborated ||
          strongTag ||
          (identity &&
            (evidence &&
              (!compoundBlocked || tagStems.includes(stem(conceptLower)) || catLower === conceptLower) &&
              sem >= SOFT_EVIDENCE_FLOOR)) ||
          (canonCatHit && sem >= 0.80) ||
          (identity &&
            !compoundBlocked &&
            (!ambiguousTopic || evidence) &&
            !(taxoConcepts.has(conceptLower) && !evidence) &&
            sem >= INCLUDE_FLOOR) ||
          // NEAR-ULTRA evidence rescue: entailment this strong over the pooled
          // context is not riding shared vocabulary -- the tab IS about the
          // topic even when its own title/tags never spell it (a lofi radio
          // stream is a video tab at .99 with no "video" token anywhere).
          // Demotion stays ON wherever decoys measured >= .98: ambiguous
          // topics (news: 48% of a pool weakly entails it) and category-named
          // concepts (a phone review entailing "shopping" at .9894).
          (!compoundBlocked &&
            !ambiguousTopic &&
            !taxoConcepts.has(conceptLower) &&
            sem >= NEAR_ULTRA) ||
          (!compoundBlocked && sem >= ULTRA);
        if (process.env.NLI_DEBUG_IDENT && sem > 0.01) {
          console.log(`[DBG] ${c.tabId} "${concept}" sem=${sem.toFixed(2)} lex=${lex.toFixed(2)} iA=${identA} xI=${expIdent} sT=${strongTag} cc=${canonCatHit} tie=${canonTie} hE=${hostEv} ev=${evidence} id=${identity} amb=${ambiguousTopic} taxo=${taxoConcepts.has(conceptLower)} cb=${compoundBlocked} -> ${ok}`);
        }
        if (ok) {
          if (strongTag || evidence || canonCatHit || lexCorroborated || identA || canonTie || hostEv) anyEvidenceBacked = true;
          if (strongTag) electScore.set(c.tabId, Math.max(electScore.get(c.tabId) || 0, 0.70));
          else if (lexCorroborated) electScore.set(c.tabId, Math.max(electScore.get(c.tabId) || 0, lex));
          admitted.add(c.tabId);
        }
      }
      perConceptAdmitted.push(admitted);
    }

    const matches = [];
    for (const c of universe) {
      const inSets = perConceptAdmitted.map(s => s.has(c.tabId));
      const ok = combine === 'intersection' ? inSets.every(Boolean) : inSets.some(Boolean);
      if (!ok) continue;
      const vals = perConcept.map(m => m.get(c.tabId));
      const sem = combine === 'intersection'
        ? Math.min(...vals.map(v => v ? v.sem : 0))
        : Math.max(...vals.map(v => v ? v.sem : 0));
      const lex = expansionChannel(c);
      const score = Math.max(sem, lex, electScore.get(c.tabId) || 0);
      if (score >= UNCERTAIN_THRESHOLD) {
        matches.push({
          tabId: c.tabId,
          score,
          confidence: score >= threshold ? score : score * 0.5,
          reason: score >= threshold
            ? `Entails "${concepts.join(combine === 'intersection' ? ' AND ' : ' OR ')}" (${score.toFixed(2)})`
            : `Weak match (${score.toFixed(2)})`
        });
      }
    }
    return { matches, combine, maxSemOverall, anyEvidenceBacked };
  }

  // ---- Exclusion resolution ----------------------------------------------
  //
  // Three evidence channels, strongest first:
  //   1. lexical: wordHit on the TITLE, exact token in category/tags, or a
  //      host-label hit ("energynews" evidences "news"; a URL PATH segment
  //      deliberately does NOT -- news-in-a-path-segment is site taxonomy, not topic,
  //      which is exactly what kept a Cricbuzz article out of "except news").
  //   2. semantic: the SAME NLI machinery at EXCL_SEM_FLOOR, for paraphrase --
  //      gated OFF whenever it would be guessing (see the gate below).
  //   3. singular-referent: "except the X video" names ONE survivor;
  //      only the single best-evidenced candidate is excluded.
  //
  // opts.allowedIds fences concept-scoped exceptions: candidates outside the
  // concept's own matches can never be excluded on semantic evidence alone
  // (an exception must resolve INSIDE the scoped set, not eject a
  // 0.98-entailing Prime Video page from the whole universe).
  async function resolveExclusions(phrases, universe, cmdLower, opts = {}) {
    const excludedIds = new Set();
    let evidenceFound = false;

    async function semScore(phrase, c) {
      let s = scoreCache.get(sha(phrase + '||' + tabText(c)));
      if (s === undefined) {
        try {
          const out = await inferZeroShot(tabText(c), [phrase], {
            multi_label: true,
            hypothesis_template: 'This browser tab is about {}.'
          });
          s = Array.isArray(out.scores) ? out.scores[0] : 0;
        } catch { s = 0; }
        scoreCache.set(sha(phrase + '||' + tabText(c)), s);
        if (scoreCache.size > SCORE_CACHE_MAX) scoreCache.clear();
      }
      return s;
    }

    function lexHit(phrase, c) {
      if (isLoginWall(c) && !explicitLoginNaming(cmdLower, c)) return 0;
      if (wordHit(phrase, c.title)) return 3;
      const cat = String(c.enrichment?.category || '').toLowerCase();
      const tags = rawTagsOf(c).map(t => String(t).toLowerCase());
      const phraseToks = String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (phraseToks.length === 1) {
        const p = phraseToks[0];
        if (cat === p || tags.includes(p)) return 2;
      } else if (cat === phrase || tags.some(t => wordHit(phrase, t))) {
        return 2;
      }
      // Host labels only: subdomain + registrable labels joined. "docs" lives
      // in docs.google.com's labels; mail.google.com's labels never spell
      // docs, so an inbox survives a docs-suite exclusion.
      // Substring-inside-compound-label is restricted to a measured whitelist:
      // "energynews" evidences "news", but "foodnetwork" must NOT evidence
      // "work" (the suffix 'work' in 'network' wrongly excluded a recipe tab).
      const p0 = phraseToks[0] || '';
      if (p0.length >= 4) {
        const labels = hostLabels(c);
        if (phraseToks.length === 1) {
          const HOST_SUFFIX_TOPICS = new Set(['news']);
          if (labels.some(l => l === p0 ||
              (HOST_SUFFIX_TOPICS.has(p0) && l.length > p0.length && l.endsWith(p0)))) return 1;
        } else if (wordHit(phrase, labels.join(' '))) {
          return 1;
        }
      }
      return 0;
    }

    for (const phrase of phrases) {
      const lexTabs = universe.map(c => ({ c, w: lexHit(phrase, c) })).filter(x => x.w > 0);
      if (lexTabs.length) evidenceFound = true;
      // Semantic depth gate. Entailment-as-exclusion is only safe when the
      // topic is CONCRETE (few tabs entail it: measured share <= 25%) and the
      // lexical channel did not already cover every member of the category it
      // names ("work" excluding a monitoring dashboard at 0.99 was the
      // measured false positive; so was "shopping" ejecting a phone review).
      const catNamed = universe.some(c => String(c.enrichment?.category || '').toLowerCase() === phrase);
      const catCount = catNamed ? universe.filter(c => String(c.enrichment?.category || '').toLowerCase() === phrase).length : 0;
      const catComplete = catNamed && lexTabs.length >= catCount;
      let semElects = [];
      if (!catComplete) {
        let hi = 0;
        for (const c of universe) if (await semScore(phrase, c) >= 0.5) hi++;
        const share = universe.length ? hi / universe.length : 0;
        if (share <= EXCL_SEM_MAX_SHARE) {
          for (const c of universe) {
            if (lexTabs.some(x => x.c.tabId === c.tabId)) continue;
            if (isLoginWall(c) && !explicitLoginNaming(cmdLower, c)) continue;
            // Compound-tag block: a tag DERIVED from the phrase ("video-editing"
            // vs "video") marks a tool ABOUT the topic, not an instance of it.
            const phraseToks = String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            const blocked = phraseToks.length === 1 &&
              rawTagsOf(c).some(t => { const lt = String(t).toLowerCase(); return lt !== phraseToks[0] && lt.split(/[^a-z0-9]+/).includes(phraseToks[0]); });
            if (blocked) continue;
            const s = await semScore(phrase, c);
            if (s >= EXCL_SEM_FLOOR) { semElects.push({ c, w: 0.5 + s / 100 }); evidenceFound = true; }
          }
        }
      }

      // Singular referent: "except the <phrase> one|video|story..." carves out
      // exactly one tab -- the best-evidenced one -- never a whole class.
      const phraseRe = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).join('\\s+');
      const singularCtx = new RegExp(`(?:except|apart from|excluding|other than|besides)\\s+(?:the|that|my)\\s+[a-z0-9' -]*${phraseRe}[a-z0-9' -]*\\s+(one|video|story|article|page|tab|doc|document)\\b`, 'i').test(cmdLower);

      // COMPLEMENT FENCE REPAIR: the complement must equal
      //   universe \ (lexically-matched ∪ (NLI-depth-matched ∩ family-scope))
      // so an NLI-depth elect can only ever eject a member of the exclusion
      // concept's OWN enrichment cluster, never a cross-family tab that
      // merely entailed the phrase. The fence is computed from canonOf(phrase)
      // and applied to `ranked` BEFORE the union into excludedIds below --
      // applying it only after the union would let a depth elect survive on a
      // technicality. An empty family scope fences nothing (there is no
      // measured cluster to trust), and lexical matches always pass: they are
      // the anchor that defines the family in the first place.
      const canonPhrase = canonOf(phrase);
      let familyScope = null;
      if (canonPhrase) {
        familyScope = new Set();
        for (const c of universe) {
          const catC = String(c.enrichment?.category || '').toLowerCase();
          if (catC === canonPhrase ||
              rawTagsOf(c).some(t => canonOf(String(t).toLowerCase()) === canonPhrase)) {
            familyScope.add(c.tabId);
          }
        }
        if (!familyScope.size) familyScope = null;
      }

      let ranked = [...lexTabs, ...semElects].sort((a, b) => b.w - a.w);
      if (opts.allowedIds) ranked = ranked.filter(x => opts.allowedIds.has(x.c.tabId) || x.w >= 2);
      if (familyScope) {
        // DEBUG ASSERTION: past this line every ranked entry is either
        // lexically matched (w > 0) or inside the phrase's family scope.
        ranked = ranked.filter(x => x.w > 0 || familyScope.has(x.c.tabId));
      }
      if (singularCtx && ranked.length) {
        excludedIds.add(ranked[0].c.tabId);
        continue;
      }
      for (const x of ranked) excludedIds.add(x.c.tabId);
    }
    return { excludedIds, evidenceFound };
  }

  const NliSelect = {
    select, load, tabText, setEmbedder, MODEL_ID,
    // inferZeroShot is the offscreen-WebGPU-with-local-fallback dispatch. Exposed
    // so multi-group-assign.js can score bucket labels through the same path
    // instead of re-implementing the offscreen round-trip.
    inferZeroShot,
    DEFAULT_THRESHOLD, UNCERTAIN_THRESHOLD, BAND_LOW, BAND_HIGH,
    INCLUDE_FLOOR, SOFT_EVIDENCE_FLOOR, ULTRA, NEAR_ULTRA, EXCL_SEM_FLOOR, EXCL_SEM_MAX_SHARE,
    GENERIC_DF_SHARE,
    // Exposed so the extension can report which WASM build actually loaded
    // rather than assuming the configuration took effect.
    ortStatus: () => ortStatus,
    // Test seam: lets a bench inject a fake classifier instead of downloading
    // 83MB, and lets tests assert how many forward passes were actually spent.
    __setClassifierForTest(fn) { classifier = fn; loading = null; },
    // Test seam: the sense-gated facet ontology lookup, so tests can assert
    // suppression directly without running a scoring pass.
    __facetPredicateForTest(text, cmd) { return facetPredicateFor(text, cmd); },
    // Tier 1.3 telemetry: how many commands hit the listwise cascade and how
    // many verdicts actually rebuilt the match set.
    listwiseStats() { return { ...listwiseStats }; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NliSelect;
  if (typeof self !== 'undefined') self.NliSelect = NliSelect;
})();
