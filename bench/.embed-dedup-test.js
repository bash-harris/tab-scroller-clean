// Proves whether a concurrent burst of Embed.init() triggers ONE model load or N.
// Control: NliSelect.load(), which has both an already-loaded and an in-flight guard.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function makeCtx(label) {
  let pipelineCalls = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, JSON, Date,
    Float32Array, Array, Object, String, Number, Boolean, Error, TypeError, Map, Set,
    // A model load that takes 300ms, like a real fetch + session init.
    transformers: {
      env: { backends: { onnx: { wasm: {} } }, allowLocalModels: true },
      async pipeline(task, model) {
        pipelineCalls++;
        await new Promise(r => setTimeout(r, 300));
        const fn = async () => ({ data: new Float32Array(384) });
        fn.task = task; fn.model = model;
        return fn;
      },
    },
    // Make configureOrt take the extension branch so behaviour matches the worker.
    chrome: { runtime: { getURL: (p) => `chrome-extension://fake/${p}` } },
    SharedArrayBuffer: undefined,
    stats: () => pipelineCalls,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ['ort-config.js', 'embed.js', 'nli-select.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, sandbox };
}

(async () => {
  const N = 8;

  async function burst(expr, label) {
    const { ctx, sandbox } = makeCtx(label);
    const t0 = Date.now();
    await vm.runInContext(expr, ctx);
    const ms = Date.now() - t0;
    return { calls: sandbox.stats(), ms };
  }

  const embedRes = await burst(
    `Promise.all(Array.from({length: ${N}}, () => self.Embed.init()))`, 'embed');
  const nliRes = await burst(
    `Promise.all(Array.from({length: ${N}}, () => self.NliSelect.load()))`, 'nli');

  console.log(`Concurrent callers: ${N}\n`);
  console.log(`embed.js   Embed.init()     -> pipeline() called ${embedRes.calls} time(s)  [${embedRes.ms}ms]`);
  console.log(`nli-select NliSelect.load() -> pipeline() called ${nliRes.calls} time(s)  [${nliRes.ms}ms]`);
  console.log('');
  console.log(embedRes.calls === 1
    ? 'embed.js: deduplicated (no bug)'
    : `embed.js: NOT deduplicated — ${embedRes.calls} concurrent model loads for ${N} callers`);

  // Second question: does a LATER call reuse the already-loaded pipeline?
  const { ctx, sandbox } = makeCtx('sequential');
  await vm.runInContext(`self.Embed.init()`, ctx);
  await vm.runInContext(`self.Embed.init()`, ctx);
  await vm.runInContext(`self.Embed.init()`, ctx);
  console.log(`\nembed.js  3 SEQUENTIAL Embed.init() calls -> pipeline() called ${sandbox.stats()} time(s)`);
  console.log(sandbox.stats() === 1
    ? '  (cached after first load)'
    : '  NOT cached — every call reloads the model from scratch');
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
