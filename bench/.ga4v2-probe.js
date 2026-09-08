// bench/.ga4v2-probe.js
// GA-4 v2 A/B probe: rank-vs-time boundary + controls, fresh parses only.
//   node bench/.ga4v2-probe.js <out.json>
// Mirrors suite-runner's callModel exactly (QUERY_MODEL, temp 0, seed 42,
// num_predict 300). Parses bypass the qcache (decode(), no reconcile) so the
// probe measures the MODEL lap: time vs rank fields are model-emitted, the
// deterministic cue layer adds none of them.

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));

const OUT = process.argv[2] || path.join(__dirname, '.ga4v2-probe-out.json');
// Optional argv[3]: a JSON array file of commands to probe (A/B attribution).
const EXTRA = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;

const COMMANDS = EXTRA || [
  // rank/time boundary cluster
  'close tabs from the last five minutes',
  'close pages opened within the past 5 minutes',
  'shut every tab from the past quarter hour',
  'close everything from the last 10 minutes',
  'close tabs from the past half hour',
  'close the five oldest tabs',
  'close the 7 newest tabs',
  'close tabs opened more than three days ago',
  // unrelated controls
  'close my netflix tabs',
  'group the climate change pages',
  'bookmark recipes for later',
  'close my twitter tabs'
];

async function callModel(system, prompt, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.QUERY_MODEL || 'qwen2.5:latest', system, prompt,
        stream: false, format: 'json', options: { temperature: 0, seed: 42, num_predict: 300 }
      }),
      signal: ctrl.signal
    });
    return (await res.json()).response;
  } finally { clearTimeout(timer); }
}

(async () => {
  const out = { promptHash: LlmQuery.PROMPT_HASH, systemLength: LlmQuery.SYSTEM.length, commands: {} };
  for (const cmd of COMMANDS) {
    const q = await LlmQuery.decode(cmd, callModel, {});
    out.commands[cmd] = q ? {
      intent: q.intent,
      concepts: q.concepts,
      domains: q.domains,
      selectAll: q.selectAll,
      exclude: q.exclude,
      time: q.time,
      rank: q.rank || null,
      state: q.state,
      confidence: q.confidence
    } : null;
    console.log(`parsed: ${cmd} -> time=${JSON.stringify(out.commands[cmd] && out.commands[cmd].time)} rank=${JSON.stringify(out.commands[cmd] && out.commands[cmd].rank)}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT} (promptHash ${out.promptHash}, systemLen ${out.systemLength})`);
})().catch(e => { console.error(e); process.exit(1); });
