(() => {
  let pipelineFn = null;

  async function loadPipeline() {
    let mod;
    try {
      mod = require('@xenova/transformers');
    } catch {
      mod = self?.transformers;
    }
    if (mod && mod.env) {
      mod.env.backends.onnx.wasm.numThreads = 1;
    }
    pipelineFn = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }

  const Embed = {
    async init() {
      await loadPipeline();
    },

    async embed(text) {
      const result = await pipelineFn(text, { pooling: 'mean', normalize: true });
      return new Float32Array(result.data);
    },

    async embedBatch(texts) {
      return Promise.all(texts.map(t => this.embed(t)));
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Embed };
  }
  if (typeof self !== 'undefined') {
    self.Embed = Embed;
  }
})();
