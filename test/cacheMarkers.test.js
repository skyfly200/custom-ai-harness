const test = require('node:test');
const assert = require('node:assert');
const { isAnthropic, addCacheMarkers } = require('../utils/cacheMarkers');

test('cache markers are only for Claude served by a provider', () => {
    assert.equal(isAnthropic({ upstream: 'openrouter/anthropic/claude-sonnet-5.5' }), true);
    assert.equal(isAnthropic({ upstream: 'anthropic/claude-opus-5-5' }), true);
    assert.equal(isAnthropic({ upstream: 'openai/local-model', local: 'engine' }), false);
    assert.equal(isAnthropic({ upstream: 'openrouter/openai/gpt-4o-mini' }), false);
    assert.equal(isAnthropic(undefined), false);
});

test('markers go on the system prompt and the last two messages with text', () => {
    const out = addCacheMarkers([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'x' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 't' }] },
        { role: 'tool', tool_call_id: 't', content: 'result' },
    ]);
    const marks = out.map(m => Array.isArray(m.content) && m.content.some(p => p.cache_control));
    assert.deepEqual(marks, [true, false, true, true, false, false]);
    assert.deepEqual(out[0].content, [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
    assert.equal(out[3].content[1].cache_control, undefined);
    assert.equal(out[5].content, 'result');
});

test('a request that already has markers is left alone', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }, { role: 'assistant', content: 'yo' }];
    assert.equal(addCacheMarkers(messages), messages);
});
