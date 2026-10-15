const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gateway = require('../utils/gatewayConfig');

const config = fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8');

test('reads the model names and fallback chains from config.yaml', () => {
    const { models, fallbacks } = gateway.parse(config);
    assert.ok(models.includes('claude-sonnet-5') && models.includes('fallback-ollama'));
    assert.deepEqual(fallbacks['fallback-groq'], ['fallback-openrouter']);
    assert.equal(fallbacks['claude-sonnet-5'][0], 'fast-openrouter');
});

test('writing the same chains changes nothing', () => {
    assert.equal(gateway.write(config, gateway.parse(config).fallbacks), config);
});

test('a changed chain is rewritten in place, keeping comments and other lines', () => {
    const { fallbacks } = gateway.parse(config);
    const out = gateway.write(config, { ...fallbacks, 'fallback-groq': ['fallback-ollama', 'fallback-openrouter'] });
    assert.deepEqual(gateway.parse(out).fallbacks['fallback-groq'], ['fallback-ollama', 'fallback-openrouter']);
    const changed = out.split('\n').filter((line, i) => line !== config.split('\n')[i]);
    assert.equal(changed.length, 1);
    assert.match(changed[0], /^ {4}- \{"fallback-groq": +\["fallback-ollama", "fallback-openrouter"\]\}$/);
    assert.match(out, /# Tool-capable first/);
});

test('an emptied chain is removed and a new one is added after the others', () => {
    const { fallbacks } = gateway.parse(config);
    const next = { ...fallbacks, 'fallback-groq': [], 'fast-openrouter': ['fallback-openrouter'] };
    const parsed = gateway.parse(gateway.write(config, next)).fallbacks;
    assert.equal(parsed['fallback-groq'], undefined);
    assert.deepEqual(parsed['fast-openrouter'], ['fallback-openrouter']);
    assert.match(gateway.write(config, next), /"fallback-ollama": +\[.*\]\}\n {4}- \{"fast-openrouter"/);
});

test('unknown models, self loops and repeats are refused', () => {
    assert.throws(() => gateway.write(config, { 'nope': ['fallback-groq'] }), /not a model/);
    assert.throws(() => gateway.write(config, { 'fallback-groq': ['nope'] }), /not a model/);
    assert.throws(() => gateway.write(config, { 'fallback-groq': ['fallback-groq'] }), /itself/);
    assert.throws(() => gateway.write(config, { 'fallback-groq': ['fallback-ollama', 'fallback-ollama'] }), /twice/);
});

test('a config without fallbacks gets a block, and bare names and CRLF are read', () => {
    const bare = 'model_list:\n  - model_name: a\n  - model_name: b\n';
    const out = gateway.write(bare, { a: ['b'] });
    assert.deepEqual(gateway.parse(out).fallbacks, { a: ['b'] });
    assert.match(out, /^litellm_settings:\n {2}fallbacks:\n {4}- \{"a": \["b"\]\}$/m);
    const crlf = 'model_list:\r\n  - model_name: a\r\n  - model_name: b\r\nlitellm_settings:\r\n  fallbacks:\r\n    - {a: [b]}\r\n';
    assert.deepEqual(gateway.parse(crlf).fallbacks, { a: ['b'] });
    assert.ok(gateway.write(crlf, { b: ['a'] }).includes('\r\n    - {"b": ["a"]}'));
});

test('a one-line fallbacks list is reported, not overwritten', () => {
    const text = 'model_list:\n  - model_name: a\nlitellm_settings:\n  fallbacks: [{"a": ["b"]}]\n';
    assert.throws(() => gateway.parse(text), /one line/);
});
