// bench/chroma-space-probe.js
// Probe the LIVE Chroma collection to measure what `similarity = 1 - distance`
// (chroma-client.js:232) actually produces, given the collection is indexed in
// squared-L2 rather than cosine. Uses a real stored chunk vector as the query so
// the neighbour distances are representative of production queries.

const COL = '7af31640-21d0-4f89-ad20-78679dfe437b';
const BASE = `http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/${COL}`;
const MIN_SIMILARITY = 0.15; // rag-retriever.js default

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
};

const norm = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

(async () => {
  // Pull a page of real records and pick one that is not a test fixture.
  const page = await post('/get', { limit: 60, include: ['embeddings', 'documents', 'metadatas'] });
  const idx = page.ids.findIndex((id, i) =>
    !/^test/i.test(id) && Array.isArray(page.embeddings?.[i]) && norm(page.embeddings[i]) > 0.5
  );
  if (idx === -1) {
    console.log('No real (non-test) embedded chunk found in the first 60 records.');
    return;
  }

  const qVec = page.embeddings[idx];
  console.log(`Query vector = stored chunk "${page.ids[idx]}"`);
  console.log(`  title: ${String(page.metadatas?.[idx]?.title || '').slice(0, 70)}`);
  console.log(`  ||q|| = ${norm(qVec).toFixed(4)}  (1.0 => unit-normalised, so L2sq = 2 - 2cos)\n`);

  const res = await post('/query', {
    query_embeddings: [qVec],
    n_results: 10,
    include: ['metadatas', 'documents', 'distances']
  });

  const dists = res.distances[0];
  const ids = res.ids[0];
  const metas = res.metadatas[0];

  console.log('rank  distance   1-dist   clamped  impliedCos  kept?   title');
  console.log('----  --------  -------  --------  ----------  ------  -----');
  let kept = 0;
  dists.forEach((d, i) => {
    const raw = 1 - d;
    const clamped = Math.max(0, raw);          // chroma-client.js:232
    const cos = 1 - d / 2;                     // exact inverse of L2sq for unit vectors
    const keep = clamped >= MIN_SIMILARITY;    // rag-retriever.js:115
    if (keep) kept++;
    console.log(
      `${String(i + 1).padStart(4)}  ${d.toFixed(4).padStart(8)}  ${raw.toFixed(4).padStart(7)}  ` +
      `${clamped.toFixed(4).padStart(8)}  ${cos.toFixed(4).padStart(10)}  ${(keep ? 'KEEP' : 'drop').padStart(6)}  ` +
      `${String(metas?.[i]?.title || ids[i]).slice(0, 40)}`
    );
  });

  console.log(`\nchunks surviving minSimilarity=${MIN_SIMILARITY}: ${kept}/${dists.length}`);
  console.log(`(rank 1 is the query chunk itself, so a healthy run should keep far more than 1)`);

  // What cosine is actually required to survive, under the L2 mis-read?
  console.log(`\nUnder squared-L2, similarity=1-dist >= ${MIN_SIMILARITY} requires dist <= ${1 - MIN_SIMILARITY}`);
  console.log(`  => cos >= ${(1 - (1 - MIN_SIMILARITY) / 2).toFixed(4)}`);
  console.log(`Under true cosine (the IndexedDB fallback path) the same threshold requires cos >= ${MIN_SIMILARITY}`);
})().catch(e => console.error('probe failed:', e.message));
