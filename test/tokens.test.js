const test = require('node:test');
const assert = require('node:assert/strict');

const Tokens = require('../ui/tokens');

test('OpenAI usage: prompt and completion tokens, cache reads from the details', () => {
    const k = Tokens.usage({ prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 900 } });
    assert.deepEqual(k, { input: 1200, output: 300, cacheRead: 900, cacheWrite: 0, cost: null, exact: true });
});

test('Anthropic usage: input tokens, cache reads and writes all count as input', () => {
    const k = Tokens.usage({ input_tokens: 120, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40, output_tokens: 42 });
    assert.equal(k.input, 1160);
    assert.equal(k.output, 42);
    assert.equal(k.cacheRead, 1000);
    assert.equal(k.cacheWrite, 40);
    assert.equal(k.exact, true);
});

test('a counted zero is not the same as no count at all', () => {
    // the provider sent a usage object but no output yet (the first piece of a stream)
    const k = Tokens.usage({ prompt_tokens: 800, completion_tokens: 0 });
    assert.equal(k.input, 800);
    assert.equal(k.output, 0);
    assert.equal(k.exact, true);
    // nothing usable in it
    assert.equal(Tokens.usage({}), null);
    assert.equal(Tokens.usage(null), null);
    assert.equal(Tokens.usage({ completion_tokens: 5 }).exact, false, 'output only: input was not counted');
});

test('OpenRouter reports the cost with the usage', () => {
    assert.equal(Tokens.usage({ prompt_tokens: 10, completion_tokens: 2, cost: 0.00012 }).cost, 0.00012);
});

test('merging streamed usage keeps the largest of each count', () => {
    // Anthropic: input_tokens leaves the cached part out, so input is both added
    const a = Tokens.usage({ input_tokens: 120, cache_read_input_tokens: 1000, output_tokens: 1 });
    const b = Tokens.usage({ output_tokens: 42 });
    const k = Tokens.merge(a, b);
    assert.equal(k.input, 1120);
    assert.equal(k.cacheRead, 1000);
    assert.equal(k.output, 42);
});

test('characters of a streamed piece count the text, the thinking and the tool arguments', () => {
    assert.equal(Tokens.charsOf({ choices: [{ delta: { content: 'abcd' } }] }), 4);
    assert.equal(Tokens.charsOf({ choices: [{ delta: { reasoning_content: 'abc' } }] }), 3);
    assert.equal(Tokens.charsOf({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }] }), 7);
    // Anthropic's own stream shape
    assert.equal(Tokens.charsOf({ delta: { text: 'hello' } }), 5);
});

test('an estimate from the Interceptor is marked inexact', () => {
    const k = Tokens.fromEstimate({ input: 900, output: 40 });
    assert.equal(k.exact, false);
    assert.equal(k.input, 900);
    assert.equal(Tokens.fromEstimate({ input: 0, output: 0 }), null);
});

test('the size estimate is the Interceptor rule: about 4 characters a token', () => {
    assert.equal(Tokens.size('12345678'), 2);
    assert.equal(Tokens.size(''), 0);
    assert.equal(Tokens.size(null), 0);
});
