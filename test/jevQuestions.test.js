// Extra Jev questions: cleaned, put in one /ask call per request, and their
// effects (an effort lean, or a model) applied before the Router scores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-jevq-'));
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
const jq = require('../utils/jevQuestions');
const settings = require('../utils/settings');
const { fakeGateway } = require('./helpers/stubs');

test('questions are cleaned, and bad ones say what is wrong', () => {
    const q = jq.clean([{ id: ' Risky ', ask: 'Is it risky?', effort: '0.3' }, { id: 'chat', ask: 'Small talk?', from: 0.8, model: 'cheap', toolsModel: 'cheap-tools' }]);
    assert.deepEqual(q[0], { id: 'risky', ask: 'Is it risky?', from: 0.6, effort: 0.3, model: null, toolsModel: null });
    assert.deepEqual(q[1], { id: 'chat', ask: 'Small talk?', from: 0.8, effort: 0, model: 'cheap', toolsModel: 'cheap-tools' });
    assert.deepEqual(jq.clean(undefined), []);
    assert.throws(() => jq.clean([{ id: 'a', ask: 'x' }]), /needs an effect/);
    assert.throws(() => jq.clean([{ id: 'a', ask: '', effort: 0.1 }]), /needs a question/);
    assert.throws(() => jq.clean([{ id: 'A b', ask: 'x', effort: 0.1 }]), /needs a name/);
    assert.throws(() => jq.clean([{ id: 'a', ask: 'x', effort: 2 }]), /from -1 to 1/);
    assert.throws(() => jq.clean([{ id: 'a', ask: 'x', from: 0, effort: 1 }]), /bar above 0/);
    assert.throws(() => jq.clean([{ id: 'a', ask: 'x', effort: 1 }, { id: 'a', ask: 'y', effort: 1 }]), /two questions/);
    assert.throws(() => jq.clean(Array(7).fill(0).map((_, i) => ({ id: `q${i}`, ask: 'x', effort: 0.1 }))), /at most 6/);
    assert.ok(jq.PRESETS.every(p => jq.clean([p]).length === 1), 'the presets are valid');
});

test('answers at or over a bar count; efforts add, the most confident model wins', () => {
    const q = jq.clean([
        { id: 'risky', ask: 'r', effort: 0.3 }, { id: 'reason', ask: 'e', effort: 0.2, model: 'thinker' },
        { id: 'chat', ask: 'c', from: 0.7, effort: -0.4, model: 'cheap', toolsModel: 'cheap-tools' },
    ]);
    let r = jq.apply(q, { risky: 0.9, reason: 0.65, chat: 0.2 });
    assert.deepEqual([r.shift, r.model, r.by, r.hits.map(h => h.id)], [0.5, 'thinker', 'reason', ['risky', 'reason']]);
    r = jq.apply(q, { risky: 0.1, reason: 0.59, chat: 0.95 }, { tools: true });
    assert.deepEqual([r.shift, r.model], [-0.4, 'cheap-tools']);
    assert.deepEqual(jq.apply(q, {}), { shift: 0, model: null, by: null, hits: [] });
});

test('asking never throws, and clamps what comes back', async () => {
    const q = jq.clean([{ id: 'a', ask: 'x', effort: 0.1 }]);
    assert.deepEqual(await jq.ask(q, 'hi', async (t, qs) => { assert.deepEqual(qs, { a: 'x' }); return { a: 1.4 }; }), { answers: { a: 1 } });
    assert.match((await jq.ask(q, 'hi', async () => { throw new Error('Jev down'); })).error, /Jev down/);
    assert.deepEqual(await jq.ask([], 'hi', async () => ({})), { answers: {} });
});

let yes = {};
let asks = 0;
let lastRoute = null;
let lastBody = null;
const router = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        const body = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/ask') { asks++; return res.end(JSON.stringify({ answers: yes })); }
        lastRoute = body;
        res.end(JSON.stringify({ model: 0.5 >= body.threshold ? 'router-strong' : 'router-weak', win_rate: 0.5 }));
    });
});
const gateway = fakeGateway((req, body) => { lastBody = body || {}; });
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

async function send(content = 'hello') {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    await res.json();
    return res;
}

test('with no questions set, Jev is not asked anything extra', async () => {
    settings.update({ fixedThreshold: 0.6, jevQuestions: [] });
    asks = 0;
    await send();
    assert.equal(asks, 0);
    assert.equal(lastBody.model, 'router-weak');
});

test('a yes leans the effort before the Router scores; a model answer skips the Router', async () => {
    settings.update({ jevQuestions: [
        { id: 'risky', ask: 'Is it risky?', effort: 0.3 },
        { id: 'small-talk', ask: 'Small talk?', from: 0.7, effort: -0.4, model: 'cheap' },
    ] });
    yes = { risky: 0.9, 'small-talk': 0.1 };
    asks = 0;
    await send('drop the table');
    assert.equal(asks, 1);
    assert.equal(lastRoute.threshold, 0.3); // 0.6 - 0.3
    assert.equal(lastBody.model, 'router-strong');
    const e = require('../utils/monitor').recentEvents(1)[0];
    assert.deepEqual(e.asked.hits, ['risky']);
    assert.equal(e.effort, 0.3);
    yes = { risky: 0.1, 'small-talk': 0.8 };
    const res = await send('hi there');
    assert.equal(lastBody.model, 'cheap');
    assert.match(res.headers.get('x-harness-route'), /small-talk.*80%/);
    assert.equal(decodeURIComponent(res.headers.get('x-harness-tier')), 'Question');
});

test('Jev failing leaves routing as it was', async () => {
    router.close();
    await new Promise((r) => setTimeout(r, 50));
    // the Router is down for /route too, so the request falls to the down model, and says why
    await send('anything');
    const e = require('../utils/monitor').recentEvents(1)[0];
    assert.ok(e.routerError);
    assert.ok(e.asked.error);
});
