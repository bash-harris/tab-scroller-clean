/**
 * Phase 3: Background RAG flow with hybrid retrieval
 *
 * Background must:
 * 1. Index all tabs into TabDB on startup
 * 2. Use RetrievalService to retrieve ranked candidates before sending to LLM
 * 3. Listen for tab events to keep TabDB in sync
 */

global.self = global;
global.importScripts = jest.fn();

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    onMessage: { addListener: jest.fn() },
    onInstalled: { addListener: jest.fn() },
  },
  tabs: {
    query: jest.fn(),
    get: jest.fn(),
    group: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
    onCreated: { addListener: jest.fn() },
    onUpdated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() },
  },
  tabGroups: { update: jest.fn() },
  bookmarks: { getTree: jest.fn(), create: jest.fn() },
  windows: { WINDOW_ID_CURRENT: -1 },
};

global.self.TabService = {
  getAllTabs: jest.fn().mockResolvedValue([]),
  groupTabs: jest.fn().mockResolvedValue({ groupId: 1, grouped: 1, skipped: 0 }),
  closeTabs: jest.fn().mockResolvedValue(undefined),
  focusTab: jest.fn().mockResolvedValue(undefined),
  pinTabs: jest.fn().mockResolvedValue(undefined),
  bookmarkTabs: jest.fn().mockResolvedValue({ success: true }),
  extractText: jest.fn().mockResolvedValue(''),
};
global.self.TabCard = class TabCard {
  constructor({ tabId, url, title, summary = '', embedding = [], keywords = [] }) {
    this.tabId = tabId;
    this.url = url;
    this.title = title;
    this.summary = summary;
    this.embedding = embedding;
    this.keywords = keywords;
    try {
      this.domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      this.domain = '';
    }
  }
};
global.self.ChatService = {
  execute: jest.fn().mockResolvedValue({ tool: 'group_tabs', arguments: { tabIds: [1] }, message: 'done' }),
};
global.self.executeTool = jest.fn().mockResolvedValue({ success: true });
global.self.EmbeddingService = {
  getEmbedding: jest.fn().mockResolvedValue([0.5, 0.5, 0]),
};

// Load retrieval modules
require('../src/services/retrieval/QueryParser');
require('../src/services/retrieval/DomainRetriever');
require('../src/services/retrieval/TitleRetriever');
require('../src/services/retrieval/KeywordRetriever');
require('../src/services/retrieval/EmbeddingRetriever');
require('../src/services/retrieval/CandidateAggregator');
require('../src/services/retrieval/RankingEngine');
require('../src/services/retrieval/RetrievalService');

// Load background.js
require('../src/background/background');

// Re-override EmbeddingService after background.js loaded (it defines its own)
self.EmbeddingService = {
  getEmbedding: jest.fn().mockResolvedValue([0.5, 0.5, 0]),
};

const { TabDB } = self;
const { QueryParser } = self;
const { DomainRetriever } = self;
const { TitleRetriever } = self;
const { RetrievalService } = self;

