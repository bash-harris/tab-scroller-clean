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
      console.log('⚡ [Offscreen] 1/4 Resolving Transformers library...');
      const mod = await getTransformers();

      // Configure bundled WASM SIMD paths as reliable fallback
      const OC = self.OrtConfig || window?.OrtConfig;
      if (OC && typeof OC.configureOrt === 'function') {
        OC.configureOrt(mod);
      }

      console.log('⚡ [Offscreen] 2/4 Checking hardware GPU adapter...');
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            console.log('⚡ [Offscreen] Hardware GPU adapter acquired:', adapter);
            isWebGpuActive = true;
          }
        } catch (e) {
          console.warn('[Offscreen] GPU adapter check skipped:', e.message);
        }
      }

      console.log('⚡ [Offscreen] 3/4 Loading Zero-Shot NLI Pipeline (Xenova/nli-deberta-v3-xsmall)...');
      try {
        classifier = await mod.pipeline('zero-shot-classification', MODEL_ID);
        console.log('✅ [Offscreen] 4/4 Zero-Shot NLI Pipeline loaded and ready!');
        
        // Immediate dummy warmup pass to compile kernels ahead of time
        try {
          await classifier('warmup premise', ['warmup'], {
            multi_label: true,
            hypothesis_template: 'This browser tab is about {}.'
          });
          console.log('🔥 [Offscreen] Warmup pass complete — GPU shaders ready for instant inference!');
        } catch (wErr) {
          // Warmup non-fatal
        }
      } catch (e) {
        console.error('❌ [Offscreen] NLI Pipeline load failed:', e);
        throw e;
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
        const t0 = performance.now();
        const count = Array.isArray(msg.premises) ? msg.premises.length : 1;
        console.log(`⚡ [Offscreen] Received batch inference request for ${count} tabs against concept: "${msg.candidates?.[0]}"`);
        
        try {
          const pipe = await initWebGpuNli();
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

          const elapsed = Math.round(performance.now() - t0);
          console.log(`✅ [Offscreen] Batch inference finished for ${premises.length} tabs in ${elapsed}ms (${(elapsed / premises.length).toFixed(1)}ms/tab)`);
          sendResponse({
            success: true,
            results,
            elapsed,
            isWebGpu: isWebGpuActive,
            count: premises.length
          });
        } catch (err) {
          console.error('❌ [Offscreen Batch] Inference error:', err);
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
          const elapsed = Math.round(performance.now() - t0);
          sendResponse({
            success: true,
            result,
            elapsed,
            isWebGpu: isWebGpuActive
          });
        } catch (err) {
          console.error('❌ [Offscreen] Inference error:', err);
          sendResponse({ success: false, error: err.message || String(err) });
        }
      })();
      return true; // Keep message channel open for async response
    }
  });
})();
