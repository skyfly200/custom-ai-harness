const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { harnessEnv, claudeCommand, harnessUp } = require('../scripts/claude');

test('points Claude Code at the harness on this machine by default', () => {
    const env = harnessEnv({ PATH: '/bin' });
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://localhost:3000');
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'local-harness');
    assert.strictEqual(env.CLAUDE_CODE_AUTO_MODE_SERVER, '0');
    assert.strictEqual(env.HARNESS_GUARD_URL, 'http://localhost:3000/v1/guard');
    assert.strictEqual(env.PATH, '/bin', 'the rest of the environment is kept');
});

test('HARNESS_URL points it at the harness on another machine, without a trailing slash', () => {
    const env = harnessEnv({ HARNESS_URL: 'https://harness.example.com/' });
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://harness.example.com');
    assert.strictEqual(env.HARNESS_GUARD_URL, 'https://harness.example.com/v1/guard', 'the guard follows the harness');
    assert.strictEqual(harnessEnv({ HARNESS_URL: 'http://10.0.0.5:3000' }).ANTHROPIC_BASE_URL, 'http://10.0.0.5:3000');
});

test('the token is an API key, else the harness password, since that is what the harness checks', () => {
    assert.strictEqual(harnessEnv({ HARNESS_PASSWORD: 'secret' }).ANTHROPIC_AUTH_TOKEN, 'secret');
    assert.strictEqual(harnessEnv({ HARNESS_PASSWORD: 'secret', HARNESS_API_KEY: 'hk-abc' }).ANTHROPIC_AUTH_TOKEN, 'hk-abc');
});

test('a HARNESS_GUARD_URL you set yourself is left alone', () => {
    assert.strictEqual(harnessEnv({ HARNESS_GUARD_URL: 'http://other:9000/v1/guard' }).HARNESS_GUARD_URL, 'http://other:9000/v1/guard');
});

test('finds the Windows claude.cmd and the plain claude elsewhere', () => {
    assert.strictEqual(claudeCommand('win32', {}), 'claude.cmd');
    assert.strictEqual(claudeCommand('linux', {}), 'claude');
    assert.strictEqual(claudeCommand('linux', { CLAUDE_CODE_BIN: '/opt/claude' }), '/opt/claude');
});

test('the status check signs in, so a locked harness does not look down', async (t) => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, headers: req.headers });
        // What HARNESS_PASSWORD does: 401 unless the password arrives
        if (req.headers['x-harness-password'] !== 'secret') { res.writeHead(401); return res.end('{}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"components":{}}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    assert.strictEqual(await harnessUp(harnessEnv({ HARNESS_URL: base })), false, 'no password set: the harness says 401');
    assert.strictEqual(await harnessUp(harnessEnv({ HARNESS_URL: base, HARNESS_PASSWORD: 'secret' })), true);
    assert.strictEqual(seen[1].url, '/ui/api/status', 'asks the always-on dashboard route');
});

test('nothing listening means the harness is not up, not a crash', async () => {
    assert.strictEqual(await harnessUp(harnessEnv({ HARNESS_URL: 'http://127.0.0.1:9' })), false);
});
