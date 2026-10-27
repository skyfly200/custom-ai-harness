const test = require('node:test');
const assert = require('node:assert');
const langfuse = require('../utils/langfuse');
const { buildCommands } = require('../scripts/start-all');

const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-lf-1', LANGFUSE_SECRET_KEY: 'sk-lf-1' };
const reqWith = (headers, extra = {}) => ({ get: (n) => headers[n.toLowerCase()], ...extra });

test('needs both keys', () => {
    assert.strictEqual(langfuse.configured({}), false);
    assert.strictEqual(langfuse.configured({ LANGFUSE_PUBLIC_KEY: 'pk' }), false);
    assert.strictEqual(langfuse.configured(KEYS), true);
});

test('host defaults to the cloud and drops a trailing slash; url prefers LANGFUSE_URL', () => {
    assert.strictEqual(langfuse.host({}), 'https://cloud.langfuse.com');
    assert.strictEqual(langfuse.host({ LANGFUSE_HOST: 'http://langfuse-web:3000/' }), 'http://langfuse-web:3000');
    assert.strictEqual(langfuse.openUrl({ LANGFUSE_HOST: 'http://langfuse-web:3000', LANGFUSE_URL: 'http://localhost:3001/' }), 'http://localhost:3001');
});

test('adds no headers without keys', () => {
    assert.deepStrictEqual(langfuse.headersFor(reqWith({}), { model: 'm' }, { env: {} }), {});
});

test('session: explicit header, else the run behind a runner request id, else none', () => {
    assert.strictEqual(langfuse.sessionOf(reqWith({ 'x-harness-session': 'chat-abc' })), 'chat-abc');
    assert.strictEqual(langfuse.sessionOf(reqWith({ 'x-harness-request-id': 'run-r7-12' })), 'run-r7');
    assert.strictEqual(langfuse.sessionOf(reqWith({ 'x-harness-request-id': 'reply-9' })), null);
    assert.strictEqual(langfuse.sessionOf(reqWith({})), null);
});

test('headers carry session, tags and redaction', () => {
    const req = reqWith({ 'x-harness-session': 'chat-1', 'x-harness-request-id': 'r1', 'x-harness-cache': 'auto' },
        { harnessClient: 'Chat page', harnessAuto: { how: 'jev' }, harnessUser: { name: 'sky ler' } });
    const h = langfuse.headersFor(req, { model: 'or-claude', profile: 'Cheap, fast', tier: 'mid' }, { env: KEYS });
    assert.strictEqual(h['x-litellm-session-id'], 'chat-1');
    assert.deepStrictEqual(h['x-litellm-tags'].split(','),
        ['client:Chat_page', 'model:or-claude', 'strategy:Cheap_fast', 'tier:mid', 'auto:jev', 'user:sky_ler', 'cache:markers', 'request:harness']);
    assert.strictEqual(h['x-litellm-enable-message-redaction'], 'true');
    assert.strictEqual(h['litellm-disable-message-redaction'], undefined);
});

test('content logging switches the redaction header', () => {
    const h = langfuse.headersFor(reqWith({}), { model: 'm' }, { env: KEYS, content: true });
    assert.strictEqual(h['litellm-disable-message-redaction'], 'true');
    assert.strictEqual(h['x-litellm-enable-message-redaction'], undefined);
    assert.strictEqual(h['x-litellm-session-id'], undefined);
});

test('status: off without keys and sends nothing', async () => {
    let called = false;
    const s = await langfuse.status({ langfuseContent: false }, {}, async () => { called = true; });
    assert.strictEqual(s.configured, false);
    assert.strictEqual(called, false);
});

test('status: connected, refused keys, unreachable', async () => {
    langfuse.resetCheck();
    assert.strictEqual((await langfuse.status({}, KEYS, async () => ({ ok: true, status: 200 }))).ok, true);
    langfuse.resetCheck();
    assert.match((await langfuse.status({}, KEYS, async () => ({ ok: false, status: 401 }))).problem, /refused/);
    langfuse.resetCheck();
    assert.match((await langfuse.status({}, KEYS, async () => { throw new Error('ECONNREFUSED'); })).problem, /ECONNREFUSED/);
    langfuse.resetCheck();
});

test('npm run all starts the Gateway through gateway-start.py only with keys', () => {
    const plain = buildCommands({ platform: 'linux', env: {}, argv: [], exists: () => true }).commands[0];
    assert.match(plain.command, /litellm --config config\.yaml$/);
    const withKeys = buildCommands({ platform: 'linux', env: KEYS, argv: [], exists: () => true }).commands[0];
    assert.match(withKeys.command, /python .*gateway-start\.py$/);
    assert.strictEqual(withKeys.env.GATEWAY_TARGET, '.gateway-config.yaml');
    assert.match(withKeys.env.GATEWAY_LITELLM, /litellm$/);
});
