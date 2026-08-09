/**
 * Phase 1: ChatService tests
 * 
 * ChatService is a thin HTTP wrapper.
 * It sends prompt + tabs to Django, returns parsed JSON.
 * Zero AI logic.
 */

// Mock fetch globally
global.fetch = jest.fn();

// Mock chrome.storage for getApiKey
global.chrome = {
  storage: {
    local: {
      get: jest.fn((keys, cb) => cb({ apiKey: 'test-key-123' })),
    },
  },
};

global.self = global;
require('../src/services/ChatService');
const ChatService = global.self.ChatService;

describe('ChatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    test('POSTs prompt and tabs to /api/chat', async () => {
      const mockResponse = {
        success: true,
        tool: 'group_tabs',
        arguments: { tabIds: [1, 2], groupName: 'GitHub', color: 'blue' },
        message: 'Grouped 2 tabs',
      };
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const tabs = [
        { id: 1, title: 'GitHub', url: 'https://github.com' },
        { id: 2, title: 'GitHub Issues', url: 'https://github.com/issues' },
      ];

      const result = await ChatService.execute('group all github tabs', tabs);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:8000/api/chat');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.prompt).toBe('group all github tabs');
      expect(body.tabs).toEqual(tabs);

      expect(result).toEqual(mockResponse);
    });

    test('returns error object on HTTP failure', async () => {
      fetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      const result = await ChatService.execute('close all tabs', []);

      expect(result.error).toBeDefined();
    });

    test('returns error object on network failure', async () => {
      fetch.mockRejectedValue(new Error('Network error'));

      const result = await ChatService.execute('close all tabs', []);

      expect(result.error).toBeDefined();
    });

    test('includes API key in request headers', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, tool: 'focus_tab', arguments: { tabId: 1 }, message: 'ok' }),
      });

      await ChatService.execute('focus first tab', []);

      const [, options] = fetch.mock.calls[0];
      expect(options.headers['x-goog-api-key']).toBe('test-key-123');
    });
  });
});
