// bench/chroma-tabid-probe.js
// Third probe: chunks are persisted in Chroma with `tabId` metadata
// (chroma-client.js:151) and retrieval filters on tabId
// (rag-retriever.js:114, db.js:394). Chrome tab ids are EPHEMERAL — they are
// reassigned from a low counter on every browser restart. This checks whether
// the persisted index has already gone stale, and whether ids now collide
// across different pages.

const COL = '7af31640-21d0-4f89-ad20-78679dfe437b';
const BASE = `http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/${COL}`;

(async () => {
  const r = await fetch(`${BASE}/get`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 3000, include: ['metadatas'] })
  });
  const data = await r.json();
  const metas = data.metadatas || [];

  // Map tabId -> set of distinct urlHashes claiming that id.
  const byTab = new Map();
  for (const m of metas) {
    const t = m?.tabId;
    if (!Number.isFinite(t) || t <= 0) continue;
    if (!byTab.has(t)) byTab.set(t, new Map());
    byTab.get(t).set(m.urlHash || '?', String(m.title || '').slice(0, 46));
  }

  const ids = [...byTab.keys()].sort((a, b) => a - b);
  const collisions = [...byTab.entries()].filter(([, pages]) => pages.size > 1);

  console.log(`total chunks inspected : ${metas.length}`);
  console.log(`distinct tabIds        : ${ids.length}`);
  console.log(`tabId range            : ${ids[0]} .. ${ids[ids.length - 1]}`);
  console.log(`tabIds bound to >1 page: ${collisions.length}  <-- stale-id collisions\n`);

  if (collisions.length) {
    console.log('Each of these tabIds has chunks from MULTIPLE different pages.');
    console.log('At query time the candidate filter matches on tabId alone, so the');
    console.log('wrong page\'s text can be injected into another tab\'s NLI premise:\n');
    for (const [tabId, pages] of collisions.slice(0, 8)) {
      console.log(`  tabId ${tabId} claimed by ${pages.size} pages:`);
      for (const title of [...pages.values()].slice(0, 4)) console.log(`      - ${title}`);
    }
    const worst = collisions.sort((a, b) => b[1].size - a[1].size)[0];
    console.log(`\n  worst case: tabId ${worst[0]} carries chunks from ${worst[1].size} distinct pages`);
  } else {
    console.log('No collisions yet — but ids are still ephemeral, so this is luck,');
    console.log('not safety. A browser restart reassigns ids from a low counter.');
  }

  console.log(`\nStable alternative already stored on every chunk: urlHash (chroma-client.js:152).`);
})().catch(e => console.error('probe failed:', e.message));
