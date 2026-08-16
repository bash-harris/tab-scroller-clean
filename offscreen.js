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
  let classifier = null;
  let loadingPromise = null;
  let isWebGpuActive = false;

  async function getTransformers() {
    // Poll for transformers library if loaded asynchronously
    for (let i = 0; i < 50; i++) {
      const mod = self.transformers || window?.transformers;
      if (mod && mod.pipeline) return mod;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('transformers.js unavailable in offscreen document');
  }

  async function initWebGpuNli() {
    if (classifier) return classifier;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      const mod = await getTransformers();

      // Configure bundled WASM SIMD paths as reliable fallback
      const OC = self.OrtConfig || window?.OrtConfig;
      if (OC && typeof OC.configureOrt === 'function') {
        OC.configureOrt(mod);
      }

      // Acquire WebGPU adapter (Windows DXGI automatically selects the hardware GPU)
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

      try {
        classifier = await mod.pipeline('zero-shot-classification', MODEL_ID, {
          device: isWebGpuActive ? 'webgpu' : 'wasm'
        });
        console.log(`[Offscreen] Zero-Shot NLI Pipeline loaded (device: ${isWebGpuActive ? 'webgpu' : 'wasm'})`);
        
        // Immediate dummy warmup pass to compile WebGPU shaders ahead of time
        try {
          await classifier('warmup premise', ['warmup'], {
            multi_label: true,
            hypothesis_template: 'This browser tab is about {}.'
          });
          console.log('[Offscreen] WebGPU shaders compiled and warmed');
        } catch (wErr) {
          // Warmup non-fatal
        }
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

  // Preload and warm the pipeline immediately in background
  initWebGpuNli().catch(e => console.warn('[Offscreen] Background warmup failed:', e.message));

  // Register onMessage listener SYNCHRONOUSLY at evaluation time
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Fast ping response so sender knows the offscreen document is alive
    if (msg.type === 'OFFSCREEN_PING') {
      sendResponse({
        ok: true,
        ready: !!classifier,
        isWebGpu: isWebGpuActive,
        gpuAvailable: typeof navigator !== 'undefined' && !!navigator.gpu
      });
      return false;
    }

    if (msg.type === 'OFFSCREEN_NLI_BATCH') {
      (async () => {
        try {
          const pipe = await initWebGpuNli();
          const t0 = performance.now();
          const premises = Array.isArray(msg.premises) ? msg.premises : [msg.premises];
          
          if (premises.length === 0) {
            sendResponse({ success: true, results: [], elapsed: 0, isWebGpu: isWebGpuActive });
            return;
          }

          // Process in concurrent GPU chunks of 8
          const CHUNK_SIZE = 8;
          let results = [];
          for (let i = 0; i < premises.length; i += CHUNK_SIZE) {
            const chunk = premises.slice(i, i + CHUNK_SIZE);
            const chunkRes = await Promise.all(chunk.map(p => pipe(p, msg.candidates, msg.options)));
            results.push(...chunkRes);
          }

          const elapsed = performance.now() - t0;
          sendResponse({
            success: true,
            results,
            elapsed: Math.round(elapsed),
            isWebGpu: isWebGpuActive,
            count: premises.length
          });
        } catch (err) {
          console.error('[Offscreen Batch] Inference error:', err);
          sendResponse({ success: false, error: err.message || String(err) });
        }
      })();
      return true; // Keep message channel open for async response
    }

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
  });
})();
