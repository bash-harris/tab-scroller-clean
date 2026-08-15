// bench/knowledge-probe.js
// Which local model actually knows what "the Ashes" is?
//
// CONTEXT
// "the Ashes" is the one gold-set case every geometric method fails: it scores
// 0.02 on NLI entailment against the Old Trafford Test report, and cosine puts
// it nowhere near cricket. Nothing in the embedding space knows that the Ashes IS
// a cricket series -- that is world knowledge, not text similarity.
//
// The user reports qwen2.5-coder failing this. That is expected and not
// informative: qwen2.5-coder is a CODE COMPLETION model. It is also the exact
// model that labelled three LeetCode tabs "entertainment" in the original
// failure. Testing world knowledge on a code model is testing the wrong thing.
//
// WHAT THIS MEASURES
// Two questions per model, because they are different capabilities:
//   1. RECALL   -- "what is the Ashes?" Does the model hold the fact at all?
//   2. APPLIED  -- given a tab card, does it route to cricket? This is the one
//                  that matters; a model can know a fact and still fail to use it.
//
// Includes a set of famously-tricky cases beyond the Ashes, so a model is not
// crowned on one lucky answer.
//
//   node bench/knowledge-probe.js

const MODELS = ['qwen2.5:latest', 'qwen2.5-coder:3b'];

// Each: a query concept + a tab card that a human would match to it, where the
// link requires knowing something about the world.
const CASES = [
  { concept: 'cricket', tab: 'England v Australia: Day 3 Report, Old Trafford | cricketreport-example.com/day3-old-trafford-report', why: 'Ashes Test, never says "cricket"' },
  { concept: 'cricket', tab: 'The Ashes 2026: Full Schedule | example.com/ashes-2026-schedule', why: 'the Ashes by name' },
  { concept: 'cricket', tab: 'IPL Auction 2026: Full Player List | iplt20.com/auction/2026', why: 'IPL is cricket' },
  { concept: 'programming', tab: 'Problem 104. Maximum Depth of Binary Tree | leetcode.com/problems/maximum-depth-of-binary-tree', why: 'LeetCode is programming, not entertainment' },
  { concept: 'programming', tab: 'Codeforces Round 918 Div 2 | codeforces.com/contest/1918', why: 'Codeforces is competitive programming' },
  { concept: 'anime', tab: 'Frieren: Beyond Journey End Ep 12 | crunchyroll.com/watch/frieren-ep12', why: 'Crunchyroll is anime' },
  { concept: 'machine learning', tab: 'Attention Is All You Need | arxiv.org/abs/1706.03762', why: 'the transformer paper' },
  { concept: 'formula 1', tab: 'Monza Qualifying Results | example.com/monza-quali', why: 'Monza is an F1 circuit' }
];

async function ask(model, system, prompt, json) {
  const t = Date.now();
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, system, prompt, stream: false,
      ...(json ? { format: 'json' } : {}),
      options: { temperature: 0, seed: 42, num_predict: json ? 128 : 220, num_ctx: 4096 }
    })
  });
  const j = await res.json();
  return { text: (j.response || '').trim(), ms: Date.now() - t };
}

(async () => {
  for (const model of MODELS) {
    console.log(`\n${'='.repeat(76)}`);
    console.log(`MODEL: ${model}`);
    console.log('='.repeat(76));

    // --- 1. Does it hold the fact? ---
    const r = await ask(model, 'Answer in one short sentence.', 'What is "the Ashes" in sport?', false);
    const holds = /cricket/i.test(r.text);
    console.log(`\n  RECALL  "What is the Ashes?"   ${holds ? 'KNOWS IT' : 'DOES NOT KNOW'}  (${r.ms}ms)`);
    console.log(`    "${r.text.replace(/\s+/g, ' ').slice(0, 150)}"`);

    // --- 2. Can it APPLY it to a tab card? ---
    console.log(`\n  APPLIED  -- does the tab match the concept?`);
    let pass = 0;
    for (const c of CASES) {
      const out = await ask(model,
        'You decide whether a browser tab is about a topic. Reply ONLY {"match":true} or {"match":false}.',
        `Topic: ${c.concept}\nTab: ${c.tab}\n\nIs this tab about the topic?`, true);
      let ok = null;
      try { ok = JSON.parse(out.text).match === true; } catch { ok = null; }
      if (ok === true) pass++;
      const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'BAD JSON';
      console.log(`    ${mark.padEnd(9)} ${c.concept.padEnd(17)} ${c.why}`);
    }
    console.log(`\n  APPLIED SCORE: ${pass}/${CASES.length}`);
  }

  console.log(`\n${'='.repeat(76)}`);
  console.log('Note: all cases are ones a human answers "yes" to, so the ideal');
  console.log('score is 8/8. A model scoring low here cannot supply the world');
  console.log('knowledge that cosine and NLI structurally lack.');
  console.log('='.repeat(76) + '\n');
})().catch(e => { console.error(e.message); process.exit(1); });
