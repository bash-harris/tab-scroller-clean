require('fake-indexeddb/auto');
const { TabDB } = require('../db');

describe('TabDB', () => {
  beforeEach(async () => {
    await TabDB.init();
  });

  afterEach(() => {
    TabDB._db?.close();
    TabDB._db = null;
    const req = indexedDB.deleteDatabase('TabScrollerRAG');
    req.onsuccess = () => {};
  });

  test('stores and retrieves a document by URL', async () => {
    const doc = {
      id: 'https://example.com/page',
      url: 'https://example.com/page',
      title: 'Example Page',
      domain: 'example.com',
      snippet: 'This is an example page for testing',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0.1, 0.2, 0.3])
    };

    await TabDB.store(doc);
    const retrieved = await TabDB.findByUrl('https://example.com/page');

    expect(retrieved).not.toBeNull();
    expect(retrieved.title).toBe('Example Page');
    expect(retrieved.domain).toBe('example.com');
    expect(retrieved.snippet).toBe('This is an example page for testing');
  });

  test('updates an existing document when storing same URL', async () => {
    const original = {
      id: 'https://example.com/page',
      url: 'https://example.com/page',
      title: 'Old Title',
      snippet: 'Old snippet',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0.1])
    };
    await TabDB.store(original);

    const updated = {
      id: 'https://example.com/page',
      url: 'https://example.com/page',
      title: 'New Title',
      snippet: 'New snippet',
      lastVisited: 1800000000000,
      embedding: new Float32Array([0.9])
    };
    await TabDB.store(updated);

    const retrieved = await TabDB.findByUrl('https://example.com/page');
    expect(retrieved.title).toBe('New Title');
    expect(retrieved.snippet).toBe('New snippet');
    expect(retrieved.lastVisited).toBe(1800000000000);
  });

  test('filters documents by category', async () => {
    const devDoc = {
      id: 'https://github.com',
      url: 'https://github.com',
      title: 'GitHub',
      domain: 'github.com',
      category: 'dev',
      snippet: 'Dev platform',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0.1])
    };
    const newsDoc = {
      id: 'https://bbc.com',
      url: 'https://bbc.com',
      title: 'BBC',
      domain: 'bbc.com',
      category: 'news',
      snippet: 'News site',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0.2])
    };
    const devDoc2 = {
      id: 'https://stackoverflow.com',
      url: 'https://stackoverflow.com',
      title: 'Stack Overflow',
      domain: 'stackoverflow.com',
      category: 'dev',
      snippet: 'Q&A for devs',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0.3])
    };

    await TabDB.store(devDoc);
    await TabDB.store(newsDoc);
    await TabDB.store(devDoc2);

    const devResults = await TabDB.search({ categories: ['dev'] });
    expect(devResults).toHaveLength(2);
    expect(devResults.map(r => r.domain)).toEqual(expect.arrayContaining(['github.com', 'stackoverflow.com']));

    const newsResults = await TabDB.search({ categories: ['news'] });
    expect(newsResults).toHaveLength(1);
    expect(newsResults[0].domain).toBe('bbc.com');
  });

  test('filters documents by time range', async () => {
    const oldDoc = {
      id: 'https://old.com',
      url: 'https://old.com',
      title: 'Old',
      domain: 'old.com',
      lastVisited: 1000000000000,
      embedding: new Float32Array([0.1])
    };
    const recentDoc = {
      id: 'https://recent.com',
      url: 'https://recent.com',
      title: 'Recent',
      domain: 'recent.com',
      lastVisited: 2000000000000,
      embedding: new Float32Array([0.2])
    };

    await TabDB.store(oldDoc);
    await TabDB.store(recentDoc);

    const results = await TabDB.search({ since: 1500000000000 });
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe('recent.com');
  });

  test('ranks documents by cosine similarity to query embedding', async () => {
    const catDoc = {
      id: 'https://cats.com',
      url: 'https://cats.com',
      title: 'Cats',
      domain: 'cats.com',
      snippet: 'All about cats',
      lastVisited: 1700000000000,
      embedding: new Float32Array([1, 0, 0])
    };
    const dogDoc = {
      id: 'https://dogs.com',
      url: 'https://dogs.com',
      title: 'Dogs',
      domain: 'dogs.com',
      snippet: 'All about dogs',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0, 1, 0])
    };
    const birdDoc = {
      id: 'https://birds.com',
      url: 'https://birds.com',
      title: 'Birds',
      domain: 'birds.com',
      snippet: 'All about birds',
      lastVisited: 1700000000000,
      embedding: new Float32Array([0, 0, 1])
    };

    await TabDB.store(catDoc);
    await TabDB.store(dogDoc);
    await TabDB.store(birdDoc);

    // Query vector closest to "cat" = [1, 0, 0]
    const queryEmbedding = new Float32Array([0.9, 0.1, 0]);
    const results = await TabDB.search({ queryEmbedding, topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0].domain).toBe('cats.com');
    expect(results[1].domain).toBe('dogs.com');
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });

  test('combines category, time, and vector search together', async () => {
    const devOld = {
      id: 'https://old-dev.com',
      url: 'https://old-dev.com',
      title: 'Old Dev',
      domain: 'old-dev.com',
      category: 'dev',
      lastVisited: 1000000000000,
      embedding: new Float32Array([1, 0, 0])
    };
    const devRecent = {
      id: 'https://react.dev',
      url: 'https://react.dev',
      title: 'React',
      domain: 'react.dev',
      category: 'dev',
      lastVisited: 2000000000000,
      embedding: new Float32Array([0.9, 0.1, 0])
    };
    const newsRecent = {
      id: 'https://bbc.com',
      url: 'https://bbc.com',
      title: 'BBC',
      domain: 'bbc.com',
      category: 'news',
      lastVisited: 2000000000000,
      embedding: new Float32Array([0, 0, 1])
    };

    await TabDB.store(devOld);
    await TabDB.store(devRecent);
    await TabDB.store(newsRecent);

    // "React dev pages from yesterday" — category=dev, since=yesterday, query=react
    const queryEmbedding = new Float32Array([0.8, 0.2, 0]);
    const results = await TabDB.search({
      categories: ['dev'],
      since: 1500000000000,
      queryEmbedding,
      topK: 5
    });

    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe('react.dev');
    expect(results[0].similarity).toBeGreaterThan(0.9);
  });
});
