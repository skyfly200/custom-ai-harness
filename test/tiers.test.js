// More than two tiers, effort, and the images output. A fake Router answers
// with a set win rate and picks strong/weak by the threshold it was sent, like
// router.py; a fake Gateway records the model it was asked for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tiers-'));
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
const tiers = require('../utils/tiers');
const profiles = require('../utils/profiles');
const settings = require('../utils/settings');

test('tiers are cleaned and sorted from the highest cut-off down', () => {
    const t = tiers.clean([{ name: 'Mid', from: 0.3, model: 'mid' }, { name: ' Frontier ', from: '0.9', model: 'big', tools: 'big-tools' }]);
    assert.deepEqual(t, [
        { name: 'Frontier', from: 0.9, model: 'big', tools: 'big-tools' },
        { name: 'Mid', from: 0.3, model: 'mid', tools: null },
    ]);
    assert.deepEqual(tiers.clean(undefined), []);
    assert.throws(() => tiers.clean([{ name: 'Strong', from: 0.5, model: 'x' }]), /two tiers are called/);
    assert.throws(() => tiers.clean([{ name: 'A', from: 0, model: 'x' }]), /above 0 up to 1/);
    assert.throws(() => tiers.clean([{ name: 'A', from: 0.4 }]), /connect it to a model/);
    assert.throws(() => tiers.clean([{ name: 'A', from: 0.4, model: 'bad name' }]), /model name/);
});

test('a score lands in the highest tier it reaches; Strong and Weak keep their ranges', () => {
    const t = tiers.clean([{ name: 'Frontier', from: 0.9, model: 'big', tools: 'big-tools' }, { name: 'Mid', from: 0.3, model: 'mid' }]);
    assert.deepEqual(tiers.pick(t, 0.6, 0.95, false), { tier: 'Frontier', model: 'big' });
    assert.deepEqual(tiers.pick(t, 0.6, 0.95, true), { tier: 'Frontier', model: 'big-tools' });
    assert.equal(tiers.pick(t, 0.6, 0.7, false), null); // Strong
    assert.deepEqual(tiers.pick(t, 0.6, 0.4, true), { tier: 'Mid', model: 'mid' });
    assert.equal(tiers.pick(t, 0.6, 0.1, false), null); // Weak
    assert.equal(tiers.pick([], 0.6, 0.95, false), null);
});

test('effort reads names and numbers', () => {
    assert.equal(tiers.effortShift('high'), 0.2);
    assert.equal(tiers.effortShift('MIN'), -1);
    assert.equal(tiers.effortShift('-0.3'), -0.3);
    assert.equal(tiers.effortShift('7'), 1);
    assert.equal(tiers.effortShift('whatever'), 0);
    assert.equal(tiers.effortShift(undefined), 0);
});

let winRate = 0.5;
let lastRoute = null;
let lastBody = null;
const router = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        lastRoute = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: winRate >= lastRoute.threshold ? 'router-strong' : 'router-weak', win_rate: winRate }));
    });
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

async function send(headers = {}, content = 'hi') {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    await res.json();
    return res;
}

test('the default routing uses its extra tiers around the Router’s strong and weak', async () => {
    settings.update({ fixedThreshold: 0.6, tiers: [{ name: 'Frontier', from: 0.9, model: 'big' }, { name: 'Mid', from: 0.3, model: 'mid' }] });
    winRate = 0.95;
    let res = await send();
    assert.equal(lastBody.model, 'big');
    assert.equal(decodeURIComponent(res.headers.get('x-harness-tier')), 'Frontier');
    winRate = 0.7;
    await send();
    assert.equal(lastBody.model, 'router-strong');
    winRate = 0.4;
    res = await send();
    assert.equal(lastBody.model, 'mid');
    assert.match(res.headers.get('x-harness-route'), /^Mid: win rate 0.4 vs threshold 0.6/);
    winRate = 0.1;
    await send();
    assert.equal(lastBody.model, 'router-weak');
    const e = require('../utils/monitor').recentEvents(1)[0];
    assert.equal(e.tier, 'Weak');
});

test('effort moves the score, and the Router is asked with the threshold moved the other way', async () => {
    winRate = 0.5;
    await send({ 'x-harness-effort': 'high' });
    assert.equal(lastRoute.threshold, 0.4);
    assert.equal(lastBody.model, 'router-strong'); // 0.5 + 0.2 >= 0.6
    await send({ 'x-harness-effort': 'max' });
    assert.equal(lastBody.model, 'big');
    await send({ 'x-harness-effort': 'min' });
    assert.equal(lastRoute.threshold, 1);
    assert.equal(lastBody.model, 'router-weak');
    const res = await send({ 'x-harness-effort': 'low' });
    assert.equal(lastBody.model, 'mid'); // 0.3
    assert.match(res.headers.get('x-harness-route'), /effort -0.2/);
});

test('a named routing has its own tiers and images model', async () => {
    profiles.replace([{
        name: 'Ladder', down: 'free', downTools: 'free', strong: 'p-strong', weak: 'p-weak', threshold: 0.5,
        images: 'eyes', tiers: [{ name: 'Top', from: 0.8, model: 'p-top' }, { name: 'Mid', from: 0.2, model: 'p-mid', tools: 'p-mid-tools' }],
    }]);
    winRate = 0.85;
    await send({ 'x-harness-profile': 'ladder' });
    assert.equal(lastBody.model, 'p-top');
    winRate = 0.3;
    await send({ 'x-harness-profile': 'ladder' });
    assert.equal(lastBody.model, 'p-mid');
    const res = await send({ 'x-harness-profile': 'ladder' }, [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]);
    assert.equal(lastBody.model, 'eyes');
    assert.equal(decodeURIComponent(res.headers.get('x-harness-tier')), 'Images');
    // An agent request with a picture keeps its route
    await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-profile': 'ladder' },
        body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }], tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] }),
    }).then(r => r.json());
    assert.equal(lastBody.model, 'p-mid-tools');
    // Without an images model a picture is routed like any request
    await send({}, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]);
    assert.equal(lastBody.model, 'mid');
});

test('a max tier keeps the score under the next tier up', () => {
    const ts = [{ name: 'Mid', from: 0.3, model: 'm' }, { name: 'Frontier', from: 0.85, model: 'f' }];
    assert.equal(tiers.ceiling(ts, 0.6, 'mid'), 0.599);
    assert.equal(tiers.ceiling(ts, 0.6, 'Strong'), 0.849);
    assert.equal(tiers.ceiling(ts, 0.6, 'weak'), 0.299);
    assert.equal(tiers.ceiling(ts, 0.6, 'Frontier'), null, 'the top tier has no ceiling');
    assert.equal(tiers.ceiling(ts, 0.6, ''), null);
    assert.equal(tiers.ceiling(ts, 0.6, 'nope'), null);
    const pickAt = (score) => tiers.pick(ts, 0.6, Math.min(score, tiers.ceiling(ts, 0.6, 'strong')), false);
    assert.equal(pickAt(0.95), null, 'capped at Strong, so no extra tier takes it');
});
