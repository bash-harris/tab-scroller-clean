const path = require('path');
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

const WIKI_SETS = {
  cats: [
    'https://en.wikipedia.org/wiki/Cat',
    'https://en.wikipedia.org/wiki/Domestic_short-haired_cat',
    'https://en.wikipedia.org/wiki/Felidae',
  ],
  dogs: [
    'https://en.wikipedia.org/wiki/Dog',
    'https://en.wikipedia.org/wiki/Canidae',
    'https://en.wikipedia.org/wiki/Wolf',
    'https://en.wikipedia.org/wiki/Puppy',
  ],
  birds: [
    'https://en.wikipedia.org/wiki/Bird',
    'https://en.wikipedia.org/wiki/Parrot',
  ],
  programming: [
    'https://en.wikipedia.org/wiki/Programming_language',
    'https://en.wikipedia.org/wiki/Python_(programming_language)',
    'https://en.wikipedia.org/wiki/JavaScript',
    'https://en.wikipedia.org/wiki/TypeScript',
    'https://en.wikipedia.org/wiki/Compiler',
  ],
  music: [
    'https://en.wikipedia.org/wiki/Music',
    'https://en.wikipedia.org/wiki/Jazz',
    'https://en.wikipedia.org/wiki/Rock_music',
    'https://en.wikipedia.org/wiki/Classical_music',
  ],
  space: [
    'https://en.wikipedia.org/wiki/Space_exploration',
    'https://en.wikipedia.org/wiki/NASA',
    'https://en.wikipedia.org/wiki/International_Space_Station',
  ],
  astronomy: [
    'https://en.wikipedia.org/wiki/Astronomy',
    'https://en.wikipedia.org/wiki/Star',
    'https://en.wikipedia.org/wiki/Galaxy',
  ],
  geography: [
    'https://en.wikipedia.org/wiki/Geography',
    'https://en.wikipedia.org/wiki/Earth',
    'https://en.wikipedia.org/wiki/Mountain',
    'https://en.wikipedia.org/wiki/River',
    'https://en.wikipedia.org/wiki/Ocean',
  ],
  television: [
    'https://en.wikipedia.org/wiki/Television',
    'https://en.wikipedia.org/wiki/Broadcasting',
  ],
  tv_geography: [
    'https://en.wikipedia.org/wiki/Planet_Earth_(2006_TV_series)',
    'https://en.wikipedia.org/wiki/National_Geographic_Explorer',
  ],
  tv_astronomy: [
    'https://en.wikipedia.org/wiki/Cosmos:_A_Personal_Voyage',
    'https://en.wikipedia.org/wiki/The_Universe_(TV_series)',
    'https://en.wikipedia.org/wiki/How_the_Universe_Works',
  ],
};

const ALL_WIKI_URLS = Object.values(WIKI_SETS).flat();

const DOMAIN_SETS = {
  coding: [
    'https://leetcode.com/problems/two-sum/',
    'https://leetcode.com/problems/valid-parentheses/',
    'https://codeforces.com/problemset/problem/4/A',
    'https://codeforces.com/problemset/problem/71/A',
  ],
  docs: [
    'https://docs.python.org/3/tutorial/',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    'https://react.dev/learn',
  ],
  social: [
    'https://www.reddit.com/r/programming/',
    'https://www.reddit.com/r/javascript/',
    'https://news.ycombinator.com/',
  ],
  news: [
    'https://www.bbc.com/news',
    'https://www.reuters.com/',
  ],
};

const ALL_WIKI_URLS_SET = new Set(ALL_WIKI_URLS);

module.exports = {
  EXTENSION_PATH,
  WIKI_SETS,
  ALL_WIKI_URLS,
  DOMAIN_SETS,
  ALL_WIKI_URLS_SET,
};
