// bench/chroma-query-probe.js
// Production-representative probe: embed SHORT topic queries with the same
// MiniLM-L6-v2 the extension uses, query the live Chroma `tab_chunks`
// collection, and report what chroma-client.js's `similarity = max(0, 1 - dist)`
// yields versus the true cosine — given the collection is indexed in squared-L2.

const COL = '7af31640-21d0-4f89-ad20-78679dfe437b';
const BASE = `http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/${COL}`;
const MIN_SIMILARITY = 0.15;  // rag-retriever.js default
const N_RESULTS = 30;         // rag-retriever.js maxChunks default

const QUERIES = [
  'programming',
  'graph algorithms',
  'machine learning',
  'cricket',
  'music',
  'recipes for dinner'
];

(async () => {
  const { pipeline } = require('@xenova/transformers');
  const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  console.log(`collection indexed space: l2 (squared)   n_results=${N_RESULTS}   minSimilarity=${MIN_SIMILARITY}\n`);
  console.log('query                 topCos  medCos  |  keptByChroma  keptIfCosine   verdict');
  console.log('--------------------  ------  ------  |  ------------  ------------   -------');

  for (const q of QUERIES) {
    const out = await embed(q, { pooling: 'mean', normalize: true });
    const qVec = Array.from(out.data);

    const r = await fetch(`${BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embeddings: [qVec],
        n_results: N_RESULTS,
        include: ['metadatas', 'distances']
      })
    });
    if (!r.ok) { console.log(`${q.padEnd(20)}  QUERY FAILED ${r.status}`); continue; }

    const data = await r.json();
    const dists = data.distances[0] || [];
    if (!dists.length) { console.log(`${q.padEnd(20)}  no results`); continue; }

    // For unit-normalised vectors Chroma's l2 distance is ||a-b||^2 = 2 - 2cos.
    const cosines = dists.map(d => 1 - d / 2);
    const topCos = cosines[0];
    const medCos = cosines[Math.floor(cosines.length / 2)];

    // What the shipped code keeps: max(0, 1 - l2sq) >= 0.15
    const keptByChroma = dists.filter(d => Math.max(0, 1 - d) >= MIN_SIMILARITY).length;
    // What the IndexedDB fallback path would keep: true cosine >= 0.15
    const keptIfCosine = cosines.filter(c => Math.max(0, c) >= MIN_SIMILARITY).length;

    const verdict = keptByChroma === 0
      ? 'RAG CONTRIBUTES NOTHING'
      : (keptByChroma < keptIfCosine ? `loses ${keptIfCosine - keptByChroma}` : 'ok');

    console.log(
      `${q.padEnd(20)}  ${topCos.toFixed(3).padStart(6)}  ${medCos.toFixed(3).padStart(6)}  |  ` +
      `${String(keptByChroma).padStart(12)}  ${String(keptIfCosine).padStart(12)}   ${verdict}`
    );
  }

  console.log(`\nkeptByChroma  = chunks surviving the shipped max(0, 1 - l2sq) >= ${MIN_SIMILARITY} filter`);
  console.log(`keptIfCosine  = chunks surviving the same threshold on TRUE cosine (the IndexedDB path)`);
  console.log(`A row with keptByChroma=0 means formatDeepPremise() gets no chunks and NLI`);
  console.log(`silently falls back to the old title-only premise.`);
})().catch(e => console.error('probe failed:', e));
