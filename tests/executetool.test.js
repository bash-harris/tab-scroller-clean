/**
 * Phase 1: executeTool tests
 * 
 * executeTool is a pure dispatch function.
 * It takes a tool name + arguments, calls the right TabService method.
 * Returns { success, message }.
 */

global.self = global;

// Mock chrome APIs
global.chrome = {
  tabs: {
    query: jest.fn().mockResolvedValue([]),
    group: jest.fn().mockResolvedValue(100),
    remove: jest.fn(),
    update: jest.fn(),
  },
  tabGroups: {
    update: jest.fn(),
  },
  bookmarks: {
    getTree: jest.fn().mockResolvedValue([{
      id: '0',
      children: [{ id: '1', title: 'Bookmarks bar', children: [] }]
    }]),
    create: jest.fn().mockResolvedValue({ id: 'bm1' }),
  },
};

// Load TabService
require('../src/services/TabService');

// Load executeTool
require('../src/background/executeTool');

const executeTool = global.self.executeTool;
const TabService = global.self.TabService;

describe('executeTool', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(TabService, 'groupTabs').mockResolvedValue({ groupId: 100, grouped: 3, skipped: 0 });
    jest.spyOn(TabService, 'closeTabs').mockResolvedValue();
    jest.spyOn(TabService, 'focusTab').mockResolvedValue();
    jest.spyOn(TabService, 'bookmarkTabs').mockResolvedValue({ success: true, count: 1 });
    jest.spyOn(TabService, 'pinTabs').mockResolvedValue();
  });

  describe('group_tabs', () => {
    test('calls TabService.groupTabs with tabIds, groupName, color', async () => {
      const result = await executeTool('group_tabs', {
        tabIds: [1, 2, 3],
        groupName: 'GitHub',
        color: 'blue',
      });

      expect(TabService.groupTabs).toHaveBeenCalledWith([1, 2, 3], 'GitHub', 'blue');
      expect(result.success).toBe(true);
      expect(result.message).toContain('3');
    });

    test('returns error for empty tabIds', async () => {
      const result = await executeTool('group_tabs', { tabIds: [] });
      expect(result.success).toBe(false);
    });
  });

  describe('close_tabs', () => {
    test('calls TabService.closeTabs with tabIds', async () => {
      const result = await executeTool('close_tabs', { tabIds: [1, 2] });

      expect(TabService.closeTabs).toHaveBeenCalledWith([1, 2]);
      expect(result.success).toBe(true);
      expect(result.message).toContain('2');
    });
  });

  describe('focus_tab', () => {
    test('calls TabService.focusTab with tabId', async () => {
      const result = await executeTool('focus_tab', { tabId: 42 });

      expect(TabService.focusTab).toHaveBeenCalledWith(42);
      expect(result.success).toBe(true);
    });
  });

  describe('bookmark_tabs', () => {
    test('calls TabService.bookmarkTabs with tabs and folderName', async () => {
      const tabs = [{ id: 1, url: 'https://github.com', title: 'GitHub' }];
      const result = await executeTool('bookmark_tabs', {
        tabIds: [1],
        folderName: 'My Bookmarks',
        _tabs: tabs,
      });

      expect(TabService.bookmarkTabs).toHaveBeenCalledWith(tabs, 'My Bookmarks');
      expect(result.success).toBe(true);
    });
  });

  describe('pin_tabs', () => {
    test('calls TabService.pinTabs with tabIds and pinned', async () => {
      const result = await executeTool('pin_tabs', { tabIds: [1, 2], pinned: true });

      expect(TabService.pinTabs).toHaveBeenCalledWith([1, 2], true);
      expect(result.success).toBe(true);
    });
  });

  describe('unknown tool', () => {
    test('returns error for unsupported tool', async () => {
      const result = await executeTool('unknown_tool', {});
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported');
    });
  });
});
