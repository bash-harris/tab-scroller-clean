require('fake-indexeddb/auto');
const { TabDB } = require('../db');
const { RecallTabs } = require('../recall-tabs');

jest.mock('../embed', () => ({
  Embed: {
    embed: jest.fn().mockImplementation(async (text) => {
      if (text.includes('cat')) return new Float32Array([1, 0, 0]);
      if (text.includes('dog')) return new Float32Array([0, 1, 0]);
      if (text.includes('bird')) return new Float32Array([0, 0, 1]);
      return new Float32Array([0, 0, 0]);
    }),
    init: jest.fn()
  }
}));

describe('RecallTabs', () => {
  beforeEach(async () => {
    await TabDB.init();
    const docs = [
      { id: 'https://cats.com', url: 'https://cats.com', title: 'Cats', domain: 'cats.com', category: 'news', snippet: 'All about cats', embedding: new Float32Array([1, 0, 0]), lastVisited: 2000000000000 },
      { id: 'https://dogs.com', url: 'https://dogs.com', title: 'Dogs', domain: 'dogs.com', category: 'news', snippet: 'All about dogs', embedding: new Float32Array([0, 1, 0]), lastVisited: 2000000000000 },
      { id: 'https://birds.com', url: 'https://birds.com', title: 'Birds', domain: 'birds.com', category: 'news', snippet: 'All about birds', embedding: new Float32Array([0, 0, 1]), lastVisited: 1000000000000 }
    ];
    for (const doc of docs) {
      await TabDB.store(doc);
    }
  });

  afterEach(() => {
    TabDB._db?.close();
    TabDB._db = null;
    const req = indexedDB.deleteDatabase('TabScrollerRAG');
    req.onsuccess = () => {};
  });

  test('returns results ranked by similarity', async () => {
    const results = await RecallTabs.search({ query: 'cats' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].domain).toBe('cats.com');
    if (results.length > 1) {
      expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
    }
  });

  test('filters results by category', async () => {
    await TabDB.store({
      id: 'https://dev.com', url: 'https://dev.com', title: 'Dev', domain: 'dev.com',
      category: 'dev', snippet: 'dev stuff', embedding: new Float32Array([1, 0, 0]), lastVisited: 2000000000000
    });

    const devOnly = await RecallTabs.search({ query: 'cats', categories: ['dev'] });
    expect(devOnly).toHaveLength(1);
    expect(devOnly[0].domain).toBe('dev.com');

    const newsOnly = await RecallTabs.search({ query: 'cats', categories: ['news'] });
    expect(newsOnly.length).toBeGreaterThanOrEqual(1);
    expect(newsOnly[0].domain).toBe('cats.com');
    expect(newsOnly.every(r => r.category === 'news')).toBe(true);
  });

  test('filters by time range', async () => {
    const recentOnly = await RecallTabs.search({ query: 'cats', timeRange: 'yesterday' });
    expect(recentOnly.every(r => r.lastVisited >= Date.now() - 2 * 86400000)).toBe(true);
    expect(recentOnly.some(r => r.domain === 'cats.com')).toBe(true);
    expect(recentOnly.some(r => r.domain === 'birds.com')).toBe(false);
  });

  test('returns empty array when no documents match', async () => {
    const results = await RecallTabs.search({ query: 'nonexistent' });
    expect(results).toEqual([]);
  });

  test('combines category, time, and query filters together', async () => {
    const results = await RecallTabs.search({
      query: 'cats',
      categories: ['news'],
      timeRange: 'today',
      topK: 5
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].domain).toBe('cats.com');
    expect(results.every(r => r.category === 'news')).toBe(true);
    expect(results.every(r => r.lastVisited >= Date.now() - 86400000)).toBe(true);
  });
});

const NOW = 2000000000000;

