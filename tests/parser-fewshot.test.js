// tests/parser-fewshot.test.js
// GA-4 v2 PROMPT_HASH stamp + few-shot guardrails.
//
// GA-4 v2 outcome (DRIFT-REJECT): a 3-line time-basis few-shot addition to
// SLOT_EXAMPLES caused parse drift on BOTH bench models (suite-v3 174/181 on
// qwen2.5-coder-3b-ctx, 165/181 viol 2 on qwen2.5:latest; fresh-parse A/B
// attributed 13/16 failures to the edit -- selectAll flips, exclude
// inversions, rank->time conversions). The prompt edit was reverted; the
// PROMPT_HASH stamping infra stays. This suite now guards:
//   1. PROMPT_HASH: exists, deterministic, changes on prompt edit.
//   2. The drift-rejected example commands stay OUT of SYSTEM (and out of
//      SLOT_EXAMPLES bloat: <= 6 example lines).
//   3. Leakage: the candidate example commands must never appear in ANY gold
//      commands file -- the parser must not memorize its own benchmark.
//
//   node tests/parser-fewshot.test.js

'use strict';
const path = require('path');
const fs = require('fs');

global.self = global;
require(path.join(__dirname, '..', 'concept-core.js'));
const LlmQuery = require(path.join(__dirname, '..', 'llm-query.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok:', name); }
  else { fail++; console.log('  FAIL:', name); }
}

// The GA-4 v2 few-shot candidates (drift-rejected; kept as tripwires).
const REJECTED_EXAMPLE_COMMANDS = [
  'close tabs from the last five minutes',
  'close pages opened within the past 5 minutes',
  'shut every tab from the past quarter hour'
];

// ---- 1. PROMPT_HASH stamp ----------------------------------------------------
console.log('\n--- 1. PROMPT_HASH stamp ---');
ok(typeof LlmQuery.PROMPT_HASH === 'string' && LlmQuery.PROMPT_HASH.length > 0,
  `PROMPT_HASH is a non-empty string (${LlmQuery.PROMPT_HASH})`);
{
  // Deterministic: recompute djb2 over SYSTEM's code points, twice, same value.
  const djb2 = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; ) {
      const cp = s.codePointAt(i);
      h = ((h << 5) + h + cp) | 0;
      i += cp > 0xffff ? 2 : 1;
    }
    return (h >>> 0).toString(16);
  };
  const a = djb2(LlmQuery.SYSTEM), b = djb2(LlmQuery.SYSTEM);
  ok(a === b && a === LlmQuery.PROMPT_HASH, `hash deterministic and equals export (${a})`);

  // Sensitivity: a modified SYSTEM copy hashes differently.
  ok(djb2(LlmQuery.SYSTEM + 'x') !== LlmQuery.PROMPT_HASH,
    'hash changes on modified SYSTEM copy');
}

// ---- 2. Rejected few-shot lines stay OUT; example count stays capped ---------
console.log('\n--- 2. rejected few-shot absent + SLOT_EXAMPLES <= 6 ---');
{
  const sys = String(LlmQuery.SYSTEM);
  for (const cmd of REJECTED_EXAMPLE_COMMANDS) {
    let count = 0, idx = 0;
    while ((idx = sys.indexOf(`"${cmd}" ->`, idx)) !== -1) { count++; idx += 1; }
    ok(count === 0, `drift-rejected example NOT in SYSTEM (found ${count}): "${cmd}"`);
  }
  // In the assembled SYSTEM the SLOT_EXAMPLES block is the text between the
  // FIRST "Examples:" marker (end of QUALIFIER_TEMPLATE) and the blank line
  // before "intent is exactly one of". Every `"..." -> {json}` line counts
  // as one few-shot example.
  const start = sys.indexOf('Examples:');
  const end = sys.indexOf('intent is exactly one of');
  ok(start !== -1 && end !== -1 && start < end, 'SLOT_EXAMPLES block boundaries found');
  const block = start !== -1 && end !== -1 ? sys.slice(start, end) : '';
  const lines = block.split('\n').filter(l => l.includes('" -> {'));
  ok(lines.length >= 1, 'SLOT_EXAMPLES block found and non-empty');
  ok(lines.length <= 6, `SLOT_EXAMPLES line count <= 6 (got ${lines.length})`);
}

// ---- 3. Leakage: candidate commands must not appear in ANY gold file ---------
console.log('\n--- 3. leakage grep vs all gold command files ---');
{
  const benchDir = path.join(__dirname, '..', 'bench');
  const goldFiles = fs.readdirSync(benchDir)
    .filter(f => f.endsWith('.commands.jsonl'));
  ok(goldFiles.length >= 3, `gold command files found: ${goldFiles.join(', ')}`);
  let leaked = [];
  for (const f of goldFiles) {
    // Raw byte read: file content is treated as opaque data, never printed.
    const content = fs.readFileSync(path.join(benchDir, f), 'utf8');
    for (const cmd of REJECTED_EXAMPLE_COMMANDS) {
      if (content.includes(`"${cmd}"`)) leaked.push(`${f}: "${cmd}"`);
    }
  }
  ok(leaked.length === 0, `no candidate example command appears in any gold file${leaked.length ? ' -- LEAKS: ' + leaked.join('; ') : ''}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
