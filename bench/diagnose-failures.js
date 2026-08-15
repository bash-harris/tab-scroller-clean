// bench/diagnose-failures.js
// Dumps what the NLI selector actually saw for each failing command: the concept
// that was extracted, and every tab's raw entailment score. Planning fixes off
// the pass/fail list alone hides the distinction that matters most --
//
//   a WRONG ANSWER  (correct tab scored near zero -> needs knowledge/matching)
//   vs a WRONG CUT  (correct tab scored just under threshold -> needs calibration)
//
// -- which have completely different fixes.
//
//   node bench/diagnose-failures.js [commands.jsonl]

const fs = require('fs');
const path = require('path');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const NliSelect = require(path.join(__dirname, '..', 'nli-select.js'));
const { parseCommand } = require(path.join(__dirname, '..', 'concept-core.js'));

const { env } = require('@xenova/transformers');
env.cacheDir = path.join(__dirname, '.model-cache');

const CMD_FILE = process.argv[2] || path.join(__dirname, 'commands-v2.jsonl');
const recs = fs.readFileSync(CMD_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;
const CMDS = recs.filter(r => r.command);

const candidates = POOL.map(t => ({
  tabId: t.id, title: t.title, url: t.url,
  domain: (t.url.match(/\/\/([^/]+)/) || [])[1] || '',
  enrichment: { category: t.category, tags: (t.tags || []).map(tag => ({ tag, score: 0.9 })) }
}));
const byId = new Map(POOL.map(t => [t.id, t]));

(async () => {
  const zs = await NliSelect.load();
  const T = NliSelect.DEFAULT_THRESHOLD;

  const buckets = { wrongCut: [], wrongAnswer: [], overSelect: [], other: [] };

  for (const c of CMDS) {
    const res = await NliSelect.select(c.command, candidates);
    const got = new Set(res.matches.filter(m => m.confidence >= 0.5).map(m => m.tabId));
    const exp = new Set(c.expectedTabIds || []);
    const isExact = got.size === exp.size && [...exp].every(id => got.has(id));
    if (isExact) continue;

    const parsed = parseCommand(c.command);
    const concept = parsed.concept || c.command;

    // Raw entailment score for every tab, independent of thresholds.
    const scores = [];
    if (res.mode === 'nli') {
      for (const cand of candidates) {
        const out = await zs(NliSelect.tabText(cand), [concept], {
          multi_label: true, hypothesis_template: 'This browser tab is about {}.'
        });
        scores.push({ id: cand.tabId, s: out.scores[0] });
      }
      scores.sort((a, b) => b.s - a.s);
    }

    const missed = [...exp].filter(id => !got.has(id));
    const extra = [...got].filter(id => !exp.has(id));
    const scoreOf = (id) => (scores.find(x => x.id === id) || {}).s ?? null;

    // A miss whose true score is within reach of the threshold is a calibration
    // problem; one scoring near zero is a comprehension problem.
    const missedScores = missed.map(scoreOf).filter(s => s !== null);
    const nearMiss = missedScores.length && missedScores.every(s => s >= 0.25);
    const wayOff = missedScores.length && missedScores.every(s => s < 0.15);

    const row = {
      cmd: c.command, concept, mode: res.mode,
      exp: [...exp], got: [...got], missed, extra,
      top: scores.slice(0, 5),
      missedScores: missed.map(id => ({ id, s: scoreOf(id) })),
      extraScores: extra.map(id => ({ id, s: scoreOf(id) }))
    };

    if (missed.length && nearMiss) buckets.wrongCut.push(row);
    else if (missed.length && wayOff) buckets.wrongAnswer.push(row);
    else if (!missed.length && extra.length) buckets.overSelect.push(row);
    else buckets.other.push(row);
  }

  const fmt = (arr) => arr.map(x => `${x.id}:${x.s === null ? '--' : x.s.toFixed(2)}`).join(' ');
  const show = (title, rows, note) => {
    console.log(`\n${'='.repeat(78)}`);
    console.log(`${title}  (${rows.length})`);
    console.log(note);
    console.log('='.repeat(78));
    for (const r of rows) {
      console.log(`\n"${r.cmd}"   [${r.mode}]  concept=${JSON.stringify(r.concept)}`);
      console.log(`   want [${r.exp}]  got [${r.got}]`);
      if (r.missedScores.length) console.log(`   MISSED  ${fmt(r.missedScores)}`);
      if (r.extraScores.length) console.log(`   EXTRA   ${fmt(r.extraScores)}`);
      if (r.top.length) console.log(`   top5    ${fmt(r.top)}`);
    }
  };

  console.log(`\nDIAGNOSING ${path.basename(CMD_FILE)}  (threshold ${T})`);
  show('WRONG CUT -- right tab scored >= 0.25 but under threshold', buckets.wrongCut,
       'The model understood; the cutoff rejected it. Fix = calibration, not knowledge.');
  show('WRONG ANSWER -- right tab scored < 0.15', buckets.wrongAnswer,
       'The model did not connect command to tab. Fix = knowledge or matching.');
  show('OVER-SELECT -- all right tabs found, plus extras', buckets.overSelect,
       'Recall fine, precision leaks. Fix = margin or tie-break.');
  show('OTHER -- mixed miss/extra', buckets.other, 'Needs individual reading.');

  console.log(`\n${'='.repeat(78)}`);
  console.log(`wrongCut ${buckets.wrongCut.length}  wrongAnswer ${buckets.wrongAnswer.length}  ` +
              `overSelect ${buckets.overSelect.length}  other ${buckets.other.length}`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
