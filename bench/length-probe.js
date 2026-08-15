// bench/length-probe.js
// Per-forward-pass cost as a function of PREMISE LENGTH, using realistic tab
// text rather than the bench pool.
//
// This corrects a bug in the first version of this measurement: the bench pool's
// cards are only ~114 chars, so slicing them to 400/240/160 measured the same
// string four times and reported a flat line. Real tabs -- long titles, long
// query-string URLs -- hit the 400-char MAX_TAB_CHARS cap, so the shipping path
// pays for 3-4x more tokens than the bench ever measured.
//
//   node bench/length-probe.js

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const N = require(path.join(__dirname, '..', 'nli-select.js'));
const { env, pipeline, AutoTokenizer } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

// A tab card the way it actually looks in a 451-tab profile, not the way the
// synthetic pool looks.
const REAL = [
  'Elden Ring Nightreign - Everything We Know So Far | Full Gameplay Breakdown, Release Date, Classes and Multiplayer Details - IGN https://www.ign.com/articles/elden-ring-nightreign-everything-we-know-gameplay-release-date-classes?utm_source=newsletter&utm_medium=email&utm_campaign=weekly gaming games rpg fromsoftware',
  '(4) Steam Community :: Guide :: The Complete Achievement Walkthrough for Baldur\'s Gate 3 Act 3 Including All Missable Companion Quests https://steamcommunity.com/sharedfiles/filedetails/?id=3012847561&searchtext=achievements gaming guide rpg',
  'javascript - How do I resolve "Cannot read properties of undefined (reading \'map\')" in a React functional component after an async fetch? - Stack Overflow https://stackoverflow.com/questions/54862835/how-do-i-resolve-cannot-read-properties-of-undefined-reading-map programming javascript react debugging',
];

(async () => {
  const tokenizer = await AutoTokenizer.from_pretrained(N.MODEL_ID);
  const zs = await pipeline('zero-shot-classification', N.MODEL_ID);
  const HYP = 'This browser tab is about {}.';

  console.log('\nPER-PASS COST vs PREMISE LENGTH  (native onnxruntime-node)');
  console.log('='.repeat(64));
  console.log('  chars   tokens   per-pass   vs 400ch   note');
  console.log('-'.repeat(64));

  const REPS = 12;
  const results = {};
  for (const limit of [400, 300, 200, 140, 100, 64]) {
    const texts = REAL.map(s => s.slice(0, limit));
    const tokens = Math.round(texts.reduce((a, s) =>
      a + tokenizer(s, { text_pair: 'This browser tab is about gaming.' }).input_ids.dims[1], 0) / texts.length);
    // warm
    await zs(texts[0], ['gaming'], { multi_label: true, hypothesis_template: HYP });
    const t = Date.now();
    for (let r = 0; r < REPS; r++) {
      for (const s of texts) await zs(s, ['gaming'], { multi_label: true, hypothesis_template: HYP });
    }
    const per = (Date.now() - t) / (REPS * texts.length);
    results[limit] = per;
    const rel = per / results[400];
    console.log(`  ${String(limit).padStart(5)}   ${String(tokens).padStart(6)}   ` +
      `${(per.toFixed(1) + 'ms').padStart(8)}   ${(rel.toFixed(2) + 'x').padStart(7)}   ` +
      `${limit === 400 ? 'current MAX_TAB_CHARS' : ''}`);
  }

  // Does truncating change the score? Cheap accuracy guard on the cost lever.
  console.log('\n  score drift from truncation (vs 400 chars):');
  for (const limit of [200, 140, 100]) {
    let maxD = 0;
    for (const s of REAL) {
      const a = await zs(s.slice(0, 400), ['gaming'], { multi_label: true, hypothesis_template: HYP });
      const b = await zs(s.slice(0, limit), ['gaming'], { multi_label: true, hypothesis_template: HYP });
      maxD = Math.max(maxD, Math.abs(a.scores[0] - b.scores[0]));
    }
    console.log(`    ${String(limit).padStart(3)} chars: max delta ${maxD.toFixed(3)}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
