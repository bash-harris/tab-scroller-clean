// Sample 15 non-abstain commands, seeded PRNG (reproducible)
const fs = require('fs');
const recs = fs.readFileSync(__dirname + '/real-v1.commands.jsonl', 'utf8').trim().split('\n')
  .map(l => JSON.parse(l)).filter(r => r.command && !r.abstain);
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const rnd = mulberry32(20260902);
const idx = new Set();
while (idx.size < 15) idx.add(Math.floor(rnd() * recs.length));
const picks = [...idx].sort((a,b)=>a-b).map(i => ({i, c: recs[i]}));
for (const {i, c} of picks) console.log('sample#', i, 'cat'+c.category, '|', c.command);
