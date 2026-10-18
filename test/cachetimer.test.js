const test = require('node:test');
const assert = require('node:assert');
const { cacheRule, cacheUsage, cacheState, fmtLeft } = require('../ui/cachetimer');

const MIN = 60 * 1000;

test('cache rules come from the provider model behind a name', () => {
    assert.equal(cacheRule({ upstream: 'openrouter/anthropic/claude-sonnet-5.5' }).provider, 'Anthropic');
    assert.equal(cacheRule({ upstream: 'anthropic/claude-opus-5-5' }).ttl, 5 * MIN);
    assert.equal(cacheRule({ upstream: 'openrouter/openai/gpt-4o-mini' }).provider, 'OpenAI');
    assert.equal(cacheRule({ upstream: 'openai/qwen2.5-coder:7b', local: 'ollama' }).provider, 'Ollama');
    // the local engine that answers as claude-3-5-sonnet is not Anthropic
    assert.equal(cacheRule({ upstream: 'openai/claude-3-5-sonnet-20240620', local: 'engine' }).ttl, null);
    const groq = cacheRule({ upstream: 'groq/openai/gpt-oss-120b' });
    assert.equal(groq.ttl, null);
    assert.equal(groq.provider, 'Groq');
    assert.equal(cacheRule(undefined).ttl, null);
});

test('cache usage reads Anthropic, OpenAI and OpenRouter shapes', () => {
    assert.deepEqual(cacheUsage({ prompt_tokens: 5000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900 }), { read: 4000, write: 900, long: 0, prompt: 5000 });
    assert.deepEqual(cacheUsage({ prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 10 } }), { read: 2048, write: 10, long: 0, prompt: 3000 });
    assert.equal(cacheUsage({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation: { ephemeral_1h_input_tokens: 5 } }).prompt, 100);
    assert.equal(cacheUsage(null), null);
});

test('cache state counts down from the last request and knows when nothing was cached', () => {
    const anthropic = cacheRule({ upstream: 'openrouter/anthropic/claude-haiku-5.5' });
    const at = 1_000_000;
    const warm = cacheState({ at, read: 100, write: 0, long: 0, prompt: 200 }, anthropic, at + 2 * MIN);
    assert.equal(warm.state, 'warm');
    assert.equal(warm.left, 3 * MIN);
    assert.equal(cacheState({ at, read: 100, write: 0, long: 0, prompt: 200 }, anthropic, at + 6 * MIN).state, 'expired');
    assert.equal(cacheState({ at, read: 0, write: 50, long: 50, prompt: 200 }, anthropic, at + 30 * MIN).state, 'warm');
    assert.equal(cacheState({ at, read: 0, write: 0, long: 0, prompt: 9000 }, anthropic, at).state, 'none');

    const openai = cacheRule({ upstream: 'openai/gpt-6.1-sol' });
    assert.equal(cacheState({ at, read: 0, write: 0, long: 0, prompt: 500 }, openai, at).state, 'none');
    const fresh = cacheState({ at, read: 0, write: 0, long: 0, prompt: 2000 }, openai, at + MIN);
    assert.equal(fresh.state, 'warm');
    assert.equal(fresh.minimum, true);

    assert.equal(cacheState({ at, read: 10, write: 0, long: 0, prompt: 20 }, cacheRule({ upstream: 'gemini/gemini-4' }), at).state, 'unknown');
    assert.equal(cacheState(undefined, anthropic).state, 'none');
});

test('time left reads as m:ss or h:mm:ss', () => {
    assert.equal(fmtLeft(4 * MIN + 12_000), '4:12');
    assert.equal(fmtLeft(500), '0:01');
    assert.equal(fmtLeft(60 * MIN), '1:00:00');
});
