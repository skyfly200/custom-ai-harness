const test = require('node:test');
const assert = require('node:assert');
const { fromGatewayInfo, fromConfig, withOpenrouterPrices, catalogIdFor } = require('../utils/modelInfo');

test('model info reads prices and context sizes from the Gateway and marks free models', () => {
    const models = fromGatewayInfo([
        { model_name: 'paid', litellm_params: { model: 'openrouter/openai/gpt-5' }, model_info: { max_input_tokens: 400000, max_output_tokens: 128000, input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 } },
        { model_name: 'paid', litellm_params: { model: 'other' }, model_info: { max_input_tokens: 1 } },
        { model_name: 'free-or', litellm_params: { model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' }, model_info: { max_input_tokens: 131072, input_cost_per_token: 1e-7 } },
        { model_name: 'local', litellm_params: { model: 'openai/qwen', api_base: 'http://localhost:11434/v1' }, model_info: {} },
    ]);
    assert.deepEqual(models.paid, { maxInput: 400000, maxOutput: 128000, inputCost: 1.25e-6, outputCost: 1e-5, cacheReadCost: null, cacheWriteCost: null, free: false, upstream: 'openrouter/openai/gpt-5', local: false });
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

test('cache prices come from the Gateway, and local engines in Docker are free', () => {
    const models = fromGatewayInfo([
        { model_name: 'claude', litellm_params: { model: 'anthropic/claude-sonnet-5-5' }, model_info: { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 2.5e-6 } },
        // LiteLLM prices the local wrapper's model name as real Claude
        { model_name: 'claude-sonnet-5', litellm_params: { model: 'openai/claude-3-5-sonnet-20240620', api_base: 'http://host.docker.internal:8000/v1' }, model_info: { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 } },
        { model_name: 'docker-ollama', litellm_params: { model: 'openai/qwen2.5-coder:7b', api_base: 'http://ollama:11434/v1' }, model_info: { input_cost_per_token: 1e-7 } },
    ]);
    assert.equal(models.claude.cacheReadCost, 2e-7);
    assert.equal(models.claude.cacheWriteCost, 2.5e-6);
    assert.equal(models['claude-sonnet-5'].free, true);
    assert.equal(models['claude-sonnet-5'].inputCost, 0);
    assert.equal(models['docker-ollama'].free, true);
});

test("OpenRouter's own prices replace the Gateway's for its models", () => {
    const models = {
        mini: { maxInput: null, inputCost: 1e-6, outputCost: 1e-6, cacheReadCost: null, free: false, upstream: 'openrouter/openai/gpt-4o-mini', local: false },
        newer: { maxInput: null, inputCost: null, outputCost: null, free: false, upstream: 'openrouter/anthropic/claude-sonnet-5.5', local: false },
        groq: { inputCost: 5e-8, outputCost: 1e-7, free: false, upstream: 'groq/openai/gpt-oss-120b', local: false },
        varies: { inputCost: null, outputCost: null, free: false, upstream: 'openrouter/openrouter/auto', local: false },
    };
    const out = withOpenrouterPrices(models, [
        { id: 'openai/gpt-4o-mini', inputCost: 1.5e-7, outputCost: 6e-7, cacheReadCost: 7.5e-8, context: 128000, free: false },
        { id: 'anthropic/claude-sonnet-5.5', inputCost: 2e-6, outputCost: 1e-5, cacheReadCost: 2e-7, cacheWriteCost: 2.5e-6, free: false },
        { id: 'openrouter/auto', inputCost: null, outputCost: null, free: false },
    ]);
    assert.equal(out.mini.inputCost, 1.5e-7);
    assert.equal(out.mini.cacheReadCost, 7.5e-8);
    assert.equal(out.mini.maxInput, 128000);
    assert.equal(out.mini.priceFrom, 'openrouter');
    assert.equal(out.newer.cacheWriteCost, 2.5e-6);
    assert.equal(out.groq, models.groq);
    assert.equal(out.varies.inputCost, null); // no price beats a made-up one
    assert.equal(withOpenrouterPrices(models, null), models);
});

test('zero prices from the Gateway mean unknown, and OpenRouter prices a paid model', () => {
    // LiteLLM lists 0 for models it has no price for
    const models = fromGatewayInfo([
        { model_name: 'or-claude-sonnet-5.5', litellm_params: { model: 'openrouter/anthropic/claude-sonnet-5.5' }, model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
        { model_name: 'free-or', litellm_params: { model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' }, model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
    ]);
    assert.equal(models['or-claude-sonnet-5.5'].free, false);
    assert.equal(models['or-claude-sonnet-5.5'].inputCost, null);
    assert.equal(models['free-or'].free, true);
    const priced = withOpenrouterPrices(models, [
        { id: 'anthropic/claude-sonnet-5.5', inputCost: 2e-6, outputCost: 1e-5, cacheReadCost: 2e-7, free: false },
        { id: 'meta-llama/llama-3.3-70b-instruct:free', inputCost: 0, outputCost: 0, free: true },
    ]);
    assert.equal(priced['or-claude-sonnet-5.5'].free, false);
    assert.equal(priced['or-claude-sonnet-5.5'].inputCost, 2e-6);
    assert.equal(priced['free-or'].free, true);
});

test('model names are matched to OpenRouter ids only when one model fits', () => {
    const catalog = [{ id: 'anthropic/claude-sonnet-5.5' }, { id: 'anthropic/claude-sonnet-5.5:batch' }, { id: 'a/twin' }, { id: 'b/twin' }];
    assert.equal(catalogIdFor('or-claude-sonnet-5.5', catalog), 'anthropic/claude-sonnet-5.5');
    assert.equal(catalogIdFor('claude-sonnet-5.5', catalog), 'anthropic/claude-sonnet-5.5');
    assert.equal(catalogIdFor('or-twin', catalog), null);
    assert.equal(catalogIdFor('or-nothing', catalog), null);
});
