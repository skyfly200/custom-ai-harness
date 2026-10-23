const test = require('node:test');
const assert = require('node:assert/strict');
const batch = require('../utils/batchModels');

test('batch models match exact ids, :free twins and vendor wildcards', () => {
    const list = ['anthropic/claude-haiku-5.5', 'google/*'];
    assert.equal(batch.isBatch('anthropic/claude-haiku-5.5', list), true);
    assert.equal(batch.isBatch('Anthropic/Claude-Haiku-5.5:free', list), true);
    assert.equal(batch.isBatch('google/gemini-3.8-flash', list), true);
    assert.equal(batch.isBatch('googleish/x', list), false);
    assert.equal(batch.isBatch('openai/gpt-4o', list), false);
    assert.deepEqual(batch.mark([{ id: 'google/a' }, { id: 'x/y' }], list).map(m => m.batch), [true, false]);
});

test('the shipped batch list loads and a missing file gives no batch models', () => {
    assert.ok(batch.load().includes('anthropic/claude-haiku-5.5'));
    assert.deepEqual(batch.load('/nonexistent/batch.json'), []);
});
