/**
 * Phase 2, Cycle 3: SearchService
 * 
 * SearchService orchestrates semantic search:
 * 1. Generate query embedding via EmbeddingService
 * 2. Load all TabCards from TabDB
 * 3. Score by cosine similarity
 * 4. Return top K
 */

global.self = global;

// Mock EmbeddingService
global.self.EmbeddingService = {
  getEmbedding: jest.fn(),
};

// Mock TabDB
global.self.TabDB = {
  getAllTabCards: jest.fn(),
  search: jest.fn(),
};

require('../src/services/SearchService');

const SearchService = global.self.SearchService;

describe('SearchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('cosineSimilarity', () => {
    test('returns 1 for identical vectors', () => {
      expect(SearchService.cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
    });

    test('returns 0 for orthogonal vectors', () => {
      expect(SearchService.cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
    });

    test('returns 0 for empty vectors', () => {
      expect(SearchService.cosineSimilarity([], [1, 0])).toBe(0);
    });

    test('returns 0 for null vectors', () => {
      expect(SearchService.cosineSimilarity(null, [1, 0])).toBe(0);
    });

    test('handles different length vectors', () => {
      const result = SearchService.cosineSimilarity([1, 0], [1, 0, 0]);
      expect(typeof result).toBe('number');
    });
  });

  describe('searchTabs', () => {
    test('generates query embedding and returns ranked results', async () => {
      EmbeddingService.getEmbedding.mockResolvedValue([1, 0, 0]);
      TabDB.search.mockResolvedValue([
        { tabId: 1, title: 'React', url: 'https://react.dev', similarity: 0.9 },
      ]);

      const results = await SearchService.searchTabs('react', 10);

      expect(EmbeddingService.getEmbedding).toHaveBeenCalledWith('react');
      expect(TabDB.search).toHaveBeenCalledWith({ queryEmbedding: [1, 0, 0], topK: 10 });
      expect(results).toHaveLength(1);
      expect(results[0].tabId).toBe(1);
    });

    test('falls back to title matching when embedding fails', async () => {
      EmbeddingService.getEmbedding.mockResolvedValue([]);
      TabDB.getAllTabCards.mockResolvedValue([
        { tabId: 1, title: 'React Docs', url: 'https://react.dev' },
        { tabId: 2, title: 'Vue Docs', url: 'https://vuejs.org' },
      ]);

      const results = await SearchService.searchTabs('react', 10);

      expect(results).toHaveLength(1);
      expect(results[0].tabId).toBe(1);
    });

    test('returns empty array when no tabs match', async () => {
      EmbeddingService.getEmbedding.mockResolvedValue([1, 0, 0]);
      TabDB.search.mockResolvedValue([]);

      const results = await SearchService.searchTabs('react', 10);
      expect(results).toHaveLength(0);
    });

    test('respects topK parameter', async () => {
      EmbeddingService.getEmbedding.mockResolvedValue([1, 0, 0]);
      TabDB.search.mockResolvedValue([
        { tabId: 0 }, { tabId: 1 }, { tabId: 2 }, { tabId: 3 }, { tabId: 4 },
      ]);

      const results = await SearchService.searchTabs('query', 5);
      expect(results).toHaveLength(5);
    });
  });

  describe('extractDomain', () => {
    test('extracts linkedin.com from "group all linkedin tabs"', () => {
      expect(SearchService.extractDomain('group all linkedin tabs')).toBe('linkedin.com');
    });

    test('extracts github.com from "close all github tabs"', () => {
      expect(SearchService.extractDomain('close all github tabs')).toBe('github.com');
    });

    test('extracts leetcode.com', () => {
      expect(SearchService.extractDomain('bookmark all leetcode tabs')).toBe('leetcode.com');
    });

    test('returns null for unknown domain', () => {
      expect(SearchService.extractDomain('group react tabs')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(SearchService.extractDomain('')).toBeNull();
    });
  });

  describe('searchByDomain', () => {
    test('returns all tabs matching domain in URL', async () => {
      TabDB.getAllTabCards.mockResolvedValue([
        { tabId: 1, title: 'Feed', url: 'https://www.linkedin.com/feed/' },
        { tabId: 2, title: 'Jobs', url: 'https://www.linkedin.com/jobs/' },
        { tabId: 3, title: 'Home', url: 'https://github.com/' },
      ]);

      const results = await SearchService.searchByDomain('linkedin.com');
      expect(results).toHaveLength(2);
      expect(results.map(r => r.tabId)).toEqual([1, 2]);
    });

    test('returns all tabs matching domain in title', async () => {
      TabDB.getAllTabCards.mockResolvedValue([
        { tabId: 1, title: 'LeetCode Problems', url: 'https://leetcode.com/problems/' },
        { tabId: 2, title: 'GitHub Home', url: 'https://github.com/' },
      ]);

      const results = await SearchService.searchByDomain('leetcode.com');
      expect(results).toHaveLength(1);
      expect(results[0].tabId).toBe(1);
    });

    test('returns empty array when no matches', async () => {
      TabDB.getAllTabCards.mockResolvedValue([
        { tabId: 1, title: 'GitHub', url: 'https://github.com/' },
      ]);

      const results = await SearchService.searchByDomain('linkedin.com');
      expect(results).toHaveLength(0);
    });
  });
});
