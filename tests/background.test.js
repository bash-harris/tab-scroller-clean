/**
 * Phase 1: background.js message router tests
 * 
 * Tests the AI_COMMAND flow:
 *   receive message → getAllTabs → ChatService.execute → executeTool → sendResponse
 */

global.self = global;

// Mock chrome APIs
global.chrome = {
  tabs: {
    query: jest.fn(),
    group: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
    get: jest.fn(),
  },
  tabGroups: {
    update: jest.fn(),
  },
  bookmarks: {
    getTree: jest.fn(),
    create: jest.fn(),
  },
  runtime: {
    onMessage: { addListener: jest.fn() },
    id: 'test-ext-id',
  },
  windows: { WINDOW_ID_CURRENT: -1 },
  storage: {
    local: {
      get: jest.fn((keys, cb) => cb({ apiKey: 'test-key' })),
    },
  },
};

// Mock fetch
global.fetch = jest.fn();

// Load services
require('../src/services/TabService');
require('../src/services/ChatService');
require('../src/background/executeTool');

const TabService = global.self.TabService;
const ChatService = global.self.ChatService;
const executeTool = global.self.executeTool;

// Simulate the background.js AI_COMMAND handler directly
async function handleAICommand(command, senderTab) {
  const windowId = senderTab?.windowId || -1;
  const tabs = await TabService.getAllTabs(windowId);

  const compactTabs = tabs.map(t => ({
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    active: t.active,
    pinned: t.pinned,
    groupId: t.groupId ?? -1,
  }));

  const chatResult = await ChatService.execute(command, compactTabs);

  if (chatResult.error) {
    return { success: false, message: chatResult.error };
  }

  if (!chatResult.tool || !chatResult.arguments) {
    return { success: false, message: 'Model returned invalid response' };
  }

  return await executeTool(chatResult.tool, chatResult.arguments);
}

describe('background.js AI_COMMAND flow', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(TabService, 'getAllTabs').mockResolvedValue([
      { id: 1, title: 'GitHub', url: 'https://github.com', active: false, pinned: false, groupId: -1 },
      { id: 2, title: 'GitHub Issues', url: 'https://github.com/issues', active: false, pinned: false, groupId: -1 },
      { id: 3, title: 'StackOverflow', url: 'https://stackoverflow.com', active: true, pinned: false, groupId: -1 },
    ]);
    jest.spyOn(TabService, 'groupTabs').mockResolvedValue({ groupId: 100, grouped: 2, skipped: 0 });
    jest.spyOn(TabService, 'closeTabs').mockResolvedValue();
    jest.spyOn(TabService, 'focusTab').mockResolvedValue();
    jest.spyOn(TabService, 'pinTabs').mockResolvedValue();
    jest.spyOn(TabService, 'bookmarkTabs').mockResolvedValue({ success: true, count: 1 });
  });

  test('sends prompt and tabs to ChatService', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        tool: 'group_tabs',
        arguments: { tabIds: [1, 2], groupName: 'GitHub', color: 'blue' },
        message: 'Grouped 2 tabs',
      }),
    });

    await handleAICommand('group all github tabs', { windowId: 1 });

    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toBe('group all github tabs');
    expect(body.tabs).toHaveLength(3);
    expect(body.tabs[0].id).toBe(1);
  });

  test('executes group_tabs and returns success', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        tool: 'group_tabs',
        arguments: { tabIds: [1, 2], groupName: 'GitHub', color: 'blue' },
        message: 'Grouped 2 tabs',
      }),
    });

    const result = await handleAICommand('group github', { windowId: 1 });

    expect(result.success).toBe(true);
    expect(TabService.groupTabs).toHaveBeenCalledWith([1, 2], 'GitHub', 'blue');
  });

  test('executes close_tabs and returns success', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        tool: 'close_tabs',
        arguments: { tabIds: [3] },
        message: 'Closed 1 tab',
      }),
    });

    const result = await handleAICommand('close stackoverflow', { windowId: 1 });

    expect(result.success).toBe(true);
    expect(TabService.closeTabs).toHaveBeenCalledWith([3]);
  });

  test('executes focus_tab and returns success', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        tool: 'focus_tab',
        arguments: { tabId: 2 },
        message: 'Switched to tab',
      }),
    });

    const result = await handleAICommand('switch to github issues', { windowId: 1 });

    expect(result.success).toBe(true);
    expect(TabService.focusTab).toHaveBeenCalledWith(2);
  });

  test('returns error when ChatService returns error', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'AI server is offline' }),
    });

    const result = await handleAICommand('group tabs', { windowId: 1 });

    expect(result.success).toBe(false);
    expect(result.message).toBe('AI server is offline');
  });

  test('returns error when network fails', async () => {
    fetch.mockRejectedValue(new Error('Failed to fetch'));

    const result = await handleAICommand('group tabs', { windowId: 1 });

    expect(result.success).toBe(false);
    expect(result.message).toContain('fetch');
  });

  test('returns error for invalid model response', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tool: 'invalid_tool', arguments: {} }),
    });

    const result = await handleAICommand('do something', { windowId: 1 });

    expect(result.success).toBe(false);
  });
});
