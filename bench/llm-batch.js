// bench/llm-batch.js
// Can an LLM do the selection directly, if we batch it properly?
//
// THE PROPOSAL BEING TESTED
// Send N tabs plus the query as JSON, ask for a yes/no per tab. This is NOT the
// design that failed at the start of the project -- that one asked the model to
// AUTHOR a list of matching tab ids, which let it invent ids, drift, and emit
// confidence 0.8 for everything. Asking for a fixed-length yes/no array is a
// genuinely different and much better-posed task:
//
//   - the output is positional, so an id cannot be hallucinated
//   - the output length is checkable against the input length
//   - "no" is a first-class answer, not an omission
//
// It also has one property nothing else in this project has: REAL WORLD
// KNOWLEDGE. "the ashes" -> cricket is a knowledge problem, and every geometric
// method (cosine, word vectors, NLI entailment) fails it for the same reason --
// none of them know what the Ashes IS.
//
// WHAT THIS MEASURES
//   1. accuracy on the same 112-command gold set (comparable to NLI's 100/112)
//   2. latency per batch, and how it scales with batch size
//   3. FORMAT COMPLIANCE -- does the array come back the right length, every
//      time? A batched design where one malformed reply corrupts 20 tabs is
//      worse than a slow one that cannot.
//   4. POSITIONAL DRIFT -- with 20 tabs in and 20 answers out, is answer[7]
//      actually about tab[7]? This is the failure mode that does not show up as
//      an error; it shows up as wrong tabs.
//
//   node bench/llm-batch.js [batchSize]

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));

const BATCH = parseInt(process.argv[2] || '15', 10);
const MODEL = process.env.SELECT_MODEL || 'qwen2.5:latest';

const qcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.llm-query-cache.json'), 'utf8'));
const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const CMDS = recs.filter(r => r.command);
const candidates = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));

const SYSTEM = `You decide whether browser tabs match a topic.

You will receive a topic and a numbered list of tabs.
For EACH tab, decide if it is about that topic.

Reply with ONLY a JSON object of this exact shape:
{"answers":[{"i":0,"match":true},{"i":1,"match":false}]}

Rules:
- Return one entry for EVERY tab, in the same order, with the same index.
- "match" must be true or false. Never null, never a string.
- Judge only the topic. Ignore how the tab is worded.
- A tab about a specific instance of a topic (a particular cricket match) IS
  about that topic (cricket).
- Do not explain. Output only the JSON object.`;

async function callOllama(prompt, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, system: SYSTEM, prompt, stream: false, format: 'json',
        options: { temperature: 0, seed: 42, num_predict: 2048, num_ctx: 8192 }
      }),
      signal: ctrl.signal
    });
    return (await res.json()).response;
  } finally { clearTimeout(timer); }
}

function tabLine(c, i) {
  return `${i}. ${(c.title || '').slice(0, 90)} | ${(c.url || '').slice(0, 60)}`;
}

(async () => {
  console.log(`\nLLM BATCH SELECTION  --  ${MODEL}, batch size ${BATCH}`);
  console.log('='.repeat(74));

  let exact = 0, pSum = 0, rSum = 0, viol = 0, n = 0;
  let totalMs = 0, calls = 0;
  let malformed = 0, wrongLength = 0, indexMismatch = 0;
  const failures = [];

  for (const c of CMDS) {
    const q = qcache[LlmQuery.normalizeCommand(c.command)] || {};
    const det = self.ConceptCore.parseCommand(c.command);
    const concepts = q.concepts?.length ? q.concepts : (det.concept ? [det.concept] : []);

    // Only test the concept path -- select_all and domain commands are already
    // short-circuited without any model and would flatter the result.
    if ((q.isSelectAll ?? det.isSelectAll) || (q.domains?.length || det.domains?.length) || !concepts.length) continue;
    n++;

    const topic = concepts.join(' or ');
    const got = new Set();

    for (let s = 0; s < candidates.length; s += BATCH) {
      const chunk = candidates.slice(s, s + BATCH);
      const prompt = `Topic: ${topic}\n\nTabs:\n${chunk.map((x, i) => tabLine(x, i)).join('\n')}\n\nReturn ${chunk.length} answers.`;
      const t = Date.now();
      let raw;
      try { raw = await callOllama(prompt); }
      catch (e) { malformed++; continue; }
      totalMs += Date.now() - t; calls++;

      let parsed;
      try { parsed = JSON.parse(raw); } catch { malformed++; continue; }
      const arr = parsed.answers || parsed.results || parsed.tabs;
      if (!Array.isArray(arr)) { malformed++; continue; }
      if (arr.length !== chunk.length) wrongLength++;

      for (const a of arr) {
        const i = typeof a.i === 'number' ? a.i : -1;
        if (i < 0 || i >= chunk.length) { indexMismatch++; continue; }
        if (a.match === true) got.add(chunk[i].tabId);
      }
    }

    const exp = new Set(c.expectedTabIds || []);
    const tp = [...got].filter(i => exp.has(i)).length;
    pSum += got.size ? tp / got.size : (exp.size === 0 ? 1 : 0);
    rSum += exp.size ? tp / exp.size : (got.size === 0 ? 1 : 0);
    const isExact = got.size === exp.size && [...exp].every(i => got.has(i));
    if (isExact) exact++;
    const v = (c.mustNotSelect || []).filter(i => got.has(i)).length;
    viol += v;
    if (!isExact && failures.length < 10) {
      failures.push({ cmd: c.command, want: [...exp], got: [...got], v });
    }

    if (n % 10 === 0) process.stdout.write(`  ...${n} commands\n`);
  }

  console.log(`\n  commands tested   ${n}  (concept path only)`);
  console.log(`  set-exact         ${exact}/${n} (${(100 * exact / n).toFixed(0)}%)`);
  console.log(`  precision         ${(100 * pSum / n).toFixed(0)}%`);
  console.log(`  recall            ${(100 * rSum / n).toFixed(0)}%`);
  console.log(`  mustNotSelect     ${viol} violation(s)`);
  console.log(`\n  RELIABILITY`);
  console.log(`  malformed replies ${malformed}`);
  console.log(`  wrong array len   ${wrongLength}`);
  console.log(`  bad indices       ${indexMismatch}`);
  console.log(`\n  LATENCY`);
  console.log(`  LLM calls         ${calls} (${(calls / n).toFixed(1)} per command)`);
  console.log(`  per call          ${(totalMs / calls).toFixed(0)}ms`);
  console.log(`  per command       ${(totalMs / n / 1000).toFixed(1)}s`);
  console.log(`  projected 451 tabs ~${(totalMs / calls * Math.ceil(451 / BATCH) / 1000).toFixed(0)}s per command`);

  if (failures.length) {
    console.log(`\n  sample failures:`);
    for (const f of failures) {
      console.log(`   "${f.cmd}"  want [${f.want}] got [${f.got}]${f.v ? '  ** FORBIDDEN **' : ''}`);
    }
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
