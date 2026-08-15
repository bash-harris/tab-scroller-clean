// bench/shard-calc.js
// How many tabs fit in one Gemma-4 API call, and how many keys does 451 tabs need?
//
// Observed AI Studio limits for Gemma 4 26B / 31B (free tier):
//     30 RPM      requests per minute
//     16,000 TPM  tokens per minute   <-- the binding constraint
//     14,400 RPD  requests per day
//
// The instinct is to size the batch from the CONTEXT WINDOW. That is the wrong
// constraint. Context governs one request; TPM governs one minute. At 16K TPM a
// single key cannot spend more than 16K tokens per minute no matter how large
// its context is -- so TPM sets the batch size, and it sets it much smaller.
//
// Tokens are COUNTED with a real tokenizer, not chars/4. URLs are the reason:
// "https://www.espncricinfo.com/series/ind-vs-aus-2026/3rd-test/live" fragments
// into many subword pieces, so character-based estimates undercount tab cards
// badly -- exactly the kind of guess that has already cost this project three
// wrong constants.
//
//   node bench/shard-calc.js [numKeys] [numTabs]

const fs = require('fs');
const path = require('path');

const KEYS = parseInt(process.argv[2] || '7', 10);
const TABS = parseInt(process.argv[3] || '451', 10);

const RPM = 30, TPM = 16000, RPD = 14400;

const recs = fs.readFileSync(path.join(__dirname, 'commands-v2.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const POOL = recs.find(r => r._tabPool)._tabPool;

const SYSTEM = `You decide whether browser tabs match a topic.
You will receive a topic and a numbered list of tabs.
For EACH tab, decide if it is about that topic.
Reply with ONLY a JSON object: {"m":[0,3,7]}
listing the indices of tabs that match. Omit non-matching tabs.
Judge only the topic. A tab about a specific instance of a topic IS about that topic.
Do not explain. Output only the JSON object.`;

const render = t =>
  `${t.title.slice(0, 90)} | ${t.url.slice(0, 60)} | ${t.category} | ${(t.tags || []).join(', ')}`;

(async () => {
  const { AutoTokenizer } = require('@xenova/transformers');
  const { env } = require('@xenova/transformers');
  env.cacheDir = path.join(__dirname, '.model-cache');
  // Gemma's own tokenizer is gated; Llama-family SentencePiece is close enough
  // for sizing (both ~32-256k BPE over the same text). Flagged as approximate.
  const tok = await AutoTokenizer.from_pretrained('Xenova/gpt-4');
  const count = s => tok.encode(s).length;

  const sysTok = count(SYSTEM);
  const lines = POOL.map((t, i) => count(`${i}. ${render(t)}`));
  const avg = lines.reduce((a, b) => a + b, 0) / lines.length;
  const max = Math.max(...lines);

  console.log('\nTOKENS PER TAB CARD  (measured, gpt-4 BPE)');
  console.log('='.repeat(70));
  console.log(`  system prompt        ${sysTok} tokens`);
  console.log(`  per tab, average     ${avg.toFixed(1)} tokens`);
  console.log(`  per tab, worst       ${max} tokens`);
  console.log(`  (synthetic pool -- real titles are longer, see note below)`);

  // Real tabs are messier. Budget on a pessimistic per-tab size so the answer
  // does not fall apart the way every bench-calibrated constant already has.
  for (const [label, perTab] of [['measured', avg], ['real-world est', avg * 1.6]]) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SHARDING  --  ${TABS} tabs, ${KEYS} keys, ${perTab.toFixed(0)} tok/tab (${label})`);
    console.log('='.repeat(70));

    const overhead = sysTok + 40;                       // system + topic + instruction
    const maxByTPM = Math.floor((TPM - overhead) / perTab);
    const perShard = Math.ceil(TABS / KEYS);
    const shardTok = overhead + perShard * perTab;
    const totalTok = KEYS * shardTok;

    console.log(`  max tabs in ONE call (TPM cap)   ${maxByTPM}`);
    console.log(`  tabs per shard (${TABS}/${KEYS})          ${perShard}`);
    console.log(`  tokens per shard                 ${shardTok.toFixed(0)}  (${(100 * shardTok / TPM).toFixed(0)}% of one key's TPM)`);
    console.log(`  tokens per full scan             ${totalTok.toFixed(0)}`);

    const oneKeyScans = Math.floor(TPM / (overhead + TABS * perTab) * 10) / 10;
    console.log(`\n  ONE key alone:`);
    console.log(`    full scans per minute          ${oneKeyScans}${oneKeyScans < 1 ? '   <-- cannot even scan once' : ''}`);
    console.log(`    tokens needed for one scan     ${(overhead + TABS * perTab).toFixed(0)} vs 16000 budget`);

    const cmdsPerMin = Math.floor(TPM / shardTok);
    console.log(`\n  ${KEYS} keys in parallel:`);
    console.log(`    commands per minute            ${cmdsPerMin}`);
    console.log(`    requests per command           ${KEYS} (1 per key, concurrent)`);
    console.log(`    RPM headroom                   ${KEYS}/${RPM * KEYS} used`);
    console.log(`    commands per day (RPD)         ${Math.floor(RPD * KEYS / KEYS)}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('OUTPUT FORMAT MATTERS MORE THAN SHARDING');
  console.log('='.repeat(70));
  const yesNo = count('{"answers":[' + Array.from({ length: 100 }, (_, i) => `{"i":${i},"match":false}`).join(',') + ']}');
  const matchesOnly = count('{"m":[1,2,4,8,12,19,33,41,55,67]}');
  console.log(`  yes/no per tab, 100 tabs   ~${yesNo} output tokens`);
  console.log(`  matches-only, 10 matches   ~${matchesOnly} output tokens`);
  console.log(`  ratio                      ${(yesNo / matchesOnly).toFixed(0)}x fewer`);
  console.log(`\n  Generation is sequential even on Google's hardware, so output`);
  console.log(`  length drives latency. matches-only makes cost O(matches), not O(tabs).`);
  console.log('');
})().catch(e => { console.error(e.message); process.exit(1); });
