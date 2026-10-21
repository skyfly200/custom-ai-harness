// A tunnel or proxy on the same machine must not make the harness look local.
// No HARNESS_PASSWORD here; test/access.test.js covers the password itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tunnel-'));
let harness, base;

test.before(async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:9';
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    process.env.MCP_CONFIG = path.join(dir, 'none.json');
    delete process.env.HARNESS_PASSWORD;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});
test.after(() => { harness?.close(); });

const clear = (headers = {}) => fetch(`${base}/ui/api/usage/clear`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

test('on this machine with no password, everything works as before', async () => {
    assert.equal((await fetch(`${base}/ui/api/status`)).status, 200);
    assert.equal((await clear()).status, 200);
});

test('a request through a Cloudflare tunnel is refused until a password is set', async () => {
    for (const headers of [{ 'cf-connecting-ip': '203.0.113.7' }, { 'cf-ray': 'abc-LHR' }]) {
        const r = await fetch(`${base}/ui/api/status`, { headers });
        assert.equal(r.status, 403);
        assert.match((await r.json()).error, /Cloudflare tunnel.*HARNESS_PASSWORD/);
    }
});

test('controls refuse anything that came through a proxy, even from loopback', async () => {
    for (const headers of [{ 'x-forwarded-for': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' }, { 'x-real-ip': '203.0.113.7' }]) {
        assert.equal((await clear(headers)).status, 403, JSON.stringify(headers));
        assert.equal((await fetch(`${base}/ui/api/status`, { headers })).status, 200, 'reading still works');
    }
});
