/**
 * Phase 2, Cycle 2: TabDB search
 * 
 * TabDB must support cosine similarity ranking via a search() method.
 * This enables local semantic retrieval without sending all tabs to the LLM.
 */

require('fake-indexeddb/auto');
const { TabDB } = require('../src/storage/db');

describe('TabDB.search', () => {
  beforeEach(async () => {
    await TabDB.init();
  });

  afterEach(() => {
    TabDB._db?.close();
    TabDB._db = null;
    const req = indexedDB.deleteDatabase('TabScrollerSimplified');
    req.onsuccess = () => {};
  });

  test('returns empty array when no cards exist', async () => {
    const results = await TabDB.search({
      queryEmbedding: [1, 0, 0],
      topK: 10,
    });
    expect(results).toEqual([]);
  });

  test('returns cards ranked by cosine similarity', async () => {
    await TabDB.storeTabCard({
      tabId: 1,
      url: 'https://react.dev',
      title: 'React',
      summary: 'UI library',
      embedding: [1, 0, 0],
      contentHash: 'a',
      lastIndexed: Date.now(),
    });
    await TabDB.storeTabCard({
      tabId: 2,
      url: 'https://vuejs.org',
      title: 'Vue',
      summary: 'Progressive framework',
      embedding: [0, 1, 0],
      contentHash: 'b',
      lastIndexed: Date.now(),
    });
    await TabDB.storeTabCard({
      tabId: 3,
      url: 'https://angular.io',
      title: 'Angular',
      summary: 'Platform',
      embedding: [0, 0, 1],
      contentHash: 'c',
      lastIndexed: Date.now(),
    });

    // Query closest to React [1, 0, 0]
    const results = await TabDB.search({
      queryEmbedding: [0.9, 0.1, 0],
      topK: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0].tabId).toBe(1); // React is closest
    expect(results[1].tabId).toBe(2); // Vue is second
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });

  test('respects topK limit', async () => {
    for (let i = 0; i < 20; i++) {
      await TabDB.storeTabCard({
        tabId: i,
        url: `https://example.com/${i}`,
        title: `Page ${i}`,
        summary: '',
        embedding: [Math.random(), Math.random(), 0],
        contentHash: `hash${i}`,
        lastIndexed: Date.now(),
      });
    }

    const results = await TabDB.search({
      queryEmbedding: [1, 0, 0],
      topK: 5,
    });

    expect(results).toHaveLength(5);
  });

  test('skips cards with null/empty embeddings', async () => {
    await TabDB.storeTabCard({
      tabId: 1,
      url: 'https://react.dev',
      title: 'React',
      summary: 'UI library',
      embedding: [1, 0, 0],
      contentHash: 'a',
      lastIndexed: Date.now(),
    });
    await TabDB.storeTabCard({
      tabId: 2,
      url: 'https://no-embed.dev',
      title: 'No Embed',
      summary: '',
      embedding: null,
      contentHash: 'b',
      lastIndexed: Date.now(),
    });

    const results = await TabDB.search({
      queryEmbedding: [1, 0, 0],
      topK: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0].tabId).toBe(1);
  });

  test('returns similarity score on each result', async () => {
    await TabDB.storeTabCard({
      tabId: 1,
      url: 'https://example.com',
      title: 'Example',
      summary: '',
      embedding: [1, 0, 0],
      contentHash: 'a',
      lastIndexed: Date.now(),
    });

    const results = await TabDB.search({
      queryEmbedding: [1, 0, 0],
      topK: 10,
    });

    expect(results[0].similarity).toBe(1); // identical vectors
  });

  test('defaults topK to 10', async () => {
    for (let i = 0; i < 15; i++) {
      await TabDB.storeTabCard({
        tabId: i,
        url: `https://example.com/${i}`,
        title: `Page ${i}`,
        summary: '',
        embedding: [1, 0, 0],
        contentHash: `hash${i}`,
        lastIndexed: Date.now(),
      });
    }

    const results = await TabDB.search({
      queryEmbedding: [1, 0, 0],
    });

    expect(results).toHaveLength(10);
  });
});
