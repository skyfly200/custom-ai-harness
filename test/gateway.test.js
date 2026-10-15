// The Interceptor against a fake Gateway that is down, hangs, stalls
// mid-stream or rate-limits: every request must end with a readable error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let mode = 'ok';
let upstreamClosed = false;
const gateway = http.createServer((req, res) => {
    upstreamClosed = false;
    res.on('close', () => { upstreamClosed = true; });
    if (mode === 'hang') return;
    if (mode === 'stall') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    }
    if (mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'litellm.RateLimitError: OpenrouterException - Rate limit exceeded: free-models-per-day' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gw-'));
let harness;
let base;

test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.ROUTER_URL = 'http://127.0.0.1:9'; // nothing there: requests use the router-down model
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    fs.writeFileSync(process.env.HARNESS_SETTINGS_FILE, JSON.stringify({ gatewayTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }));
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(() => { harness?.close(); gateway.close(); });

const monitor = require('../utils/monitor');
const latest = () => monitor.recentEvents(1)[0];
const send = (url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000), // the harness must answer well before this
});
const chat = { messages: [{ role: 'user', content: 'hi' }] };
const messages = { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

test('a working Gateway answers normally', async () => {
    mode = 'ok';
    const res = await send('/v1/chat/completions', chat);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, 'hi');
});

test('a down Gateway gets an error, not a hang', async () => {
    const saved = process.env.GATEWAY_URL;
    gateway.close();
    await new Promise((r) => setTimeout(r, 50));
    const res = await send('/v1/chat/completions', chat);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /gateway down.*not answering/i);
    assert.equal(latest().errorKind, 'gateway down');
    await new Promise((r) => gateway.listen(Number(new URL(saved).port), '127.0.0.1', r));
});

test('a Gateway that never answers times out with an Anthropic-shaped error', async () => {
    mode = 'hang';
    const res = await send('/v1/messages', messages);
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.match(body.error.message, /no answer from the Gateway in 1 s/);
    assert.equal(latest().errorKind, 'timeout');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstreamClosed, true, 'the hung Gateway call is dropped');
});

test('a reply that stalls mid-stream ends with an error event', async () => {
    mode = 'stall';
    const res = await send('/v1/chat/completions', { ...chat, stream: true });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Hel/);
    assert.match(text, /data: \{"error":\{"message":"\[harness: timeout\] the reply stopped for 1 s mid-stream"/);
    assert.equal(latest().errorKind, 'timeout');
});

test('a quota error passes through and shows as a rate limit in the log', async () => {
    mode = '429';
    const before = monitor.stats().rateLimited;
    const res = await send('/v1/chat/completions', chat);
    assert.equal(res.status, 429);
    assert.match((await res.json()).error.message, /free-models-per-day/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(latest().errorKind, 'rate limit');
    assert.match(latest().error, /free-models-per-day/);
    assert.equal(monitor.stats().rateLimited, before + 1);
});

test('a client that stops a request shows as stopped, not as an error', async () => {
    mode = 'hang';
    const errors = monitor.stats().errors;
    const ac = new AbortController();
    const pending = fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chat), signal: ac.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(latest().errorKind, 'stopped');
    assert.equal(upstreamClosed, true);
    assert.equal(monitor.stats().errors, errors);
});
