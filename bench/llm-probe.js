// bench/llm-probe.js
// Why did batched yes/no miss "Cricket World Cup Highlights" for topic cricket?
//
// Three candidate explanations, and they demand different fixes:
//
//   A) MY BENCH WAS UNFAIR. llm-batch.js sent only `title | url`, while NLI
//      reads `title + url + category + tags` -- so NLI saw the literal tag
//      "cricket" and the LLM did not. If parity fixes it, the 39% is my bug.
//
//   B) BATCH INTERFERENCE. Judging 15 tabs in one forward pass is a different
//      task from judging one. If the same tab passes alone and fails in a batch,
//      batching is the defect and the fix is smaller batches -- which costs
//      latency that is already fatal.
//
//   C) THE MODEL IS WRONG. If it fails alone, with tags, at temperature 0, then
//      a 7.6B general model genuinely cannot do this and only a stronger model
//      would help. That is the only branch where paying for an API is justified.
//
//   node bench/llm-probe.js

const fs = require('fs');
const path = require('path');
global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));

const MODEL = process.env.SELECT_MODEL || 'qwen2.5:latest';
const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const qcache = JSON.parse(fs.readFileSync(path.join(__dirname, '.llm-query-cache.json'), 'utf8'));

const SYSTEM = `You decide whether browser tabs match a topic.
Reply with ONLY JSON: {"answers":[{"i":0,"match":true}]}
Return one entry for EVERY tab, same order, same index.
"match" must be true or false. Do not explain.`;

async function ask(prompt) {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, system: SYSTEM, prompt, stream: false, format: 'json',
      options: { temperature: 0, seed: 42, num_predict: 1024, num_ctx: 8192 }
    })
  });
  return JSON.parse((await res.json()).response);
}

const thin = t => `${t.title.slice(0, 90)} | ${t.url.slice(0, 60)}`;
const rich = t => `${t.title.slice(0, 90)} | ${t.url.slice(0, 60)} | ${t.category} | ${(t.tags || []).join(', ')}`;

async function run(label, tabs, render, topic) {
  const prompt = `Topic: ${topic}\n\nTabs:\n` +
    tabs.map((t, i) => `${i}. ${render(t)}`).join('\n') +
    `\n\nReturn ${tabs.length} answers.`;
  const t0 = Date.now();
  let out;
  try { out = await ask(prompt); } catch (e) { console.log(`  ${label}: ERROR ${e.message}`); return null; }
  const ms = Date.now() - t0;
  const got = new Set();
  for (const a of (out.answers || [])) {
    if (typeof a.i === 'number' && a.i < tabs.length && a.match === true) got.add(tabs[a.i].id);
  }
  const want = new Set([1, 2, 4, 8]);
  const missed = [...want].filter(i => !got.has(i));
  const extra = [...got].filter(i => !want.has(i));
  const ok = !missed.length && !extra.length;
  console.log(`  ${label.padEnd(34)} ${ok ? 'PASS' : 'FAIL'}  got [${[...got].sort((a, b) => a - b)}]` +
    `${missed.length ? `  missed [${missed}]` : ''}${extra.length ? `  extra [${extra}]` : ''}  ${ms}ms`);
  return { ok, missed };
}

(async () => {
  const cached = qcache[LlmQuery.normalizeCommand('close my cricket tabs')];
  console.log(`\nmodel: ${MODEL}`);
  console.log(`topic actually sent by the bench: ${JSON.stringify(cached?.concepts)}`);
  console.log(`expansions: ${JSON.stringify(cached?.expansions)}\n`);

  const topic = (cached?.concepts || ['cricket']).join(' or ');
  const four = POOL.filter(t => [1, 2, 4, 8].includes(t.id));

  console.log('='.repeat(78));
  console.log('A) does adding category+tags fix it?   (full 15-tab batch, as benched)');
  console.log('='.repeat(78));
  await run('15 tabs, title+url  [as benched]', POOL, thin, topic);
  await run('15 tabs, +category+tags', POOL, rich, topic);

  console.log('\n' + '='.repeat(78));
  console.log('B) is the BATCH the problem?   (only the 4 cricket tabs, then 1 at a time)');
  console.log('='.repeat(78));
  await run('4 tabs only, title+url', four, thin, topic);
  await run('4 tabs only, +tags', four, rich, topic);

  for (const t of four) {
    const r = await run(`alone: tab ${t.id}`.padEnd(20) + t.title.slice(0, 28), [t], thin, topic);
    void r;
  }

  console.log('\n' + '='.repeat(78));
  console.log('C) is the TOPIC STRING the problem?   (15 tabs, tags on, plain "cricket")');
  console.log('='.repeat(78));
  await run('topic = "cricket" literal', POOL, rich, 'cricket');
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
