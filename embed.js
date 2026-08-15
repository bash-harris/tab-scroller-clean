(() => {
  let pipelineFn = null;

  async function loadPipeline() {
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
