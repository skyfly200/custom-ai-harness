const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gateway = require('../utils/gatewayConfig');

const config = fs.readFileSync(path.join(__dirname, 'fixtures', 'config.yaml'), 'utf8');

test('reads the model names and fallback chains from config.yaml', () => {
    const { models, fallbacks } = gateway.parse(config);
    assert.ok(models.includes('local-engine') && models.includes('fallback-ollama'));
    assert.deepEqual(fallbacks['fallback-groq'], ['fallback-openrouter']);
    assert.equal(fallbacks['local-engine'][0], 'fast-openrouter');
});

test('a rate-limited free group has its own chain ending at a paid model', () => {
    // this one checks the config.yaml that ships, not the fixture
    const { fallbacks } = gateway.parse(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8'));
    // LiteLLM answers "No fallback model group found" for a group without a chain
    for (const group of fallbacks['local-engine'].filter((m) => m !== 'fast-openrouter')) {
        assert.ok(fallbacks[group]?.length, `${group} has no fallback chain`);
    }
    assert.equal(fallbacks['fallback-openrouter'].at(-1), 'fast-openrouter');
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

test('lists each model_list entry with its provider model, never a literal key', () => {
    const { deployments, version } = gateway.parse(config);
    const groq = deployments.find(d => d.name === 'fallback-groq');
    assert.equal(groq.model, 'groq/openai/gpt-oss-120b');
    assert.equal(groq.api_key, 'os.environ/GROQ_API_KEY');
    assert.equal(deployments.find(d => d.name === 'fallback-ollama').api_key, 'set in config.yaml');
    assert.equal(version, gateway.version(config));
});

test('removing an entry drops its lines and comments, adding one appends it', () => {
    const { deployments, version } = gateway.parse(config);
    const groq = deployments.find(d => d.name === 'fallback-groq');
    const { fallbacks } = gateway.parse(config);
    const cleaned = Object.fromEntries(Object.entries(fallbacks).filter(([s]) => s !== 'fallback-groq')
        .map(([s, t]) => [s, t.filter(x => x !== 'fallback-groq')]));
    const out = gateway.update(config, {
        version,
        remove: [groq.id],
        add: [{ name: 'fast-openrouter', model: 'openrouter/google/gemini-2.5-flash', api_key: 'os.environ/OPENROUTER_API_KEY' },
              { name: 'my-local', model: 'openai/llama3.2', api_base: 'http://localhost:11434/v1', api_key: 'dummy' }],
        fallbacks: { ...cleaned, 'my-local': ['fallback-openrouter'] },
    });
    const after = gateway.parse(out);
    assert.ok(!after.models.includes('fallback-groq'));
    assert.doesNotMatch(out, /Tier 2: Groq|gpt-oss-120b/);
    assert.deepEqual(after.deployments.filter(d => d.name === 'fast-openrouter').map(d => d.model),
        ['openrouter/openai/gpt-4o-mini', 'openrouter/google/gemini-2.5-flash']);
    assert.match(out, /\n {2}- model_name: my-local\n {4}litellm_params:\n {6}model: openai\/llama3.2\n {6}api_base: http:\/\/localhost:11434\/v1\n {6}api_key: dummy\n/);
    assert.deepEqual(after.fallbacks['my-local'], ['fallback-openrouter']);
    assert.match(out, /# Concurrency: max_parallel_requests/); // the list's own comments stay
    assert.doesNotMatch(out, /\n\s*\n\s*\n/);                   // no double blank lines left behind
});

test('a removed model still named in a fallback chain is refused', () => {
    const { deployments, version } = gateway.parse(config);
    const groq = deployments.find(d => d.name === 'fallback-groq');
    assert.throws(() => gateway.update(config, { version, remove: [groq.id], fallbacks: gateway.parse(config).fallbacks }), /not a model/);
});

test('a stale version or a bad new entry changes nothing', () => {
    assert.throws(() => gateway.update(config, { version: 'old', remove: [0] }), e => e.status === 409);
    const { version } = gateway.parse(config);
    assert.throws(() => gateway.update(config, { version, add: [{ name: 'a b', model: 'x' }] }), /Gateway name/);
    assert.throws(() => gateway.update(config, { version, add: [{ name: 'a', model: 'x', api_key: 'sk live' }] }), /os.environ/);
    assert.throws(() => gateway.update(config, { version, remove: [99] }), /no model_list entry/);
});
