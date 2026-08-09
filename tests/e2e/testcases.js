const { WIKI_SETS } = require('./fixtures');

const testCases = [
  // =====================================================================
  // TIER 1: Simple — 3-5 tabs, single-intent, unambiguous commands
  // =====================================================================
  {
    id: 'TC01',
    tier: 1,
    description: 'Group tabs about cats (3 tabs)',
    setup: { tabSet: 'cats' },
    command: 'group tabs about cats',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'TC02',
    tier: 1,
    description: 'Close all cat-related tabs',
    setup: { tabSet: 'cats' },
    command: 'close tabs about cats',
    expected: { intent: 'close_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: true },
  },
  {
    id: 'TC03',
    tier: 1,
    description: 'Recall tabs — find cat pages from indexed content',
    setup: { tabSet: 'cats', waitForIndexing: true },
    command: 'recall tabs about feline animals',
    expected: { intent: 'recall_tabs', success: true },
    options: { useFullPipeline: false, isDestructive: false },
  },
  {
    id: 'TC04',
    tier: 1,
    description: 'Pin all tabs about dogs',
    setup: { tabSet: 'dogs' },
    command: 'pin dog tabs',
    expected: { intent: 'pin_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'TC05',
    tier: 1,
    description: 'Reload all bird tabs',
    setup: { tabSet: 'birds' },
    command: 'reload bird tabs',
    expected: { intent: 'reload_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },

  // =====================================================================
  // TIER 2: Medium — 5-8 tabs, domain-based grouping, mixed intents
  // =====================================================================
  {
    id: 'TC06',
    tier: 2,
    description: 'Group all tabs related to dogs (4 tabs)',
    setup: { tabSet: 'dogs' },
    command: 'group all tabs about dogs',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'TC07',
    tier: 2,
    description: 'Group music tabs (4 tabs) — semantic categorization',
    setup: { tabSet: 'music' },
    command: 'group music tabs',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'TC08',
    tier: 2,
    description: 'Close all programming tabs (5 tabs)',
    setup: { tabSet: 'programming' },
    command: 'close programming tabs',
    expected: { intent: 'close_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: true },
  },
  {
    id: 'TC09',
    tier: 2,
    description: 'Bookmark all space-related tabs',
    setup: { tabSet: 'space' },
    command: 'bookmark space tabs',
    expected: { intent: 'bookmark_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'TC10',
    tier: 2,
    description: 'Recall tabs — find programming language pages via content',
    setup: { tabSet: 'programming', waitForIndexing: true },
    command: 'recall tabs about programming languages',
    expected: { intent: 'recall_tabs', success: true },
    options: { useFullPipeline: false, isDestructive: false },
  },
  {
    id: 'TC11',
    tier: 2,
    description: 'Mute all dog tabs',
    setup: { tabSet: 'dogs' },
    command: 'mute dog tabs',
    expected: { intent: 'mute_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },

  // =====================================================================
  // TIER 3: Complex — multi-intent prompts, mixed domains, edge cases
  // =====================================================================
  {
    id: 'TC12',
    tier: 3,
    description: 'Multi-action — close dogs and group birds (two intents)',
    setup: { tabSet: ['dogs', 'birds'], multiSet: true },
    command: 'close the dog tabs and group the bird tabs',
    expected: { intent: ['close_tabs', 'group_tabs'], success: true },
    options: { useFullPipeline: true, isDestructive: true, sequentialIntents: true },
  },
  {
    id: 'TC13',
    tier: 3,
    description: 'Multi-turn — group cats, then widen to group all animals',
    setup: { tabSet: ['cats', 'dogs'], multiSet: true },
    command: 'group cats tabs',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'TC14',
    tier: 3,
    description: 'Safety — pinned tabs should NOT be closed',
    setup: { tabSet: 'cats', pinSome: [0] },
    command: 'close all tabs about cats',
    expected: { intent: 'close_tabs', success: true, pinnedProtected: true },
    options: { useFullPipeline: true, isDestructive: true },
  },
  {
    id: 'TC15',
    tier: 3,
    description: 'Safety — audible tabs should NOT be closed',
    setup: { tabSet: 'dogs' },
    command: 'close all dog tabs',
    expected: { intent: 'close_tabs', success: true, audibleProtected: true },
    options: { useFullPipeline: true, isDestructive: true },
  },
  {
    id: 'TC16',
    tier: 3,
    description: 'Snooze tabs about music',
    setup: { tabSet: 'music' },
    command: 'snooze music tabs',
    expected: { intent: 'snooze_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: true },
  },
  {
    id: 'TC17',
    tier: 3,
    description: 'Narrow recall_tabs then open selected',
    setup: { tabSet: 'programming', waitForIndexing: true },
    command: 'recall tabs about coding',
    expected: { intent: 'recall_tabs', success: true },
    options: { useFullPipeline: false, isDestructive: false },
  },

  // =====================================================================
  // TIER 4: Stress — 20-70 tabs, large prompts, repeated domains
  // =====================================================================
  {
    id: 'TC18',
    tier: 4,
    description: 'Stress — group tabs from 20+ tab set',
    setup: { tabSet: 'stress-medium', tabCount: 20 },
    command: 'group all tabs related to music or space',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false, timeouts: { llm: 180000 } },
  },
  {
    id: 'TC19',
    tier: 4,
    description: 'Stress — close a subset from 20+ tab set',
    setup: { tabSet: 'stress-medium', tabCount: 20 },
    command: 'close tabs about cats',
    expected: { intent: 'close_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: true, timeouts: { llm: 180000 } },
  },
  {
    id: 'TC20',
    tier: 4,
    description: 'Stress — recall from large indexed set',
    setup: { tabSet: 'stress-large', tabCount: 40 },
    command: 'recall tabs about animals',
    expected: { intent: 'recall_tabs', success: true },
    options: { useFullPipeline: false, isDestructive: false, timeouts: { llm: 180000 } },
  },

  // =====================================================================
  // LEGACY COMPATIBILITY — ported from run-ai-test.js
  // =====================================================================
  {
    id: 'LC01',
    tier: 1,
    description: '[legacy] Group geography tabs (5 geography + 2 TV cross-domain)',
    setup: { tabSet: 'legacy-tv-geo', legacySet: true },
    command: 'group all tabs related to geography and places',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'LC02',
    tier: 2,
    description: '[legacy] Group astronomy but exclude TV shows',
    setup: { tabSet: 'legacy-tv-astro', legacySet: true },
    command: 'group all tabs related to astronomy but not related to television shows',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
  {
    id: 'LC03',
    tier: 2,
    description: '[legacy] Group all television and broadcasting tabs',
    setup: { tabSet: 'legacy-tv-broadcast', legacySet: true },
    command: 'group all television and broadcasting tabs',
    expected: { intent: 'group_tabs', success: true },
    options: { useFullPipeline: true, isDestructive: false },
  },
];

module.exports = testCases;
