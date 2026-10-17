const test = require('node:test');
const assert = require('node:assert');
const { fromCatalog } = require('../utils/openrouterCatalog');

test('OpenRouter catalog keeps chat models with price, context and tool support, newest first', () => {
    const models = fromCatalog({ data: [
        { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', created: 100, context_length: 128000,
          pricing: { prompt: '0.00000015', completion: '0.0000006' }, supported_parameters: ['tools', 'temperature'],
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
        { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)', created: 200, context_length: 131072,
          pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
        { id: 'openrouter/auto', name: 'Auto Router', created: 50, context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
        { id: 'fish-audio/s2.1-pro-free:free', name: 'Fish Audio', created: 300, architecture: { output_modalities: ['audio'] } },
        { name: 'no id' },
    ] });
    assert.deepEqual(models.map(m => m.id), ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-4o-mini', 'openrouter/auto']);
    assert.deepEqual(models[1], { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', context: 128000, inputCost: 1.5e-7, outputCost: 6e-7, free: false, tools: true, created: 100 });
    assert.equal(models[0].free, true);
    assert.equal(models[0].tools, true);
    assert.equal(models[2].inputCost, null); // "varies" is not a price
    assert.equal(models[2].free, false);
    assert.deepEqual(fromCatalog(null), []);
});
