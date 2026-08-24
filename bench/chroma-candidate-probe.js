// bench/chroma-candidate-probe.js
// Second probe: rag-retriever.js queries Chroma for the GLOBAL top-N chunks and
// only then post-filters by candidateTabIds (rag-retriever.js:114). The
// IndexedDB fallback, by contrast, pushes candidateTabIds INTO the scan
// (db.js:394). This measures the recall gap that asymmetry costs.
// Uses TRUE cosine throughout so the separate l2-vs-cosine bug cannot mask it.

const COL = '7af31640-21d0-4f89-ad20-78679dfe437b';
const BASE = `http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/${COL}`;
const N_RESULTS = 30;   // rag-retriever.js maxChunks default
const N_CAND_TABS = 25; // a realistic post-exact-filter candidate set

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
};

(async () => {
  const { pipeline } = require('@xenova/transformers');
  const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  // Build a realistic candidate set from tabIds actually present in the index.
  const page = await post('/get', { limit: 2000, include: ['metadatas'] });
  const allTabIds = [...new Set(page.metadatas.map(m => m?.tabId).filter(t => Number.isFinite(t) && t > 0))];
  // Spread the picks across the corpus rather than taking the first 25.
  const step = Math.max(1, Math.floor(allTabIds.length / N_CAND_TABS));
  const candidates = allTabIds.filter((_, i) => i % step === 0).slice(0, N_CAND_TABS);

  console.log(`indexed tabs: ${allTabIds.length}   candidate set: ${candidates.length} tabs   n_results=${N_RESULTS}\n`);
  console.log('                      SHIPPED (global topN,        FIXED (tabId pushed down)');
  console.log('                       then post-filtered)');
  console.log('query                 chunks   tabsCovered    |  chunks   tabsCovered   recallGap');
  console.log('--------------------  ------   -----------    |  ------   -----------   ---------');

  for (const q of ['programming', 'graph algorithms', 'machine learning', 'music']) {
    const out = await embed(q, { pooling: 'mean', normalize: true });
    const qVec = Array.from(out.data);

    // A) What the shipped code does: global top-N, then drop non-candidates.
    const global = await post('/query', {
      query_embeddings: [qVec], n_results: N_RESULTS, include: ['metadatas', 'distances']
    });
    const gMeta = global.metadatas[0] || [];
    const gKept = gMeta.filter(m => candidates.includes(m?.tabId));
    const gTabs = new Set(gKept.map(m => m.tabId));

    // B) The fix: push the candidate set into Chroma's metadata filter.
    const scoped = await post('/query', {
      query_embeddings: [qVec], n_results: N_RESULTS, include: ['metadatas', 'distances'],
      where: { tabId: { $in: candidates } }
    });
    const sMeta = scoped.metadatas[0] || [];
    const sTabs = new Set(sMeta.map(m => m?.tabId).filter(Boolean));

    console.log(
      `${q.padEnd(20)}  ${String(gKept.length).padStart(6)}   ${String(gTabs.size).padStart(11)}    |  ` +
      `${String(sMeta.length).padStart(6)}   ${String(sTabs.size).padStart(11)}   ` +
      `${String(sTabs.size - gTabs.size).padStart(9)}`
    );
  }

  console.log(`\nchunks/tabsCovered = how many candidate tabs actually receive a chunk for their`);
  console.log(`NLI premise. A tab with no chunk silently reverts to the title-only premise,`);
  console.log(`so "tabsCovered" is the real measure of whether RAG reached the NLI at all.`);
})().catch(e => console.error('probe failed:', e));
