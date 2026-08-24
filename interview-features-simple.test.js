const assert = require("assert");
const {
  parseCommand,
  filterTabs,
  makePreview,
  execute,
  undo,
  UndoStack
} = require("./interview-features-simple");

const tabs = [
  { id: 1, title: "LeetCode Discuss: Two Sum", url: "https://leetcode.com/discuss/1" },
  { id: 2, title: "LeetCode Two Sum", url: "https://leetcode.com/problems/two-sum" },
  { id: 3, title: "GitHub source", url: "https://github.com/acme/app" }
];

const plan = parseCommand("group all leetcode tabs that are not from discuss section");
const result = filterTabs(tabs, plan);
assert.deepStrictEqual(result.matches.map((tab) => tab.id), [2]);
assert.strictEqual(result.metrics.scanned, 3);
assert.strictEqual(makePreview(plan, result).requiresConfirmation, true);

const stack = new UndoStack();
let applied = false;
let restored = false;
const adapter = {
  async capture(selected) { return { ids: selected.map((tab) => tab.id) }; },
  async apply() { applied = true; },
  async restore(snapshot) { restored = snapshot.ids.length === 1; }
};

(async () => {
  await execute(plan, result, adapter, stack);
  assert.strictEqual(applied, true);
  await undo(adapter, stack);
  assert.strictEqual(restored, true);
  console.log("interview-features-simple: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

