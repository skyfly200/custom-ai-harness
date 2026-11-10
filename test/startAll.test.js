const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildCommands, wantsOllama } = require('../scripts/start-all');

const everything = () => true;
const nothing = () => false;
const names = r => r.commands.map(c => c.name);

test('starts Gateway, Router, Interceptor and task runner, without Ollama by default', () => {
    const r = buildCommands({ platform: 'linux', env: {}, argv: [], exists: everything });
    assert.deepStrictEqual(names(r), ['gateway', 'router', 'interceptor', 'runner']);
    assert.strictEqual(r.commands[0].command, `${path.join('.venv', 'bin', 'litellm')} --config config.yaml`);
    assert.strictEqual(r.commands[0].env.PYTHONUTF8, '1');
    assert.deepStrictEqual(r.warnings, []);
});

test('uses the Windows .venv\\Scripts executables', () => {
    const r = buildCommands({ platform: 'win32', env: {}, argv: [], exists: everything });
    assert.strictEqual(r.commands[1].command, `${path.join('.venv', 'Scripts', 'python.exe')} router.py`);
});

test('falls back to PATH with a warning when there is no .venv', () => {
    const r = buildCommands({ platform: 'win32', env: {}, argv: [], exists: nothing });
    assert.strictEqual(r.commands[0].command, 'litellm --config config.yaml');
    assert.strictEqual(r.commands[1].command, 'python router.py');
    assert.strictEqual(r.warnings.length, 1);
});

test('Ollama is opt-in by flag or START_OLLAMA', () => {
    assert.strictEqual(wantsOllama([], {}), false);
    assert.strictEqual(wantsOllama(['--ollama'], {}), true);
    assert.strictEqual(wantsOllama([], { START_OLLAMA: '1' }), true);
    assert.strictEqual(wantsOllama(['--no-ollama'], { START_OLLAMA: 'true' }), false);
    const r = buildCommands({ platform: 'linux', env: {}, argv: ['--ollama'], exists: everything });
    assert.deepStrictEqual(names(r), ['gateway', 'router', 'interceptor', 'runner', 'ollama']);
});

test('does not start Ollama twice when it already answers', () => {
    const r = buildCommands({ platform: 'linux', env: { START_OLLAMA: 'yes' }, argv: [], exists: everything, ollamaRunning: true });
    assert.deepStrictEqual(names(r), ['gateway', 'router', 'interceptor', 'runner']);
    assert.match(r.warnings[0], /already running/);
});

test('with federation on, the Gateway is pointed at the Interceptor\'s OpenRouter proxy', () => {
    const env = { OPENROUTER_FEDERATION_POLICY_ID: 'pol_1', LITELLM_MASTER_KEY: 'sk-master' };
    const gateway = buildCommands({ platform: 'linux', env, argv: [], exists: () => true }).commands[0];
    assert.equal(gateway.env.OPENROUTER_API_KEY, 'sk-master');
    assert.equal(gateway.env.OPENROUTER_API_BASE, 'http://127.0.0.1:3000/openrouter-proxy/v1');
    const renew = buildCommands({ platform: 'linux', env: { OPENROUTER_MAIN_KEY_RENEW: '1', OPENROUTER_MANAGEMENT_KEY: 'sk-or-m', LITELLM_MASTER_KEY: 'sk-master' }, argv: [], exists: () => true }).commands[0];
    assert.equal(renew.env.OPENROUTER_API_BASE, 'http://127.0.0.1:3000/openrouter-proxy/v1', 'main key renewal goes through the proxy too');
    const plain = buildCommands({ platform: 'linux', env: {}, argv: [], exists: () => true }).commands[0];
    assert.equal(plain.env.OPENROUTER_API_KEY, undefined);
});

test('a Docker-only proxy address in .env is replaced with this PC\'s harness, with a warning', () => {
    const env = { OPENROUTER_FEDERATION_POLICY_ID: 'pol_1', OPENROUTER_PROXY_KEY: 'k', OPENROUTER_PROXY_URL: 'http://harness:3000/' };
    const r = buildCommands({ platform: 'win32', env, argv: [], exists: everything });
    assert.equal(r.commands[0].env.OPENROUTER_API_BASE, 'http://127.0.0.1:3000/openrouter-proxy/v1');
    assert.equal(r.commands[0].env.OPENROUTER_PROXY_URL, 'http://127.0.0.1:3000');
    assert.equal(r.commands[1].env.OPENROUTER_PROXY_URL, 'http://127.0.0.1:3000', 'the Router uses the same address');
    assert.ok(r.warnings.some(w => /Docker address/.test(w) && /harness:3000/.test(w)));
});

test('a deliberate proxy address is kept as typed', () => {
    const env = { OPENROUTER_FEDERATION_POLICY_ID: 'pol_1', OPENROUTER_PROXY_KEY: 'k', OPENROUTER_PROXY_URL: 'http://127.0.0.1:4010/' };
    const r = buildCommands({ platform: 'linux', env, argv: [], exists: everything });
    assert.equal(r.commands[0].env.OPENROUTER_API_BASE, 'http://127.0.0.1:4010/openrouter-proxy/v1');
    assert.deepStrictEqual(r.warnings, []);
});

test('hosted settings left in .env produce a warning on this PC', () => {
    const env = { HARNESS_PUBLIC_URL: 'https://agents.skylerfly.com', HARNESS_REQUIRE_LOGIN: '1', HARNESS_OLD_HOSTS: 'old.example.com' };
    const r = buildCommands({ platform: 'linux', env, argv: [], exists: everything });
    assert.ok(r.warnings.some(w => /HARNESS_PUBLIC_URL=https:\/\/agents\.skylerfly\.com/.test(w)));
    assert.ok(r.warnings.some(w => /HARNESS_REQUIRE_LOGIN=1/.test(w)));
    assert.ok(r.warnings.some(w => /HARNESS_OLD_HOSTS/.test(w)));
});

test('a localhost HARNESS_PUBLIC_URL is not flagged', () => {
    const r = buildCommands({ platform: 'linux', env: { HARNESS_PUBLIC_URL: 'http://localhost:3000' }, argv: [], exists: everything });
    assert.deepStrictEqual(r.warnings, []);
});

test('the Gateway falls back to this PC, not the Docker name, when the Langfuse path runs gateway-start.py', () => {
    const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-lf-1', LANGFUSE_SECRET_KEY: 'sk-lf-1', OPENROUTER_FEDERATION_POLICY_ID: 'pol_1', OPENROUTER_PROXY_KEY: 'k' };
    const gw = buildCommands({ platform: 'linux', env: KEYS, argv: [], exists: everything }).commands[0];
    assert.match(gw.command, /gateway-start\.py/);
    assert.equal(gw.env.OPENROUTER_PROXY_URL, 'http://127.0.0.1:3000');
});
