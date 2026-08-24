(() => {
  let Embed, TabDB;
  try {
    ({ Embed } = require('./embed'));
    ({ TabDB } = require('./db'));
  } catch {
    Embed = self.Embed;
    TabDB = self.TabDB;
  }

  // parseTimeRange resolves a time expression to a single BOUNDARY timestamp (a
  // "since" epoch-ms). Direction is the caller's concern: RecallTabs.search and
  // the agent executor's "within" filter keep tabs with ts >= boundary; the
  // executor's "older_than" filter keeps ts < boundary. Ranges are deliberately
  // coarse, rolling windows (now - N) -- see the Limitations note in the plan;
  // weekday / intra-day precision is not attempted here.
  const MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = 7 * 86400000;

  const TIME_RANGES = {
    'today':      (now) => now - DAY,
    'yesterday':  (now) => now - 2 * DAY,
    'this_week':  (now) => now - WEEK,
    'last_week':  (now) => now - WEEK,
    'this_month': (now) => now - 30 * DAY,
    'last_month': (now) => now - 30 * DAY,
    'last_hour':  (now) => now - HOUR,
    'anytime':    () => 0,
  };

  const TIME_ALIASES = {
    'today': 'today', 'earlier today': 'today', 'this morning': 'today',
    'this afternoon': 'today', 'this evening': 'today', 'tonight': 'today',
    'yesterday': 'yesterday', 'last night': 'yesterday',
    'this week': 'this_week', 'this_week': 'this_week',
    'last week': 'last_week', 'last_week': 'last_week',
    'this month': 'this_month', 'this_month': 'this_month',
    'last month': 'last_month', 'last_month': 'last_month',
    'last hour': 'last_hour', 'last_hour': 'last_hour',
    'past hour': 'last_hour', 'the last hour': 'last_hour', 'the past hour': 'last_hour',
    'anytime': 'anytime', '': 'anytime', 'ever': 'anytime',
    'all time': 'anytime', 'any time': 'anytime',
  };

  const UNIT_MS = {
    m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
    h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
    d: DAY, day: DAY, days: DAY,
    w: WEEK, week: WEEK, weeks: WEEK,
  };

  // "3 days", "3_days", "3d", "72 hours", "30 min", "2 weeks ago" -> now - N*unit.
  function parseNumericRange(s, now) {
    const m = s.match(/(\d+)\s*[_ ]?\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|m|h|d|w)\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = UNIT_MS[m[2]];
    if (!Number.isFinite(n) || !unit) return null;
    return now - n * unit;
  }

  // Two-sided rolling window. Accepts "1 to 3 hours", the canonical planner form
  // "1_to_3_hours", "1-3 hours", "between 1 and 3 hours ago". Returns
  // { since, until } with since <= until: the LARGER number is the older (earlier)
  // bound and becomes `since`; the SMALLER number is the more recent bound `until`.
  // MUST be tried before parseNumericRange -- that matcher is non-anchored and would
  // otherwise match the trailing "3 hours" and silently drop the lower bound.
  function parseNumericWindow(s, now) {
    const m = s.match(/(\d+)\s*[_ ]?(?:to|and|[-–—])[_ ]?\s*(\d+)\s*[_ ]?\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|m|h|d|w)\b/);
    if (!m) return null;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    const unit = UNIT_MS[m[3]];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !unit) return null;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return { since: now - hi * unit, until: now - lo * unit };
  }

  // now is injectable so the executor and its fixtures are not wall-clock bound.
  function parseTimeRange(raw, now = Date.now()) {
    const s = String(raw || '').toLowerCase().trim();
    const win = parseNumericWindow(s, now);
    if (win) return win.since; // widest single-sided reading of a two-sided phrase
    const numeric = parseNumericRange(s, now);
    if (numeric !== null) return numeric;
    const key = TIME_ALIASES[s] || TIME_ALIASES[s.replace(/_/g, ' ')] || 'anytime';
    const fn = TIME_RANGES[key] || TIME_RANGES['anytime'];
    return fn(now);
  }

  // Two-sided companion to parseTimeRange: always returns { since, until }.
  // Single-sided expressions (and anything parseTimeRange understands) yield
  // { since, until: now }; only the "between"/"N to M" forms produce a real upper
  // bound. This is what the executor's op:'between' filter resolves against.
  function parseTimeWindow(raw, now = Date.now()) {
    const s = String(raw || '').toLowerCase().trim();
    const win = parseNumericWindow(s, now);
    if (win) return win;
    return { since: parseTimeRange(s, now), until: now };
  }

  // Distinguishes "resolved to anytime because the user MEANT anytime" from
  // "fell through to anytime because we couldn't parse it". The planner's
  // validate() rejects any time filter whose value is unknown here, so an
  // unparseable phrase ("last friday") triggers the fallback chain rather than
  // silently becoming match-all -- the plan's "never guess a time" rule.
  function isKnownTimeExpr(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (s === '') return true; // empty == anytime
    if (parseNumericWindow(s, 0) !== null) return true; // "1_to_3_hours" etc.
    if (parseNumericRange(s, 0) !== null) return true;
    return !!(TIME_ALIASES[s] || TIME_ALIASES[s.replace(/_/g, ' ')]);
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
    module.exports = { RecallTabs, parseTimeRange, parseTimeWindow, isKnownTimeExpr };
  }
  if (typeof self !== 'undefined') {
    self.RecallTabs = RecallTabs;
    self.parseTimeRange = parseTimeRange;
    self.parseTimeWindow = parseTimeWindow;
    self.isKnownTimeExpr = isKnownTimeExpr;
  }
})();
