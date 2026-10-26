// Short model names ("opus", "sonnet") find the newest model the Gateway serves.
const test = require('node:test');
const assert = require('node:assert/strict');
const alias = require('../utils/modelAlias');

const served = [
    'anthropic/claude-opus-4.5',
    'anthropic/claude-opus-5.5',
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-haiku-4.5',
    'openrouter/google/gemini-3.8-flash',
    'fast-openrouter',
    'fallback-openrouter',
];

test('a short family name finds the newest version', () => {
    assert.equal(alias.resolve('opus', served), 'anthropic/claude-opus-5.5');
    assert.equal(alias.resolve('sonnet', served), 'anthropic/claude-sonnet-5.5');
    assert.equal(alias.resolve('haiku', served), 'anthropic/claude-haiku-4.5');
});

test('a name the list already has is never second-guessed', () => {
    assert.equal(alias.resolve('fast-openrouter', served), 'fast-openrouter');
    assert.equal(alias.resolve('anthropic/claude-opus-4.5', served), 'anthropic/claude-opus-4.5');
    assert.equal(alias.resolve('Anthropic/Claude-Opus-4.5', served), 'anthropic/claude-opus-4.5');
});

test('a version in the name picks that version', () => {
    assert.equal(alias.resolve('opus-4.5', served), 'anthropic/claude-opus-4.5');
    assert.equal(alias.resolve('claude-opus-4.5', served), 'anthropic/claude-opus-4.5');
    assert.equal(alias.resolve('opus-9', served), null, 'a version nobody serves');
});

test('versions are numbers, so 5.10 is newer than 5.9 and 5 is older than 5.1', () => {
    const list = ['x/claude-opus-5.9', 'x/claude-opus-5.10', 'x/claude-opus-5'];
    assert.equal(alias.resolve('opus', list), 'x/claude-opus-5.10');
    assert.equal(alias.olderThan('x/claude-opus-5', 'x/claude-opus-5.1'), true);
    assert.equal(alias.olderThan('x/claude-opus-5.10', 'x/claude-opus-5.9'), false);
});

test('a name nothing matches resolves to null, and the list is offered instead', () => {
    assert.equal(alias.resolve('gpt-9', served), null);
    assert.deepEqual(alias.candidates('gemini', served), ['openrouter/google/gemini-3.8-flash']);
});

test('a :free twin sorts with its family, and or- prefixes are ignored', () => {
    const list = ['or-claude-sonnet-5', 'anthropic/claude-sonnet-5:free'];
    assert.equal(alias.resolve('sonnet', list), 'or-claude-sonnet-5');
    assert.equal(alias.shortName('anthropic/claude-sonnet-5:free'), 'claude-sonnet');
});

test('the Gateway name for a family is offered when nothing is called just that', () => {
    const list = ['fast-openrouter', 'claude-opus-4.5'];
    assert.deepEqual(alias.candidates('opus', list), ['claude-opus-4.5']);
});
