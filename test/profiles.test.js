// Named routings: saved next to the default routing and picked per request
// with x-harness-profile. A fake Router scores every request 0.9 (or is down)
// and a fake Gateway records the body it was sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-profiles-'));
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
const profiles = require('../utils/profiles');

const CHEAP = {
    name: 'Cheap and quick', down: 'free', downTools: 'free-tools', strong: 'mid', weak: 'tiny',
    tools: 'tiny-tools', threshold: 0.95, caveman: false, headroom: true, contextAnchor: false, mcpOff: ['github', 'github'],
};

test('a routing is cleaned: id from its name, models required unless pinned, duplicates dropped', () => {
    const p = profiles.clean(CHEAP);
    assert.equal(p.id, 'cheap-and-quick');
    assert.equal(p.caveman, false);
    assert.equal(p.maxTokens, null);
    assert.deepEqual(p.mcpOff, ['github']);
    assert.throws(() => profiles.clean({ ...CHEAP, strong: null }), /connect “strong”/);
    assert.equal(profiles.clean({ ...CHEAP, strong: null, weak: null, pin: 'one' }).pin, 'one');
    assert.throws(() => profiles.clean({ ...CHEAP, name: 'Default' }), /different name/);
    assert.throws(() => profiles.clean({ ...CHEAP, threshold: 2 }), /threshold/);
    assert.throws(() => profiles.clean({ ...CHEAP, overflow: 'big' }), /token limit/);
    assert.throws(() => profiles.clean({ ...CHEAP, weak: 'bad name!' }), /model name/);
});

test('a routing picks like the Router does', () => {
    const p = profiles.clean({ ...CHEAP, overflow: 'big', maxTokens: 100 });
    assert.equal(profiles.pick(p, 0.96, 0.95, 10, false), 'mid');
    assert.equal(profiles.pick(p, 0.5, 0.95, 10, true), 'tiny-tools');
    assert.equal(profiles.pick(p, 0.5, 0.95, 500, false), 'big');
    assert.equal(profiles.pick(p, 0.5, 0.95, 10, false), 'tiny');
});

test('replacing routings saves them, refuses two with one name and a stale version', () => {
    const { version } = profiles.state();
    assert.throws(() => profiles.replace([CHEAP, { ...CHEAP }], version), /Two routings/);
    assert.throws(() => profiles.replace([CHEAP], version + 5), /changed since/);
    profiles.replace([CHEAP], version);
    assert.equal(JSON.parse(fs.readFileSync(process.env.HARNESS_PROFILES_FILE, 'utf8')).profiles[0].id, 'cheap-and-quick');
    profiles.load();
    assert.equal(profiles.get('cheap-and-quick').name, 'Cheap and quick');
    assert.equal(profiles.get('nope'), null);
});

// ---- through the Interceptor ----

let routerUp = true;
let lastBody = null;
const router = http.createServer((req, res) => {
    if (!routerUp) { res.writeHead(500); return res.end('down'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'router-strong', win_rate: 0.9 }));
});
const gateway = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        lastBody = JSON.parse(data || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
});
let harness, base;

test.before(async () => {
    await new Promise((r) => router.listen(0, '127.0.0.1', r));
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.ROUTER_URL = `http://127.0.0.1:${router.address().port}`;
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});
test.after(() => { harness?.close(); router.close(); gateway.close(); });

async function send(headers = {}, body = { messages: [{ role: 'user', content: 'hi' }] }) {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    await res.json();
    return res;
}

test('without a routing the Router picks and caveman is on', async () => {
    routerUp = true;
    const res = await send();
    assert.equal(lastBody.model, 'router-strong');
    assert.equal(res.headers.get('x-harness-profile'), null);
    assert.ok(lastBody.messages.some(m => m.role === 'system'), 'caveman line added');
});

test('a routing uses its own outputs, threshold and compression', async () => {
    profiles.replace([CHEAP]);
    const res = await send({ 'x-harness-profile': 'cheap-and-quick' });
    assert.equal(lastBody.model, 'tiny'); // 0.9 < its threshold 0.95
    assert.equal(decodeURIComponent(res.headers.get('x-harness-profile')), 'Cheap and quick');
    assert.ok(!lastBody.messages.some(m => m.role === 'system'), 'caveman off in this routing');
    const monitor = require('../utils/monitor');
    const e = monitor.recentEvents(1)[0];
    assert.equal(e.profile, 'Cheap and quick');
    assert.deepEqual(e.transforms, ['headroom']);
});

test('a routing with the Router down uses its own Router-down models', async () => {
    routerUp = false;
    await send({ 'x-harness-profile': 'cheap-and-quick' }, { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] });
    assert.equal(lastBody.model, 'free-tools');
    routerUp = true;
});

test('a pinned routing skips the Router; a model header still wins; an unknown routing is the default', async () => {
    profiles.replace([{ ...CHEAP, pin: 'just-this' }]);
    const res = await send({ 'x-harness-profile': 'cheap-and-quick' });
    assert.equal(lastBody.model, 'just-this');
    assert.match(res.headers.get('x-harness-route'), /pinned in routing Cheap and quick/);
    await send({ 'x-harness-profile': 'cheap-and-quick', 'x-harness-model': 'direct' });
    assert.equal(lastBody.model, 'direct');
    await send({ 'x-harness-profile': 'nope' });
    assert.equal(lastBody.model, 'router-strong');
});

test('the routing editor reads and replaces routings over the API', async () => {
    const got = await (await fetch(`${base}/ui/api/profiles`)).json();
    assert.equal(got.profiles[0].id, 'cheap-and-quick');
    const bad = await fetch(`${base}/ui/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: got.version, profiles: [{ name: 'x' }] }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/ui/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: got.version, profiles: [] }) });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).profiles, []);
});
