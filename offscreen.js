// offscreen.js
// Dedicated Chrome Extension Offscreen Document for hardware-accelerated WebGPU ML inference.
//
// WHY THIS EXISTS:
// In Chrome MV3, WebGPU and WebGL APIs are not exposed inside Service Workers.
// An Offscreen Document runs in a full DOM context with direct access to `navigator.gpu`
// (DirectX 12 / Vulkan on Windows), allowing ONNX Runtime Web to execute fp32 MatMul operations
// on the NVIDIA / Dedicated GPU rather than CPU WASM.

(() => {
  const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';
  const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
  let classifier = null;
  let loadingPromise = null;
  let embedder = null;
  let embedLoadingPromise = null;
  let isWebGpuActive = false;
  let adapterPromise = null;

  // Acquire the WebGPU adapter exactly once and share it across BOTH the NLI and
  // embedding pipelines. This used to live inside initWebGpuNli(), which meant the
  // embedder could not learn whether the GPU was usable without first forcing the
  // NLI model to load. On Windows the adapter maps to DXGI (DirectX 12), which
  // selects the hardware GPU automatically.
  //
  // The result is memoized as a PROMISE, not a boolean: both pipelines warm up
  // concurrently on mount, so a boolean "checked" flag would let the second caller
  // observe isWebGpuActive===false while the first caller's requestAdapter() is
  // still in flight, silently loading it on WASM. Awaiting one shared promise
  // guarantees both see the same, settled answer.
  function ensureWebGpuAdapter() {
    if (adapterPromise) return adapterPromise;
    adapterPromise = (async () => {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            console.log('[Offscreen WebGPU] Hardware GPU adapter acquired:', adapter);
            isWebGpuActive = true;
          }
        } catch (e) {
          console.warn('[Offscreen WebGPU] Adapter request failed, will fall back to WASM SIMD:', e.message);
        }
      }
      return isWebGpuActive;
    })();
    return adapterPromise;
  }

  async function initWebGpuNli() {
    if (classifier) return classifier;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      const mod = self.transformers;
      if (!mod || !mod.pipeline) {
        throw new Error('transformers.js unavailable in offscreen document');
      }

      // Configure bundled WASM SIMD paths as reliable fallback
      const OC = self.OrtConfig;
      if (OC && typeof OC.configureOrt === 'function') {
        OC.configureOrt(mod);
      }

      // Adapter acquisition is shared with the embedder; see ensureWebGpuAdapter.
      await ensureWebGpuAdapter();

      try {
        classifier = await mod.pipeline('zero-shot-classification', MODEL_ID, {
          device: isWebGpuActive ? 'webgpu' : 'wasm'
        });
        console.log(`[Offscreen] Zero-Shot NLI Pipeline loaded (device: ${isWebGpuActive ? 'webgpu' : 'wasm'})`);
      } catch (e) {
        console.warn('[Offscreen] WebGPU pipeline load error, retrying with WASM SIMD fallback:', e.message);
        isWebGpuActive = false;
        classifier = await mod.pipeline('zero-shot-classification', MODEL_ID);
        console.log('[Offscreen] Fallback NLI Pipeline loaded on WASM SIMD');
      }
      return classifier;
    })();

    return loadingPromise;
  }

  // Feature-extraction (MiniLM) pipeline on the SAME WebGPU device. Embeddings are
  // the high-volume workload -- every indexed tab needs one -- so running them on
  // the GPU in batches is what actually raises GPU utilization. The service worker
  // keeps ownership of single, latency-sensitive query embeds on WASM; this path
  // exists for the offline sweep, which embeds many tabs in one shot.
  async function initWebGpuEmbedder() {
    if (embedder) return embedder;
    if (embedLoadingPromise) return embedLoadingPromise;

    embedLoadingPromise = (async () => {
      const mod = self.transformers;
      if (!mod || !mod.pipeline) {
        throw new Error('transformers.js unavailable in offscreen document');
      }
      const OC = self.OrtConfig;
      if (OC && typeof OC.configureOrt === 'function') OC.configureOrt(mod);

      await ensureWebGpuAdapter();
      try {
        embedder = await mod.pipeline('feature-extraction', EMBED_MODEL_ID, {
          device: isWebGpuActive ? 'webgpu' : 'wasm'
        });
        console.log(`[Offscreen] Feature-extraction pipeline loaded (device: ${isWebGpuActive ? 'webgpu' : 'wasm'})`);
      } catch (e) {
        console.warn('[Offscreen] WebGPU embedder load error, retrying with WASM SIMD fallback:', e.message);
        embedder = await mod.pipeline('feature-extraction', EMBED_MODEL_ID);
        console.log('[Offscreen] Fallback feature-extraction pipeline loaded on WASM SIMD');
      }
      return embedder;
    })();

    return embedLoadingPromise;
  }

  // A pooled feature-extraction call over N texts returns one Tensor with dims
  // [N, dim]. Slice it into N plain number[] arrays -- structured clone can send
  // those back to the service worker, where they are rehydrated as Float32Array.
  function tensorToVectors(out) {
    const dims = out.dims || [];
    const data = out.data;
    if (dims.length === 2) {
      const [n, dim] = dims;
      const vectors = new Array(n);
      for (let i = 0; i < n; i++) {
        vectors[i] = Array.from(data.subarray(i * dim, (i + 1) * dim));
      }
      return vectors;
    }
    return [Array.from(data)];
  }

  // Preload and warm both pipelines immediately when the offscreen document mounts.
  initWebGpuNli().catch(e => console.warn('[Offscreen] NLI warmup failed:', e.message));
  initWebGpuEmbedder().catch(e => console.warn('[Offscreen] Embedder warmup failed:', e.message));

  // Message listener for zero-shot inference requests from service worker / nli-select.js
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'OFFSCREEN_NLI_ZERO_SHOT') {
      (async () => {
        try {
          const pipe = await initWebGpuNli();
          const t0 = performance.now();
          const result = await pipe(msg.premise, msg.candidates, msg.options);
          const elapsed = performance.now() - t0;
          sendResponse({
            success: true,
            result,
            elapsed: Math.round(elapsed),
            isWebGpu: isWebGpuActive
          });
        } catch (err) {
          console.error('[Offscreen] Inference error:', err);
          sendResponse({ success: false, error: err.message || String(err) });
        }
      })();
      return true; // Keep message channel open for async response
    }

    if (msg.type === 'OFFSCREEN_EMBED_BATCH') {
      (async () => {
        try {
          const pipe = await initWebGpuEmbedder();
          const texts = Array.isArray(msg.texts) ? msg.texts : [msg.texts];
          const t0 = performance.now();
          // One batched forward pass over [N, seq]. This is the matmul big enough
          // to actually occupy the GPU, versus N sequential batch-of-1 passes.
          const out = await pipe(texts, { pooling: 'mean', normalize: true });
          const elapsed = performance.now() - t0;
          sendResponse({
            success: true,
            vectors: tensorToVectors(out),
            elapsed: Math.round(elapsed),
            isWebGpu: isWebGpuActive
          });
        } catch (err) {
          console.error('[Offscreen] Batch embed error:', err);
          sendResponse({ success: false, error: err.message || String(err) });
        }
      })();
      return true;
    }

    if (msg.type === 'OFFSCREEN_STATUS') {
      sendResponse({
        ok: true,
        ready: !!classifier,
        embedderReady: !!embedder,
        isWebGpu: isWebGpuActive,
        gpuAvailable: typeof navigator !== 'undefined' && !!navigator.gpu
      });
      return false;
    }
  });
})();
