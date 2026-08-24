// probe: why does "close the tab containing the SQL injection payload" score 0?
global.self = global;
require('./concept-core.js');
const fs = require('fs');
const LlmQuery = require('./llm-query.js');
const NliSelect = require('./nli-select.js');
const { env } = require('@xenova/transformers');
env.cacheDir = './bench/.model-cache';

const recs = fs.readFileSync('bench/golden-set-v2.jsonl', 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
const pool = recs.find(r => r._tabPool)._tabPool;
const candidates = pool.filter(t => ![147, 148].includes(t.id)).map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
  lastAccessed: Date.parse(t.lastAccessed), openedAt: Date.parse(t.openedAt),
  pinned: t.pinned === true, muted: t.muted === true, audible: t.audible === true,
  duplicateOf: t.duplicateOf ?? null,
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

(async () => {
  await NliSelect.load();
  const cmd = 'close the tab containing the SQL injection payload';
  const key = LlmQuery.normalizeCommand(cmd);
  const cache = JSON.parse(fs.readFileSync('bench/.llm-real-cache.json', 'utf8'));
  const parsed = cache[key] && cache[key].q;
  console.log('parsed:', JSON.stringify(parsed));
  const res = await NliSelect.select(cmd, candidates, { query: parsed });
  console.log('mode:', res.mode, '| matches:', res.matches.length);
  console.log('top5:', res.matches.slice(0, 5).map(m => `${m.tabId}:${(m.confidence ?? 0).toFixed(2)}`).join(' '));
})();
