// bench/gold-audit.js
// Mechanic satisfiability audit over every labelled set. Finds label bugs the
// way GZ-068 was found: by recomputing temporal windows and set relations from
// pool metadata instead of trusting hand-written expectations.
//
//   node bench/gold-audit.js [file.jsonl ...]     (default: all three benches)

'use strict';
const fs = require('fs');
const path = require('path');

const DAY = 86400000, MIN = 60000, HOUR = 3600000;
const INTERNALS_PER_FILE = { 'golden-set.jsonl': [47, 48], 'golden-set-v2.jsonl': [147, 148], 'open-bookmark-bench.jsonl': [47, 48] };

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['golden-set.jsonl', 'open-bookmark-bench.jsonl', 'golden-set-v2.jsonl'].map(f => path.join(__dirname, f));

let totalIssues = 0;

for (const file of files) {
  const recs = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
  const meta = recs.find(r => r._meta);
  const pool = recs.find(r => r._tabPool)._tabPool;
  const benchNow = Date.parse(meta?._meta?.benchNow || Math.max(...pool.map(t => Date.parse(t.lastAccessed))));
  const issues = [];
  const name = path.basename(file);
  const internals = new Set(INTERNALS_PER_FILE[name] || []);

  const tsOf = (id, field) => {
    const t = pool.find(p => p.id === id);
    return t ? Date.parse(t[field]) : NaN;
  };

  for (const c of recs.filter(r => r.command)) {
    const exp = c.expectedTabIds || [];

    // --- Temporal phrase vs timestamp consistency -------------------------
    if (exp.length && /yesterday/i.test(c.command)) {
      for (const id of exp) {
        const t = tsOf(id, /opened|open(ed)?\s/i.test(c.command) ? 'openedAt' : 'lastAccessed');
        const day = (ms) => Math.floor(ms / DAY);
        if (!Number.isFinite(t)) continue;
        const isYest = day(t) === day(benchNow) - 1;
        // "close/open tabs from yesterday" style: every expected tab must be
        // from yesterday; also flag gold listing non-yesterday ids.
        if (/^\s*(close|open|group|reload|mute|bookmark)\b/i.test(c.command) && !isYest && !/except/i.test(c.command)) {
          issues.push(`${c.id}: yesterday-window includes ${id} with ts ${new Date(t).toISOString()} (not yesterday)`);
        }
      }
    }
    if (exp.length && /\b(\d+|twenty|thirty|fifteen)\s*minutes?\b/i.test(c.command) && /last|within|past/i.test(c.command)) {
      const m = c.command.match(/(\d+|twenty|thirty|fifteen)\s*minutes?/i);
      const words = { twenty: 20, thirty: 30, fifteen: 15 };
      const mins = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
      for (const id of exp) {
        const t = tsOf(id, 'lastAccessed');
        if (!Number.isFinite(t)) continue;
        if (benchNow - t > mins * MIN + 60000 /*1min tolerance*/) {
          issues.push(`${c.id}: "${mins} minutes" window includes ${id} accessed ${Math.round((benchNow - t) / MIN)}min before anchor`);
        }
      }
    }
    if (exp.length && /(older|more than a month|months)\b/i.test(c.command) && /(month)/i.test(c.command)) {
      for (const id of exp) {
        const t = tsOf(id, 'openedAt');
        if (Number.isFinite(t) && benchNow - t < 30 * DAY) {
          issues.push(`${c.id}: ">1 month" includes ${id} opened ${Math.round((benchNow - t) / DAY)} days ago`);
        }
      }
    }

    // --- Expected ∩ mustNotSelect ----------------------------------------
    const inter = (c.mustNotSelect || []).filter(id => exp.includes(id));
    if (inter.length) issues.push(`${c.id}: expected ∩ mustNotSelect = [${inter}]`);

    // --- Internal tabs referenced as selectable ---------------------------
    for (const id of exp) if (internals.has(id)) issues.push(`${c.id}: internal tab ${id} in expectedTabIds`);

    // --- Complement-shape cases: universe minus excluded must be reachable -
    if ((c.mustNotSelect || []).length > 5 && exp.length > 0) {
      // For large complements, sanity: no expected id may carry a category that
      // the exclusion phrase names verbatim (heuristic flag only).
      const exclPhrase = (c.command.match(/except\s+(?:the\s+)?([a-z\s]{3,30})/i) || [])[1];
      if (exclPhrase) {
        const phrase = exclPhrase.trim();
        for (const id of exp) {
          const t = pool.find(p => p.id === id);
          if (!t) continue;
          const catHit = wordEq(phrase, t.category) || (t.tags || []).some(tag => wordEq(phrase, tag));
          const hostHit = wordEq(phrase, String(t.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]);
          if (catHit && !/\b(not|never|neither|nor)\b/i.test(c.command)) {
            issues.push(`${c.id}: complement expects to ACT ON ${id} but its own ${wordEq(phrase, t.category) ? 'category' : 'tag'} matches exception phrase "${phrase}" — verify direction`);
          }
          if (hostHit) {
            issues.push(`${c.id}: complement expects to ACT ON ${id} whose HOST matches exception phrase "${phrase}"`);
          }
        }
      }
    }
  }

  console.log(`\n${name}: ${issues.length} issue(s)`);
  issues.forEach(i => console.log('  ! ' + i));
  totalIssues += issues.length;
}

function wordEq(phrase, token) {
  if (!token) return false;
  const p = String(phrase).toLowerCase().split(/\s+/);
  const t = String(token).toLowerCase();
  return p.includes(t) && t.length > 3;
}

console.log(`\nTOTAL issues: ${totalIssues}`);
process.exit(totalIssues ? 0 : 0); // audit reports; does not fail runs
