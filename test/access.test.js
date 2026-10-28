// HARNESS_PASSWORD: every page and API asks for it, and it never reaches the Gateway
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fakeGateway } = require('./helpers/stubs');

let seen;
const gateway = fakeGateway((req) => { seen = req.headers; });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-access-'));
let harness, base;

test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    process.env.MCP_CONFIG = path.join(dir, 'none.json');
    process.env.HARNESS_PASSWORD = 'open sesame';
    delete process.env.LITELLM_MASTER_KEY;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(() => { harness?.close(); gateway.close(); });

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const chat = (headers) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
});

test('pages and APIs ask for the password, with a browser login box', async () => {
    for (const url of ['/ui/', '/ui/api/status', '/ui/api/settings']) {
        const r = await fetch(base + url);
        assert.equal(r.status, 401, url);
        assert.match(r.headers.get('www-authenticate'), /^Basic /);
    }
    assert.equal((await chat({})).status, 401);
    assert.equal((await fetch(`${base}/ui/`, { headers: { authorization: basic('me', 'wrong') } })).status, 401);
});

test('the browser login works with any user name, and opens the controls', async () => {
    assert.equal((await fetch(`${base}/ui/api/settings`, { headers: { authorization: basic('anyone', 'open sesame') } })).status, 200);
    const r = await fetch(`${base}/ui/api/settings`, {
        method: 'POST',
        headers: { authorization: basic('', 'open sesame'), 'content-type': 'application/json' },
        body: JSON.stringify({ caveman: false }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).settings.caveman, false);
});

test('agents can send it as a header, a bearer token or an API key, and it is not forwarded', async () => {
    for (const headers of [{ 'x-harness-password': 'open sesame' }, { authorization: 'Bearer open sesame' }, { 'x-api-key': 'open sesame' }]) {
        seen = null;
        const r = await chat(headers);
        assert.equal(r.status, 200, JSON.stringify(headers));
        assert.equal(seen['x-harness-password'], undefined);
        assert.equal(seen.authorization, undefined);
        assert.equal(seen['x-api-key'], undefined);
    }
});

test("a client's own provider key still reaches the Gateway alongside the password header", async () => {
    const r = await chat({ 'x-harness-password': 'open sesame', 'x-api-key': 'sk-ant-their-own' });
    assert.equal(r.status, 200);
    assert.equal(seen['x-api-key'], 'sk-ant-their-own');
});

test('the pages are served at the site root as well as under /ui, behind the same password', async () => {
    for (const url of ['/', '/chat.html', '/sw.js']) assert.equal((await fetch(base + url)).status, 401, url);
    const auth = { headers: { authorization: basic('me', 'open sesame') } };
    const root = await fetch(`${base}/`, auth);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<html/);
    assert.equal((await fetch(`${base}/chat.html`, auth)).status, 200);
    assert.equal((await fetch(`${base}/ui/chat.html`, auth)).status, 200);
    assert.equal((await fetch(`${base}/manifest.webmanifest`, auth)).status, 200);
});