describe('Background RAG flow', () => {
  beforeEach(() => {
    jest.spyOn(TabDB, 'storeTabCard').mockResolvedValue(undefined);
    jest.spyOn(TabDB, 'deleteTabCard').mockResolvedValue(undefined);
    jest.spyOn(TabDB, 'init').mockResolvedValue(undefined);
    jest.spyOn(TabDB, 'getAllTabCards').mockResolvedValue([]);
    jest.spyOn(TabDB, 'search').mockResolvedValue([]);
    self.TabService.getAllTabs.mockReset().mockResolvedValue([]);
    self.ChatService.execute.mockReset().mockResolvedValue({ tool: 'group_tabs', arguments: { groupName: 'Test' }, message: 'done' });
    if (self.EmbeddingService && self.EmbeddingService.getEmbedding && self.EmbeddingService.getEmbedding.mockReset) {
      self.EmbeddingService.getEmbedding.mockReset().mockResolvedValue([0.5, 0.5, 0]);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onInstalled — startup indexing', () => {
    test('registers onInstalled listener', () => {
      expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalled();
    });

    test('indexes all tabs into TabDB on install', async () => {
      const mockTabs = [
        { id: 1, title: 'React', url: 'https://react.dev' },
        { id: 2, title: 'Vue', url: 'https://vuejs.org' },
      ];
      self.TabService.getAllTabs.mockResolvedValue(mockTabs);

      const handler = chrome.runtime.onInstalled.addListener.mock.calls[0][0];
      await handler({ reason: 'install' });

      expect(TabDB.init).toHaveBeenCalled();
      expect(TabDB.storeTabCard).toHaveBeenCalledTimes(2);
    });
  });

  describe('tab event listeners', () => {
    test('registers tabs.onCreated listener', () => {
      expect(chrome.tabs.onCreated.addListener).toHaveBeenCalled();
    });

    test('registers tabs.onUpdated listener', () => {
      expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled();
    });

    test('registers tabs.onRemoved listener', () => {
      expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalled();
    });
  });

  describe('QueryParser', () => {
    test('parses domain query as deterministic', () => {
      const result = QueryParser.parse('group all linkedin tabs');
      expect(result.type).toBe('deterministic');
      expect(result.domain).toBe('linkedin.com');
      expect(result.action).toBe('group');
    });

    test('parses semantic query', () => {
      const result = QueryParser.parse('group tabs about machine learning');
      expect(result.type).toBe('semantic');
      expect(result.domain).toBeNull();
      expect(result.target).toContain('machine');
      expect(result.target).toContain('learning');
    });

    test('extracts close action', () => {
      const result = QueryParser.parse('close github tabs');
      expect(result.action).toBe('close');
      expect(result.domain).toBe('github.com');
    });

    test('extracts focus action', () => {
      const result = QueryParser.parse('focus gmail');
      expect(result.action).toBe('focus');
      expect(result.domain).toBe('gmail.com');
    });
  });

  describe('DomainRetriever', () => {
    test('returns tabs matching domain', async () => {
      const tabs = [
        { tabId: 1, title: 'LinkedIn Feed', url: 'https://www.linkedin.com/feed/', domain: 'linkedin.com' },
        { tabId: 2, title: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/', domain: 'linkedin.com' },
        { tabId: 3, title: 'GitHub', url: 'https://github.com/', domain: 'github.com' },
      ];
      const results = await DomainRetriever.retrieve(tabs, 'linkedin.com');
      expect(results).toHaveLength(2);
      expect(results.map(r => r.tabId)).toEqual([1, 2]);
      expect(results[0].domainScore).toBe(100);
    });

    test('returns empty for no matches', async () => {
      const tabs = [
        { tabId: 1, title: 'GitHub', url: 'https://github.com/', domain: 'github.com' },
      ];
      const results = await DomainRetriever.retrieve(tabs, 'linkedin.com');
      expect(results).toHaveLength(0);
    });
  });

  describe('TitleRetriever', () => {
    test('finds title matches', () => {
      const tabs = [
        { tabId: 1, title: 'React Hooks Tutorial', url: 'https://react.dev' },
        { tabId: 2, title: 'Vue.js Guide', url: 'https://vuejs.org' },
      ];
      const results = TitleRetriever.retrieve(tabs, 'react hooks');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tabId).toBe(1);
      expect(results[0].titleScore).toBeGreaterThan(0);
    });

    test('returns empty for no matches', () => {
      const tabs = [
        { tabId: 1, title: 'Vue.js Guide', url: 'https://vuejs.org' },
      ];
      const results = TitleRetriever.retrieve(tabs, 'react hooks');
      expect(results).toHaveLength(0);
    });
  });

  describe('AI_COMMAND — hybrid retrieval', () => {
    test('uses domain retrieval for known domains', async () => {
      const linkedinTabs = [
        { tabId: 1, title: 'LinkedIn Feed', url: 'https://www.linkedin.com/feed/', domain: 'linkedin.com', keywords: ['linkedin', 'feed'] },
        { tabId: 2, title: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/', domain: 'linkedin.com', keywords: ['linkedin', 'jobs'] },
        { tabId: 3, title: 'GitHub', url: 'https://github.com/', domain: 'github.com', keywords: ['github'] },
      ];
      TabDB.getAllTabCards.mockImplementationOnce(() => Promise.resolve(linkedinTabs));
      self.TabService.getAllTabs.mockResolvedValue([
        { id: 1, title: 'LinkedIn Feed', url: 'https://www.linkedin.com/feed/' },
        { id: 2, title: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/' },
        { id: 3, title: 'GitHub', url: 'https://github.com/' },
      ]);
      self.ChatService.execute.mockResolvedValue({
        tool: 'group_tabs', arguments: { groupName: 'LinkedIn', color: 'blue' }, message: 'done',
      });

      const msgHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const sendResponse = jest.fn();
      msgHandler(
        { type: 'AI_COMMAND', command: 'group all linkedin tabs' },
        { tab: { windowId: 1 }, id: 'test-extension-id' },
        sendResponse
      );
      await new Promise(r => setTimeout(r, 100));

      expect(self.executeTool).toHaveBeenCalledWith(
        'group_tabs',
        expect.objectContaining({ tabIds: [1, 2], groupName: 'Linkedin' })
      );
      expect(self.ChatService.execute).not.toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    test('uses hybrid retrieval for semantic queries', async () => {
      const tabs = [
        { tabId: 1, title: 'React Hooks Tutorial', url: 'https://react.dev/hooks', domain: 'react.dev', keywords: ['react', 'hooks', 'tutorial'] },
        { tabId: 2, title: 'Vue.js Guide', url: 'https://vuejs.org', domain: 'vuejs.org', keywords: ['vue', 'guide'] },
        { tabId: 3, title: 'React Documentation', url: 'https://react.dev/docs', domain: 'react.dev', keywords: ['react', 'documentation'] },
      ];
      TabDB.getAllTabCards.mockImplementationOnce(() => Promise.resolve(tabs));
      self.TabService.getAllTabs.mockResolvedValue([
        { id: 1, title: 'React Hooks Tutorial', url: 'https://react.dev/hooks' },
        { id: 2, title: 'Vue.js Guide', url: 'https://vuejs.org' },
        { id: 3, title: 'React Documentation', url: 'https://react.dev/docs' },
      ]);
      self.ChatService.execute.mockResolvedValue({
        tool: 'group_tabs', arguments: { groupName: 'React', color: 'blue' }, message: 'done',
      });

      const msgHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const sendResponse = jest.fn();
      msgHandler(
        { type: 'AI_COMMAND', command: 'group react tabs' },
        { tab: { windowId: 1 }, id: 'test-extension-id' },
        sendResponse
      );
      await new Promise(r => setTimeout(r, 100));

      expect(self.ChatService.execute).toHaveBeenCalled();
      const tabsSent = self.ChatService.execute.mock.calls[0][1];
      expect(tabsSent.length).toBeGreaterThan(0);
      // React tabs should score higher than Vue
      expect(tabsSent[0].id).toBe(1);
    });

    test('returns no matching tabs error when empty', async () => {
      TabDB.getAllTabCards.mockImplementationOnce(() => Promise.resolve([]));
      self.TabService.getAllTabs.mockResolvedValue([]);

      const msgHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const sendResponse = jest.fn();
      msgHandler(
        { type: 'AI_COMMAND', command: 'group all linkedin tabs' },
        { tab: { windowId: 1 }, id: 'test-extension-id' },
        sendResponse
      );
      await new Promise(r => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ success: false, message: 'No matching tabs found' });
    });

    test('filters stale tab IDs not in current Chrome tabs', async () => {
      const allTabs = [
        { tabId: 1, title: 'React', url: 'https://react.dev', domain: 'react.dev', keywords: ['react'] },
        { tabId: 999, title: 'Old React Tab', url: 'https://react.dev/old', domain: 'react.dev', keywords: ['react'] },
      ];
      TabDB.getAllTabCards.mockImplementationOnce(() => Promise.resolve(allTabs));
      self.TabService.getAllTabs.mockResolvedValue([
        { id: 1, title: 'React', url: 'https://react.dev' },
      ]);
      self.ChatService.execute.mockResolvedValue({
        tool: 'group_tabs',
        arguments: { groupName: 'React' },
        message: 'done',
      });

      const msgHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const sendResponse = jest.fn();
      msgHandler(
        { type: 'AI_COMMAND', command: 'group react tabs' },
        { tab: { windowId: 1 }, id: 'test-extension-id' },
        sendResponse
      );
      await new Promise(r => setTimeout(r, 100));

      const tabsSentToChat = self.ChatService.execute.mock.calls[0][1];
      expect(tabsSentToChat.map(t => t.id)).not.toContain(999);
    });

    test('returns score breakdown in candidates', async () => {
      const tabs = [
        { tabId: 1, title: 'GitHub React', url: 'https://github.com/react', domain: 'github.com', keywords: ['github', 'react'] },
      ];

      const result = await RetrievalService.retrieve('group github tabs', tabs, null);

      expect(result.candidates[0].score).toBe(100);
      expect(result.candidates[0].scoreBreakdown.domain).toBe(100);
      expect(result.candidates[0].scoreBreakdown.title).toBe(0);
    });
  });
});