describe('RecallTabs integration — resolution logic', () => {
  beforeEach(async () => {
    await TabDB.init();
    const docs = [];
    for (let i = 0; i < 15; i++) {
      docs.push({
        id: `https://page${i}.com`,
        url: `https://page${i}.com`,
        title: `Page ${i}`,
        domain: `page${i}.com`,
        category: i % 3 === 0 ? 'dev' : i % 3 === 1 ? 'news' : 'learning',
        snippet: `Content for page ${i}`,
        embedding: new Float32Array([i >= 11 ? 0.2 : 0.9, 0.1, 0]),
        lastVisited: NOW - (i * 7200000)
      });
    }
    for (const doc of docs) {
      await TabDB.store(doc);
    }
  });

  afterEach(() => {
    TabDB._db?.close();
    TabDB._db = null;
    const req = indexedDB.deleteDatabase('TabScrollerRAG');
    req.onsuccess = () => {};
  });

  test('resolve with selectedIndices opens specific results', () => {
    const results = [
      { url: 'https://a.com', title: 'A', similarity: 0.9 },
      { url: 'https://b.com', title: 'B', similarity: 0.7 },
      { url: 'https://c.com', title: 'C', similarity: 0.5 },
    ];
    const res = RecallTabs.resolve(results, [0, 2]);
    expect(res.action).toBe('open');
    expect(res.urls).toEqual(['https://a.com', 'https://c.com']);
    expect(res.count).toBe(2);
  });

  test('resolve with ≤3 results returns open', () => {
    const results = [
      { url: 'https://a.com', title: 'A', similarity: 0.9 },
    ];
    const res = RecallTabs.resolve(results);
    expect(res.action).toBe('open');
    expect(res.urls).toEqual(['https://a.com']);
  });

  test('resolve with 4-10 results returns list', () => {
    const results = Array.from({ length: 6 }, (_, i) => ({
      url: `https://page${i}.com`, title: `Page ${i}`, similarity: 1 - i * 0.1
    }));
    const res = RecallTabs.resolve(results);
    expect(res.action).toBe('list');
    expect(res.results).toHaveLength(6);
    expect(res.count).toBe(6);
  });

  test('resolve with >10 results returns narrow', () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      url: `https://page${i}.com`, title: `Page ${i}`, similarity: 1 - i * 0.1
    }));
    const res = RecallTabs.resolve(results);
    expect(res.action).toBe('narrow');
    expect(res.results).toHaveLength(3);
    expect(res.count).toBe(12);
  });

  test('resolve with empty results returns none', () => {
    const res = RecallTabs.resolve([]);
    expect(res.action).toBe('none');
  });

  test('resolve with invalid selectedIndices returns error', () => {
    const results = [{ url: 'https://a.com', title: 'A', similarity: 0.9 }];
    const res = RecallTabs.resolve(results, [5]);
    expect(res.action).toBe('error');
  });

  test('realistic query: "find my coding tabs" returns dev category results', async () => {
    const results = await RecallTabs.search({ query: 'coding', categories: ['dev'] });
    expect(results.every(r => r.category === 'dev')).toBe(true);
  });

  test('realistic query: many results trigger narrow action', async () => {
    const results = await RecallTabs.search({ query: 'cats', topK: 20 });
    const res = RecallTabs.resolve(results);
    expect(res.action).toBe('narrow');
    expect(res.count).toBeGreaterThan(10);
  });

  test('realistic query with category returns only matching results', async () => {
    const results = await RecallTabs.search({ query: 'cats', categories: ['dev'], topK: 20 });
    expect(results.every(r => r.category === 'dev')).toBe(true);
  });

  test('realistic query with time range excludes old results', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const allResults = await RecallTabs.search({ query: 'cats', topK: 20 });
    expect(allResults.length).toBe(15);
    const todayResults = await RecallTabs.search({ query: 'cats', timeRange: 'today', topK: 20 });
    expect(todayResults.length).toBeLessThan(allResults.length);
    expect(todayResults.length).toBe(13);
    Date.now.mockRestore();
  });

  test('combines category + time + query for realistic filtering', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const results = await RecallTabs.search({ query: 'cats', categories: ['dev'], timeRange: 'today', topK: 20 });
    expect(results.every(r => r.category === 'dev')).toBe(true);
    expect(results.length).toBe(5);
    Date.now.mockRestore();
  });
});
