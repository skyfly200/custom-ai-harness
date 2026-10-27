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
    const plain = buildCommands({ platform: 'linux', env: {}, argv: [], exists: () => true }).commands[0];
    assert.equal(plain.env.OPENROUTER_API_KEY, undefined);
});
