(() => {
  let Embed, TabDB;
  try {
    ({ Embed } = require('./embed'));
    ({ TabDB } = require('./db'));
  } catch {
    Embed = self.Embed;
    TabDB = self.TabDB;
  }

  function classifyDomain(url) {
    const CATEGORY_ONTOLOGY = {
      categories: {
        coding: { domains: ['leetcode.com', 'codeforces.com', 'hackerrank.com', 'codewars.com', 'atcoder.jp'] },
        dev: { domains: ['github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'dev.to', 'codepen.io'] },
        docs: { domains: ['docs.', 'readthedocs.io', 'devdocs.io'] },
        video: { domains: ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv'] },
        social: { domains: ['twitter.com', 'x.com', 'reddit.com', 'facebook.com', 'linkedin.com', 'instagram.com'] },
        shopping: { domains: ['amazon.com', 'ebay.com', 'etsy.com', 'walmart.com'] },
        news: { domains: ['bbc.com', 'cnn.com', 'reuters.com', 'nytimes.com', 'theguardian.com'] },
        work: { domains: ['gmail.com', 'notion.', 'slack.com', 'teams.microsoft'] },
        learning: { domains: ['coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org'] }
      }
    };

    const host = (() => {
      try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
    })();
    if (!host) return 'other';

    for (const [cat, data] of Object.entries(CATEGORY_ONTOLOGY.categories)) {
      if (data.domains.some(d => host.includes(d) || d.includes(host))) return cat;
    }
    return 'other';
  }

  function hasCodeBlocks(text) {
    return /```|`[^`]{10,}`|function\s+\w+\s*\(|class\s+\w+|import\s+(.*)\s+from/.test(text || '');
  }

  const Indexer = {
    // precomputedEmbedding lets the offline sweep hand back the vector it already
    // computed for the tab card (batched on the GPU) instead of forcing a second,
    // per-tab WASM forward pass here. When omitted, behaviour is unchanged: embed
    // the snippet inline. The pages store this writes to is only read by
    // RecallTabs.search, so reusing the card's pseudo-doc vector is harmless.
    async indexTab(tab, extractedText, precomputedEmbedding = null) {
      const snippet = extractedText || tab.title || '';
      const embedding = precomputedEmbedding || await Embed.embed(snippet.substring(0, 1000));
      const domain = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();

      await TabDB.store({
        id: tab.url,
        url: tab.url,
        title: tab.title,
        domain,
        category: classifyDomain(tab.url),
        snippet: snippet.substring(0, 500),
        hasCodeBlocks: hasCodeBlocks(snippet),
        lastVisited: Date.now(),
        embedding: Array.from(embedding)
      });
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Indexer };
  }
  if (typeof self !== 'undefined') {
    self.Indexer = Indexer;
  }
})();
