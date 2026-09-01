(() => {
  let pipelineFn = null;
  let loading = null;

  // Already-loaded + in-flight guards, same shape as NliSelect.load(). Without
  // them every caller ran its own load: on an extension reload with a large tab
  // set, the startup sweep and the onUpdated burst all call ensureRagReady()
  // inside the cold window, and each one fetched the model and built its own ORT
  // session in the single worker thread. allowLocalModels is false (ort-config.js)
  // so each of those is a full CDN fetch, and the pile-up wedged the worker
  // before any code path reached its first console.log.
  async function loadPipeline() {
    if (pipelineFn) return pipelineFn;
    if (loading) return loading;
    loading = (async () => {
      let mod;
      try {
        mod = require('@xenova/transformers');
      } catch {
        mod = self?.transformers;
      }
      // transformers.js has ONE global env, so this and nli-select.js are writing
      // the same settings -- whichever loads first wins. Both call the same helper
      // so the winner does not matter. See ort-config.js for why wasmPaths is the
      // difference between a usable model and a 1495ms forward pass.
      const OC = (typeof self !== 'undefined' && self.OrtConfig) || require('./ort-config.js');
      OC.configureOrt(mod);
      pipelineFn = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      return pipelineFn;
    })();
    try {
      return await loading;
    } catch (e) {
      loading = null; // a failed load must not poison every later attempt
      throw e;
    }
  }

  const Embed = {
    async init() {
      await loadPipeline();
    },

    // Single, latency-sensitive embed (e.g. the live query vector). Stays on
    // WASM-in-service-worker on purpose: one short text does not fill a GPU, and
    // the IPC round-trip to the offscreen document would cost more than the
    // forward pass it saves. The GPU path is reserved for batches (embedBatch).
    async embed(text) {
      const result = await pipelineFn(text, { pooling: 'mean', normalize: true });
      return new Float32Array(result.data);
    },

    // Batched embed. The offline sweep hands us many tab pseudo-docs at once;
    // one batched forward pass on the GPU is the matmul big enough to actually
    // raise utilization, versus N sequential batch-of-1 WASM passes. If the
    // offscreen GPU route is unavailable (no chrome APIs, offscreen down, or an
    // error mid-flight) we fall back to per-text WASM so callers always get a
    // vector per input, in order.
    async embedBatch(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const viaGpu = await this._embedBatchViaOffscreen(texts);
      if (viaGpu) return viaGpu;
      return Promise.all(texts.map(t => this.embed(t)));
    },

    // Send the whole batch to the offscreen document's WebGPU feature-extraction
    // pipeline in a single message. Returns an array of Float32Array on success,
    // or null to signal the caller to fall back to WASM. Never throws.
    async _embedBatchViaOffscreen(texts) {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage || typeof chrome.offscreen === 'undefined') {
          return null;
        }
        if (typeof self !== 'undefined' && typeof self.ensureOffscreenDocument === 'function') {
          await self.ensureOffscreenDocument();
        }
        const vectors = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Offscreen embed timeout (15000ms)')), 15000);
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_EMBED_BATCH', texts }, (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response || !response.success || !Array.isArray(response.vectors)) {
              return reject(new Error(response?.error || 'Empty offscreen embed response'));
            }
            resolve(response.vectors);
          });
        });
        return vectors.map(v => new Float32Array(v));
      } catch (err) {
        console.warn('[Embed] Offscreen batch embed failed, falling back to WASM:', err.message);
        return null;
      }
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Embed };
  }
  if (typeof self !== 'undefined') {
    self.Embed = Embed;
  }
})();
