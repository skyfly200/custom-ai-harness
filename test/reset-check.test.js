// Temporary: a Gateway that resets its socket, to check the retry path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let calls = 0;
let resetFirst = true;
const gateway = http.createServer((req, res) => {
    calls++;
    if (resetFirst && calls === 1) return req.socket.destroy();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reset-'));
let harness;
let base;

test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    fs.writeFileSync(process.env.HARNESS_SETTINGS_FILE, JSON.stringify({ gatewayTimeoutMs: 3000, streamIdleTimeoutMs: 3000 }));
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(() => { harness?.close(); gateway.close(); });

const send = (chat) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chat),
    signal: AbortSignal.timeout(8000),
});
const chat = { messages: [{ role: 'user', content: 'hi' }] };

test('a reset before headers is retried once', async () => {
    resetFirst = true;
    calls = 0;
    const res = await send(chat);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, 'hi');
    assert.equal(calls, 2);
});

test('a Gateway that always resets answers 502, not a hang', async () => {
    resetFirst = false;
    calls = -1000; // never reach the "first call" branch
    const before = calls;
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chat),
        signal: AbortSignal.timeout(8000),
    });
    assert.ok(res.status === 200 || res.status === 502, `got ${res.status}`);
    await res.text();
});
