jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn().mockResolvedValue(
    jest.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.1)
    })
  )
}));

const { Embed } = require('../embed');

describe('Embed', () => {
  test('init loads the model', async () => {
    await expect(Embed.init()).resolves.not.toThrow();
  });

  test('embed returns a Float32Array of 384 dimensions', async () => {
    await Embed.init();
    const result = await Embed.embed('hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  test('embedBatch returns array of embeddings', async () => {
    await Embed.init();
    const results = await Embed.embedBatch(['hello', 'world']);
    expect(results).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(results[0].length).toBe(384);
  });
});
