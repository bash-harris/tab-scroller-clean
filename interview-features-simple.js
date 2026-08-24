/*
 * Interview-friendly tab command pipeline.
 *
 * Flow:
 *   text -> parseCommand -> filterTabs -> preview -> execute -> undo
 *
 * This module is deliberately independent from Chrome. Pass a small adapter
 * around it in the extension, or use it with plain arrays in a demo/test.
 */

const DOMAIN_ALIASES = {
  github: "github.com",
  leetcode: "leetcode.com",
  programming: null
};

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function addFilter(filters, field, op, value) {
  const normalized = normalize(value);
  if (normalized) filters.push({ field, op, value: normalized });
}

function parseCommand(input) {
  const text = normalize(input);
  if (!text) throw new Error("Command is empty");

  const intent = /^(group|organize|move)\\b/.test(text)
    ? "group_tabs"
    : /^(close|remove)\\b/.test(text)
      ? "close_tabs"
      : /^(pin)\\b/.test(text)
        ? "pin_tabs"
        : null;

  if (!intent) throw new Error("Supported commands: group, close, or pin tabs");

  const filters = [];

  // Explicit field filters are easiest to demo and deterministic to execute.
  const explicitPatterns = [
    [/url\\s+(?:that\\s+)?contains\\s+["']?([^"']+?)["']?(?:\\s+and|\\s+or|$)/, "url", "contains"],
    [/url\\s+(?:that\\s+)?does\\s+not\\s+contain\\s+["']?([^"']+?)["']?(?:\\s+and|\\s+or|$)/, "url", "not_contains"],
    [/title\\s+(?:that\\s+)?contains\\s+["']?([^"']+?)["']?(?:\\s+and|\\s+or|$)/, "title", "contains"],
    [/title\\s+(?:that\\s+)?does\\s+not\\s+contain\\s+["']?([^"']+?)["']?(?:\\s+and|\\s+or|$)/, "title", "not_contains"]
  ];
  for (const [pattern, field, op] of explicitPatterns) {
    const match = text.match(pattern);
    if (match) addFilter(filters, field, op, match[1]);
  }

  const alias = Object.keys(DOMAIN_ALIASES).find((name) =>
    new RegExp(`\\b${name}\\b`).test(text)
  );
  if (alias && DOMAIN_ALIASES[alias]) {
    addFilter(filters, "domain", "contains", DOMAIN_ALIASES[alias]);
  }

  // "not from discuss section" becomes safe URL/title exclusions.
  const excludedPhrase = text.match(/(?:not\\s+(?:from|in)|except)\\s+([a-z0-9_-]+(?:\\s+[a-z0-9_-]+)?)/);
  if (excludedPhrase) {
    const value = excludedPhrase[1].trim();
    addFilter(filters, "url", "not_contains", value);
    addFilter(filters, "title", "not_contains", value);
  }

  if (!filters.length) {
    throw new Error("No filter understood. Try: group github tabs, or group tabs where URL contains docs");
  }

  const groupName = alias && alias !== "programming"
    ? alias[0].toUpperCase() + alias.slice(1)
    : "Selected tabs";

  return {
    intent,
    filters,
    actionParams: { groupName },
    originalText: input
  };
}

function fieldValue(tab, field) {
  if (field === "domain") {
    try { return new URL(tab.url).hostname.toLowerCase(); } catch { return ""; }
  }
  if (field === "body") return normalize(tab.body || tab.card?.body);
  return normalize(tab[field]);
}

function matchesFilter(tab, filter) {
  const actual = fieldValue(tab, filter.field);
  // Missing body is unknown. Do not guess either side of a body predicate.
  if (filter.field === "body" && !actual) return false;
  const expected = normalize(filter.value);
  const contains = actual.includes(expected);
  if (filter.op === "contains") return contains;
  if (filter.op === "not_contains") return !contains;
  if (filter.op === "equals") return actual === expected;
  if (filter.op === "not_equals") return actual !== expected;
  throw new Error(`Unsupported filter operator: ${filter.op}`);
}

function filterTabs(tabs, plan) {
  const started = Date.now();
  const source = Array.isArray(tabs) ? tabs : [];
  const matches = source.filter((tab) => plan.filters.every((filter) => matchesFilter(tab, filter)));
  return {
    matches,
    metrics: {
      scanned: source.length,
      exactMatches: matches.length,
      removed: source.length - matches.length,
      latencyMs: Date.now() - started
    }
  };
}

function makePreview(plan, result) {
  return {
    title: `${plan.intent.replace("_", " ")} preview`,
    message: `${result.matches.length} of ${result.metrics.scanned} tabs selected`,
    filters: plan.filters,
    tabs: result.matches.map(({ id, title, url }) => ({ id, title, url })),
    metrics: result.metrics,
    requiresConfirmation: true
  };
}

class UndoStack {
  constructor(limit = 10) {
    this.limit = limit;
    this.items = [];
  }

  push(snapshot) {
    this.items.push(snapshot);
    if (this.items.length > this.limit) this.items.shift();
  }

  pop() {
    return this.items.pop() || null;
  }
}

async function execute(plan, result, adapter, undoStack) {
  if (!adapter || typeof adapter.capture !== "function" || typeof adapter.apply !== "function") {
    throw new Error("Adapter must implement capture() and apply(plan, tabs)");
  }
  if (!result.matches.length) return { changed: false, reason: "No tabs matched" };

  const snapshot = await adapter.capture(result.matches);
  undoStack.push(snapshot);
  await adapter.apply(plan, result.matches);
  return { changed: true, count: result.matches.length };
}

async function undo(adapter, undoStack) {
  const snapshot = undoStack.pop();
  if (!snapshot) return { restored: false, reason: "Nothing to undo" };
  if (!adapter || typeof adapter.restore !== "function") {
    throw new Error("Adapter must implement restore(snapshot)");
  }
  await adapter.restore(snapshot);
  return { restored: true };
}

const api = { parseCommand, filterTabs, makePreview, execute, undo, UndoStack };
if (typeof module !== "undefined") module.exports = api;
if (typeof globalThis !== "undefined") globalThis.InterviewTabFeatures = api;

