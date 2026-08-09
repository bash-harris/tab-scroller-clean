/**
 * Phase 1: TabService tests
 * 
 * TabService is the ONLY module allowed to call Chrome APIs.
 * These tests mock chrome.* to verify TabService delegates correctly.
 */

// Set up global.self for IIFE pattern used by TabService
global.self = global;

// Mock chrome APIs before importing TabService
global.chrome = {
  tabs: {
    query: jest.fn(),
    get: jest.fn(),
    group: jest.fn(),
    ungroup: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
  },
  windows: {
    get: jest.fn(),
  },
  tabGroups: {
    update: jest.fn(),
  },
  bookmarks: {
    getTree: jest.fn(),
    create: jest.fn(),
  },
};

// Load TabService (IIFE that assigns to self.TabService)
require('../src/services/TabService');

const TabService = global.self.TabService;

describe('TabService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAllTabs', () => {
    test('calls chrome.tabs.query with windowId', async () => {
      const mockTabs = [{ id: 1, title: 'Tab 1' }, { id: 2, title: 'Tab 2' }];
      chrome.tabs.query.mockResolvedValue(mockTabs);

      const result = await TabService.getAllTabs(42);

      expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 42 });
      expect(result).toEqual(mockTabs);
    });
  });

  describe('groupTabs', () => {
    test('calls chrome.tabs.group then chrome.tabGroups.update', async () => {
      chrome.tabs.get.mockResolvedValue({ id: 1, windowId: 1 });
      chrome.windows.get.mockResolvedValue({ id: 1, type: 'normal' });
      chrome.tabs.group.mockResolvedValue(100);

      const result = await TabService.groupTabs([1, 2, 3], 'GitHub', 'blue');

      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2, 3] });
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, { title: 'GitHub', color: 'blue' });
      expect(result.grouped).toBe(3);
      expect(result.groupId).toBe(100);
    });

    test('returns null for empty tabIds', async () => {
      const result = await TabService.groupTabs([], 'Group', 'blue');
      expect(result).toBeNull();
      expect(chrome.tabs.group).not.toHaveBeenCalled();
    });

    test('works without groupName and color', async () => {
      chrome.tabs.get.mockResolvedValue({ id: 1, windowId: 1 });
      chrome.windows.get.mockResolvedValue({ id: 1, type: 'normal' });
      chrome.tabs.group.mockResolvedValue(200);

      const result = await TabService.groupTabs([1, 2]);

      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
      expect(chrome.tabGroups.update).not.toHaveBeenCalled();
      expect(result.grouped).toBe(2);
    });

    test('ungroups already-grouped tabs before grouping', async () => {
      chrome.tabs.get
        .mockResolvedValueOnce({ id: 1, windowId: 1, groupId: 5 })
        .mockResolvedValueOnce({ id: 2, windowId: 1, groupId: 0 });
      chrome.tabs.group.mockResolvedValue(100);

      const result = await TabService.groupTabs([1, 2], 'Test', 'red');

      expect(chrome.tabs.ungroup).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith(1);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalledWith(2);
      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
      expect(result.grouped).toBe(2);
      expect(result.skipped).toBe(0);
    });
  });

  describe('closeTabs', () => {
    test('calls chrome.tabs.remove with tab IDs', async () => {
      await TabService.closeTabs([1, 2, 3]);
      expect(chrome.tabs.remove).toHaveBeenCalledWith([1, 2, 3]);
    });

    test('handles single tab ID (not array)', async () => {
      await TabService.closeTabs(5);
      expect(chrome.tabs.remove).toHaveBeenCalledWith([5]);
    });

    test('does nothing for empty array', async () => {
      await TabService.closeTabs([]);
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
    });
  });

  describe('focusTab', () => {
    test('calls chrome.tabs.update with active true', async () => {
      await TabService.focusTab(42);
      expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
    });
  });

  describe('pinTabs', () => {
    test('calls chrome.tabs.update with pinned flag', async () => {
      await TabService.pinTabs([1, 2], true);
      expect(chrome.tabs.update).toHaveBeenCalledTimes(2);
      expect(chrome.tabs.update).toHaveBeenCalledWith(1, { pinned: true });
      expect(chrome.tabs.update).toHaveBeenCalledWith(2, { pinned: true });
    });

    test('unpins tabs when pinned is false', async () => {
      await TabService.pinTabs([3], false);
      expect(chrome.tabs.update).toHaveBeenCalledWith(3, { pinned: false });
    });
  });

  describe('bookmarkTabs', () => {
    test('creates bookmarks in specified folder', async () => {
      const mockTree = [{
        id: '0',
        children: [{
          id: '1',
          title: 'Bookmarks bar',
          children: [{ id: 'folder1', title: 'My Folder', children: [] }]
        }]
      }];
      chrome.bookmarks.getTree.mockResolvedValue(mockTree);
      chrome.bookmarks.create.mockResolvedValue({ id: 'bm1' });

      const tabs = [{ id: 1, url: 'https://github.com', title: 'GitHub' }];
      const result = await TabService.bookmarkTabs(tabs, 'My Folder');

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(chrome.bookmarks.create).toHaveBeenCalledWith({
        parentId: 'folder1',
        title: 'GitHub',
        url: 'https://github.com'
      });
    });

    test('creates folder if it does not exist', async () => {
      const mockTree = [{
        id: '0',
        children: [{
          id: '1',
          title: 'Bookmarks bar',
          children: []
        }]
      }];
      chrome.bookmarks.getTree.mockResolvedValue(mockTree);
      chrome.bookmarks.create
        .mockResolvedValueOnce({ id: 'newFolder', title: 'New Folder' })
        .mockResolvedValueOnce({ id: 'bm1' });

      const tabs = [{ id: 1, url: 'https://github.com', title: 'GitHub' }];
      const result = await TabService.bookmarkTabs(tabs, 'New Folder');

      expect(result.success).toBe(true);
      expect(chrome.bookmarks.create).toHaveBeenCalledWith({
        parentId: '1',
        title: 'New Folder'
      });
    });
  });
});
