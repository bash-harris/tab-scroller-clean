(() => {
  let Embed, TabDB;
  try {
    ({ Embed } = require('./embed'));
    ({ TabDB } = require('./db'));
  } catch {
    Embed = self.Embed;
    TabDB = self.TabDB;
  }

  const TIME_RANGES = {
    'today': () => Date.now() - 86400000,
    'yesterday': () => Date.now() - 2 * 86400000,
    'last_week': () => Date.now() - 7 * 86400000,
    'anytime': () => 0,
    'last_hour': () => Date.now() - 3600000,
  };

  const TIME_ALIASES = {
    'today': 'today', 'earlier today': 'today', 'this morning': 'today',
    'yesterday': 'yesterday', 'last night': 'yesterday',
    'last_week': 'last_week', 'this week': 'today', 'this month': 'last_week',
    'anytime': 'anytime', '': 'anytime', 'ever': 'anytime', 'all time': 'anytime',
  };

  function parseTimeRange(raw) {
    const key = TIME_ALIASES[raw?.toLowerCase().trim()] || 'anytime';
    return TIME_RANGES[key]();
  }

  const RecallTabs = {
    async search({ query, categories, timeRange, topK = 10 }) {
      const since = parseTimeRange(timeRange);
      const queryEmbedding = await Embed.embed(query || '');

      const dot = queryEmbedding.reduce((s, v) => s + v * v, 0);
      if (dot === 0) return [];

      const results = await TabDB.search({
        categories,
        since,
        queryEmbedding,
        topK
      });

      return results.filter(r => r.similarity > 0.01);
    },

    resolve(results, selectedIndices) {
      if (selectedIndices && selectedIndices.length > 0) {
        const toOpen = selectedIndices.map(i => results[i]).filter(Boolean);
        if (toOpen.length === 0) return { action: 'error', message: 'No valid selections found in the previous results.' };
        return { action: 'open', urls: toOpen.map(r => r.url), count: toOpen.length };
      }
      if (!results || results.length === 0) return { action: 'none', message: 'No matching tabs found.' };
      if (results.length <= 3) return { action: 'open', urls: results.map(r => r.url), count: results.length };
      if (results.length <= 10) return { action: 'list', results, count: results.length };
      return { action: 'narrow', results: results.slice(0, 3), count: results.length };
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RecallTabs };
  }
  if (typeof self !== 'undefined') {
    self.RecallTabs = RecallTabs;
  }
})();
