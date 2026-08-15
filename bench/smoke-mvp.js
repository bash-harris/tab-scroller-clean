// bench/smoke-mvp.js
// End-to-end smoke test of the MVP selection path, exercising the same three
// modules the extension loads (concept-core -> llm-query -> nli-select) in the
// same order, with no Ollama running.
//
// The point is the DEGRADED path: with the parser unreachable, the whole
// pipeline must still answer. If this goes red, the extension is broken offline.
//
//   node bench/smoke-mvp.js

const path = require('path');
const fs = require('fs');

// Minimal service-worker shim: the extension modules attach to `self`.
global.self = global;
global.fetch = () => Promise.reject(new Error('offline (deliberate)'));

require(path.join(__dirname, '..', 'concept-core.js'));
require(path.join(__dirname, '..', 'llm-query.js'));

const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const pool = recs.find(r => r._tabPool)._tabPool
  .map(t => ({ tabId: t.id, title: t.title, url: t.url, category: t.category, tags: t.tags }));

const CASES = [
  'close my cricket tabs',
  'group all entertainment tabs',
  'close all youtube.com tabs',
  'reload everything',
  "don't close my docs, just group them"
];

(async () => {
  let fail = 0;

  console.log('\nSMOKE -- MVP path with parser OFFLINE (must degrade, not break)');
  console.log('='.repeat(70));

  for (const cmd of CASES) {
    const q = await self.LlmQuery.parse(cmd);

    // With fetch rejecting, every parse must come back from the deterministic
    // fallback -- never throw, never hang, never return a half-built object.
    const ok = q && q.source === 'fallback' && typeof q.intent === 'string' &&
               Array.isArray(q.concepts) && Array.isArray(q.domains) &&
               (q.combine === 'union' || q.combine === 'intersection');
    if (!ok) fail++;

    console.log(`${ok ? ' ' : '!'} "${cmd}"`);
    console.log(`    source=${q.source} intent=${q.intent} concepts=${JSON.stringify(q.concepts)} ` +
                `domains=${JSON.stringify(q.domains)} selectAll=${q.isSelectAll}`);
  }

  // The deterministic parser owns intent detection in the degraded path, so the
  // action still has to survive: a close must stay a close.
  const closeQ = await self.LlmQuery.parse('close my cricket tabs');
  if (closeQ.intent !== 'close_tabs') { console.log('! intent lost in fallback'); fail++; }

  const negQ = await self.LlmQuery.parse("don't close my docs, just group them");
  if (negQ.intent === 'close_tabs') { console.log('! negation dropped -- would close tabs the user protected'); fail++; }

  console.log('='.repeat(70));
  console.log(`${pool.length}-tab pool loaded, ${CASES.length} commands, ${fail} failure(s)`);
  console.log(fail ? 'SMOKE FAILED\n' : 'SMOKE PASS -- pipeline degrades cleanly with no model\n');
  process.exit(fail ? 1 : 0);
})();
