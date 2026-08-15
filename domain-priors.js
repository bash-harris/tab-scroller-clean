// domain-priors.js
// Static domain + URL-path -> tag priors. Pure functions, no chrome APIs, no Embed.
// applyPriors(url) -> { tags: string[], conf: number } | null
(() => {
  const DOMAIN_PRIORS = {
    'github.com':        { tags: ['coding', 'dev'],            conf: 0.95 },
    'gitlab.com':        { tags: ['coding', 'dev'],            conf: 0.95 },
    'bitbucket.org':     { tags: ['coding', 'dev'],            conf: 0.95 },
    'stackoverflow.com': { tags: ['coding'],                   conf: 0.95 },
    'stackexchange.com': { tags: ['coding', 'reference'],      conf: 0.9 },
    'leetcode.com':      { tags: ['coding'],                   conf: 0.98 },
    'codeforces.com':    { tags: ['coding'],                   conf: 0.98 },
    'hackerrank.com':    { tags: ['coding'],                   conf: 0.98 },
    'dev.to':            { tags: ['coding', 'dev'],            conf: 0.9 },
    'medium.com':        { tags: ['news', 'reference'],        conf: 0.6 },
    'espncricinfo.com':  { tags: ['sports', 'cricket'],        conf: 0.98 },
    'cricbuzz.com':      { tags: ['sports', 'cricket'],        conf: 0.98 },
    'espn.com':          { tags: ['sports'],                   conf: 0.98 },
    'bbc.com':           { tags: ['news'],                     conf: 0.95 },
    'bbc.co.uk':         { tags: ['news'],                     conf: 0.95 },
    'cnn.com':           { tags: ['news'],                     conf: 0.95 },
    'reuters.com':       { tags: ['news', 'finance'],          conf: 0.95 },
    'nytimes.com':       { tags: ['news'],                     conf: 0.95 },
    'theguardian.com':   { tags: ['news'],                     conf: 0.95 },
    'letterboxd.com':    { tags: ['entertainment', 'film'],    conf: 0.97 },
    'imdb.com':          { tags: ['entertainment', 'film'],    conf: 0.97 },
    'rottentomatoes.com':{ tags: ['entertainment', 'film'],    conf: 0.97 },
    'spotify.com':       { tags: ['entertainment', 'music'],   conf: 0.97 },
    'allrecipes.com':    { tags: ['cooking', 'food'],          conf: 0.98 },
    'foodnetwork.com':   { tags: ['cooking', 'food'],          conf: 0.98 },
    'youtube.com':       { tags: ['video'],                    conf: 0.3 },
    'youtu.be':          { tags: ['video'],                    conf: 0.3 },
    'twitch.tv':         { tags: ['video', 'gaming'],          conf: 0.9 },
    'twitter.com':       { tags: ['social'],                   conf: 0.9 },
    'x.com':             { tags: ['social'],                   conf: 0.9 },
    'facebook.com':      { tags: ['social'],                   conf: 0.9 },
    'instagram.com':     { tags: ['social'],                   conf: 0.9 },
    'linkedin.com':      { tags: ['social', 'work'],           conf: 0.9 },
    'coursera.org':      { tags: ['learning'],                 conf: 0.95 },
    'udemy.com':         { tags: ['learning'],                 conf: 0.95 },
    'edx.org':           { tags: ['learning'],                 conf: 0.95 },
    'khanacademy.org':   { tags: ['learning'],                 conf: 0.95 },
    'arxiv.org':         { tags: ['science', 'reference'],     conf: 0.95 },
    'pubmed.ncbi.nlm.nih.gov': { tags: ['science', 'health'],  conf: 0.95 },
    'wikipedia.org':     { tags: [],                           conf: 0 } // handled by path/catlinks; no domain prior
  };

  const SUBREDDIT_MAP = {
    cricket: ['sports', 'cricket'], football: ['sports'], soccer: ['sports'],
    nba: ['sports', 'basketball'], basketball: ['sports'], tennis: ['sports'],
    formula1: ['sports'], nfl: ['sports'], cricketworldcup: ['sports', 'cricket'],
    movies: ['entertainment', 'film'], film: ['entertainment', 'film'],
    television: ['entertainment'], music: ['entertainment', 'music'],
    gaming: ['gaming'], pcgaming: ['gaming'],
    recipes: ['cooking', 'food'], cooking: ['cooking', 'food'], food: ['cooking', 'food'],
    programming: ['coding'], learnprogramming: ['coding'], javascript: ['coding'],
    python: ['coding'], webdev: ['coding', 'dev'],
    news: ['news'], worldnews: ['news'], politics: ['news'],
    finance: ['finance'], stocks: ['finance'], investing: ['finance'],
    science: ['science'], space: ['science'], physics: ['science'],
    books: ['reference'], askreddit: [], technology: ['tech']
  };

  const PATH_PRIORS = [
    [/^\/r\/([a-z0-9_]+)/i, (m) => SUBREDDIT_MAP[m[1].toLowerCase()] || null],
    [/^\/sports?(\/|$)/i, ['sports']],
    [/^\/sport(s)?\//i, ['sports']],
    [/^\/(film|movies?|tv|television|series)\//i, ['entertainment']],
    [/^\/watch\//i, ['video']],
    [/^\/recipes?(\/|$)/i, ['cooking']],
    [/^\/food(\/|$)/i, ['cooking']],
    [/^\/wiki\/category:/i, ['reference']],
    [/^\/r\/[^/]+/i, null] // generic reddit — no tag (subreddit map decides)
  ];

  function applyPriors(url) {
    if (!url) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const portStripped = host.split(':')[0];

    if (DOMAIN_PRIORS[portStripped] && DOMAIN_PRIORS[portStripped].conf > 0.7) {
      return { ...DOMAIN_PRIORS[portStripped], tags: [...DOMAIN_PRIORS[portStripped].tags] };
    }

    const path = u.pathname;
    for (const [pattern, mapper] of PATH_PRIORS) {
      const m = path.match(pattern);
      if (!m) continue;
      const tags = typeof mapper === 'function' ? mapper(m) : mapper;
      if (tags && tags.length) return { tags: [...tags], conf: 0.92 };
    }

    return null;
  }

  const api = { applyPriors, DOMAIN_PRIORS, SUBREDDIT_MAP, PATH_PRIORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.DomainPriors = api;
})();
