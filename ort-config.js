// ort-config.js
// One place that configures onnxruntime-web, because there is only one place to
// configure: transformers.js exposes a single global `env` object, so embed.js
// and nli-select.js are writing to the same settings. Whichever ran first used
// to win, which is a bug waiting to happen -- a fix applied to one file and not
// the other silently does nothing.
//
// WHY THIS FILE EXISTS AT ALL
//
// Measured on a 454-tab profile, one NLI forward pass took 1495ms in the MV3
// service worker. The identical code and model in Node took 13ms
// (bench/warmup-probe.js confirms it is steady state, not warmup: pass #1 19ms,
// passes #4-24 mean 13ms). A 115x gap is not "WASM is slower than native" --
// that is normally 5-15x. It was a misconfiguration:
//
//   * No .wasm file shipped with the extension.
//   * Nothing set env.backends.onnx.wasm.wasmPaths.
//
// So onnxruntime-web fell back to its default CDN (cdn.jsdelivr.net) to fetch
// its binary. Under the MV3 CSP -- "script-src 'self' 'wasm-unsafe-eval'" --
// that fetch cannot succeed, and ORT quietly degrades to its slowest build
// instead of failing loudly. Every forward pass ran scalar and unthreaded.
//
// Pointing wasmPaths at a bundled ort-wasm-simd.wasm is a configuration change,
// not an algorithm change, and it is the single largest latency lever in the
// project.

(() => {
  // SIMD is the win; threads are not available here.
  //
  // Multi-threaded WASM requires SharedArrayBuffer, which requires cross-origin
  // isolation (COEP/COOP headers). An MV3 service worker cannot set response
  // headers on itself, so SharedArrayBuffer is absent and numThreads > 1 would
  // load ort-wasm-simd-threaded.wasm only to fall back at runtime. We ship the
  // non-threaded SIMD build deliberately.
  //
  // This is worth stating because an earlier version of nli-select.js set
  // numThreads to min(4, cores) behind a SharedArrayBuffer feature-detect and
  // described it as a speedup. The detect always resolves false in this context,
  // so it was a no-op that read like a win.
  function configureOrt(mod) {
    if (!mod || !mod.env) return { configured: false, reason: 'no env' };
    const wasm = mod.env.backends?.onnx?.wasm;
    if (!wasm) return { configured: false, reason: 'no wasm backend' };

    // Browser only. In Node, transformers.js resolves onnxruntime-node (native)
    // and these settings are both unnecessary and wrong -- the bench must keep
    // measuring the native path so the WASM/native ratio stays observable.
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime?.getURL;
    if (!isExtension) return { configured: false, reason: 'node (native ort)' };

    // Models are fetched from HF CDN / Cache; suppress failed local /models/... fetch probes
    mod.env.allowLocalModels = false;

    // Trailing slash is required: ORT concatenates the filename onto this
    // prefix, so 'vendor' would resolve to 'vendorort-wasm-simd.wasm'.
    wasm.wasmPaths = chrome.runtime.getURL('vendor/');

    const canThread = typeof SharedArrayBuffer !== 'undefined';
    wasm.numThreads = 1;
    // SIMD is on by default in ORT 1.14 when the runtime supports it; setting it
    // explicitly documents the intent and guards against a default change.
    wasm.simd = true;

    return {
      configured: true,
      wasmPaths: wasm.wasmPaths,
      numThreads: wasm.numThreads,
      simd: wasm.simd,
      // Reported so the browser log can prove which build actually loaded,
      // rather than us assuming the fix took effect.
      sharedArrayBuffer: canThread
    };
  }

  const OrtConfig = { configureOrt };
  if (typeof module !== 'undefined' && module.exports) module.exports = OrtConfig;
  if (typeof self !== 'undefined') self.OrtConfig = OrtConfig;
})();
