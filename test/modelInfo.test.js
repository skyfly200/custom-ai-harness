const test = require('node:test');
const assert = require('node:assert');
const { fromGatewayInfo, fromConfig } = require('../utils/modelInfo');

test('model info reads prices and context sizes from the Gateway and marks free models', () => {
    const models = fromGatewayInfo([
        { model_name: 'paid', litellm_params: { model: 'openrouter/openai/gpt-5' }, model_info: { max_input_tokens: 400000, max_output_tokens: 128000, input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 } },
        { model_name: 'paid', litellm_params: { model: 'other' }, model_info: { max_input_tokens: 1 } },
        { model_name: 'free-or', litellm_params: { model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' }, model_info: { max_input_tokens: 131072, input_cost_per_token: 1e-7 } },
        { model_name: 'local', litellm_params: { model: 'openai/qwen', api_base: 'http://localhost:11434/v1' }, model_info: {} },
    ]);
    assert.deepEqual(models.paid, { maxInput: 400000, maxOutput: 128000, inputCost: 1.25e-6, outputCost: 1e-5, free: false, upstream: 'openrouter/openai/gpt-5', local: false });
    assert.equal(models['free-or'].free, true);
    assert.equal(models['free-or'].inputCost, 0);
    assert.equal(models['free-or'].maxInput, 131072);
    assert.equal(models.local.free, true);
    assert.equal(models.local.local, 'ollama');
});

test('model info falls back to config.yaml for which models are free', () => {
    const models = fromConfig(`model_list:
  - model_name: fallback-groq
    litellm_params:
      model: groq/openai/gpt-oss-120b
  - model_name: fallback-openrouter
    litellm_params:
      model: openrouter/openrouter/free
  - model_name: fallback-ollama
    litellm_params:
      model: openai/qwen2.5-coder:7b
      api_base: http://localhost:11434/v1
litellm_settings:
  drop_params: true
`);
    assert.equal(models['fallback-groq'].free, false);
    assert.equal(models['fallback-groq'].inputCost, null);
    assert.equal(models['fallback-openrouter'].free, true);
    assert.equal(models['fallback-ollama'].free, true);
    assert.equal(models['fallback-ollama'].local, 'ollama');
    assert.equal(models['fallback-groq'].upstream, 'groq/openai/gpt-oss-120b');
});
