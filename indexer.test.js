require('fake-indexeddb/auto');
const { TabDB } = require('../db');
const { Embed } = require('../embed');
const { Indexer } = require('../indexer');

jest.mock('../embed', () => {
  const mockEmbed = jest.fn().mockResolvedValue(new Float32Array(384).fill(0.42));
  return {
    Embed: {
      embed: mockEmbed,
      embedBatch: jest.fn(),
      init: jest.fn()
    }
  };
});

describe('Indexer', () => {
  beforeEach(async () => {
    await TabDB.init();
  });

  afterEach(() => {
    TabDB._db?.close();
    TabDB._db = null;
    const req = indexedDB.deleteDatabase('TabScrollerRAG');
    req.onsuccess = () => {};
  });

  test('stores document with correct fields from tab and extracted text', async () => {
    const tab = {
      url: 'https://react.dev/learn',
      title: 'React Quick Start'
    };

    await Indexer.indexTab(tab, 'React is a JavaScript library for building user interfaces');

    const stored = await TabDB.findByUrl('https://react.dev/learn');
    expect(stored).not.toBeNull();
    expect(stored.title).toBe('React Quick Start');
    expect(stored.domain).toBe('react.dev');
    expect(stored.snippet).toContain('React is a JavaScript library');
    expect(stored.embedding).toBeDefined();
  });

  test('classifies document category from domain using ontology', async () => {
    const testCases = [
      { url: 'https://github.com/facebook/react', expected: 'dev' },
      { url: 'https://leetcode.com/problems/two-sum', expected: 'coding' },
      { url: 'https://youtube.com/watch?v=abc123', expected: 'video' },
      { url: 'https://bbc.com/news/world', expected: 'news' },
      { url: 'https://unknown-site.example.com/page', expected: 'other' }
    ];

    for (const tc of testCases) {
      await Indexer.indexTab({ url: tc.url, title: 'test' }, 'sample content');
      const stored = await TabDB.findByUrl(tc.url);
      expect(stored.category).toBe(tc.expected);
    }
  });

  test('detects code blocks in extracted text', async () => {
    const codeTab = {
      url: 'https://example.com/code',
      title: 'Code Example'
    };
    await Indexer.indexTab(codeTab, 'Here is a function:\nfunction hello() {\n  return "world";\n}');
    let stored = await TabDB.findByUrl('https://example.com/code');
    expect(stored.hasCodeBlocks).toBe(true);

    const plainTab = {
      url: 'https://example.com/text',
      title: 'Plain Text'
    };
    await Indexer.indexTab(plainTab, 'Just a regular paragraph of text without any code.');
    stored = await TabDB.findByUrl('https://example.com/text');
    expect(stored.hasCodeBlocks).toBe(false);
  });
});
