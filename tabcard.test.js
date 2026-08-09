/**
 * Phase 2, Cycle 1: TabCard model
 * 
 * TabCard is the canonical searchable representation of a browser tab.
 * It must include contentHash for change detection and lastIndexed for tracking.
 */

global.self = global;

require('../src/models/TabCard');

const { TabCard } = global.self;

describe('TabCard', () => {
  test('creates a card with required fields', () => {
    const card = new TabCard({
      tabId: 1,
      url: 'https://github.com/facebook/react',
      title: 'React — GitHub',
    });

    expect(card.tabId).toBe(1);
    expect(card.url).toBe('https://github.com/facebook/react');
    expect(card.title).toBe('React — GitHub');
    expect(card.summary).toBe('');
    expect(card.embedding).toEqual([]);
  });

  test('includes contentHash derived from title + url + summary', () => {
    const card = new TabCard({
      tabId: 1,
      url: 'https://github.com/facebook/react',
      title: 'React — GitHub',
      summary: 'A JavaScript library for building user interfaces',
    });

    expect(card.contentHash).toBeDefined();
    expect(typeof card.contentHash).toBe('string');
    expect(card.contentHash.length).toBeGreaterThan(0);
  });

  test('contentHash changes when title changes', () => {
    const card1 = new TabCard({
      tabId: 1,
      url: 'https://github.com/facebook/react',
      title: 'React — GitHub',
      summary: 'A JavaScript library',
    });

    const card2 = new TabCard({
      tabId: 1,
      url: 'https://github.com/facebook/react',
      title: 'React (NEW TITLE)',
      summary: 'A JavaScript library',
    });

    expect(card1.contentHash).not.toBe(card2.contentHash);
  });

  test('contentHash changes when summary changes', () => {
    const card1 = new TabCard({
      tabId: 1,
      url: 'https://example.com',
      title: 'Example',
      summary: 'Old summary',
    });

    const card2 = new TabCard({
      tabId: 1,
      url: 'https://example.com',
      title: 'Example',
      summary: 'New summary',
    });

    expect(card1.contentHash).not.toBe(card2.contentHash);
  });

  test('contentHash is stable for same inputs', () => {
    const props = {
      tabId: 1,
      url: 'https://example.com',
      title: 'Example',
      summary: 'Same summary',
    };

    const card1 = new TabCard(props);
    const card2 = new TabCard(props);

    expect(card1.contentHash).toBe(card2.contentHash);
  });

  test('includes lastIndexed timestamp', () => {
    const before = Date.now();
    const card = new TabCard({
      tabId: 1,
      url: 'https://example.com',
      title: 'Example',
    });
    const after = Date.now();

    expect(card.lastIndexed).toBeGreaterThanOrEqual(before);
    expect(card.lastIndexed).toBeLessThanOrEqual(after);
  });

  test('extracts domain from url', () => {
    const card = new TabCard({
      tabId: 1,
      url: 'https://www.github.com/react',
      title: 'React',
    });

    expect(card.domain).toBe('github.com');
  });

  test('handles invalid url gracefully', () => {
    const card = new TabCard({
      tabId: 1,
      url: 'not-a-url',
      title: 'Bad URL',
    });

    expect(card.domain).toBe('');
  });
});
