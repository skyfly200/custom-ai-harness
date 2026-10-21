// Auto routing: rules first, then Jev's rating of each routing's description,
// else the default. Unit tests, then through the Interceptor with a fake Router
// whose /ask rates a description by whether the prompt mentions its first word.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-auto-'));
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
const auto = require('../utils/autoStrategy');
const profiles = require('../utils/profiles');

const BASE = { down: 'free', downTools: 'free-tools', strong: 'mid', weak: 'tiny' };
const make = (name, extra) => profiles.clean({ ...BASE, name, ...extra });

test('x-harness-strategy works like x-harness-profile', async () => {
    profiles.replace([{ ...BASE, name: 'Quick', weak: 'quick-model', threshold: 1, rules: { words: ['quick'] } }]);
    await send('a quick question', { 'x-harness-strategy': 'auto' });
    assert.equal(lastBody.model, 'quick-model');
    await send('hello', { 'x-harness-strategy': 'quick' });
    assert.equal(lastBody.model, 'quick-model');
});

test('rules are cleaned, and a bad size range is refused', () => {
    const r = auto.cleanRules({ words: [' Refactor ', 'refactor', ''], tools: 'maybe', clients: ['Claude Code'], minTokens: '10' });
    assert.deepEqual(r, { words: ['refactor'], tools: 'any', clients: ['claude code'], minTokens: 10, maxTokens: null });
    assert.throws(() => auto.cleanRules({ minTokens: 9, maxTokens: 2 }, 'Cheap'), /Cheap: the smallest size/);
    assert.throws(() => auto.cleanRules({ minTokens: -1 }), /whole number/);
    assert.equal(auto.hasRules(make('Plain')), false);
});

test('"auto" can not be a routing name', () => {
    assert.throws(() => profiles.clean({ ...BASE, name: 'Auto' }), /different name/);
});

const req = { text: 'please refactor the parser', tools: true, client: 'Claude Code', tokens: 500 };

test('the first routing whose rules all hold wins', async () => {
    const list = [
        make('Chat only', { rules: { tools: 'no' } }),
        make('Code', { rules: { words: ['refactor', 'bug'], tools: 'yes', clients: ['claude'] } }),
        make('Also code', { rules: { words: ['refactor'] } }),
    ];
    const got = await auto.pick(list, { ...req, first: 'rules' });
    assert.equal(got.profile.name, 'Code');
    assert.equal(got.how, 'rule');
    assert.match(got.why, /“refactor” in the request, has tools, from Claude Code/);
    assert.equal((await auto.pick(list, { ...req, tools: false, first: 'rules' })).profile.name, 'Chat only');
    assert.equal((await auto.pick(list, { ...req, text: 'hello', client: 'Cursor', first: 'rules' })).profile, null);
});

test('size rules compare the request size', async () => {
    const list = [make('Big', { rules: { minTokens: 1000 } }), make('Small', { rules: { maxTokens: 100 } })];
    assert.equal((await auto.pick(list, { ...req, tokens: 5000, first: 'rules' })).profile.name, 'Big');
    assert.equal((await auto.pick(list, { ...req, tokens: 50, first: 'rules' })).profile.name, 'Small');
    assert.equal((await auto.pick(list, { ...req, first: 'rules' })).profile, null);
});

test('without a rule match Jev rates each description and the best one at or above the threshold wins', async () => {
    const list = [make('Docs', { description: 'writing docs' }), make('Code', { description: 'editing code' }), make('Silent')];
    const asked = [];
    const ask = async (text, questions) => {
        asked.push(questions);
        return { q0: 0.2, q1: 0.8 };
    };
    const got = await auto.pick(list, { ...req, ask });
    assert.equal(got.profile.name, 'Code');
    assert.equal(got.how, 'jev');
    assert.equal(got.why, 'Jev 80%');
    assert.deepEqual(Object.keys(asked[0]), ['q0', 'q1'], 'a routing with no description is not asked about');
    assert.match(asked[0].q1, /editing code/);
    const low = await auto.pick(list, { ...req, ask: async () => ({ q0: 0.2, q1: 0.4 }) });
    assert.equal(low.profile, null);
    assert.match(low.why, /best was 40%/);
    assert.equal((await auto.pick(list, { ...req, ask: async () => ({ q0: 0.2, q1: 0.4 }), askAt: 0.3 })).profile.name, 'Code');
});

test('with first: rules, rules win over Jev; Jev off, failing or without descriptions means the default', async () => {
    const list = [make('Docs', { description: 'writing docs' }), make('Code', { rules: { words: ['refactor'] } })];
    let calls = 0;
    const ask = async () => { calls++; return { q0: 0.99 }; };
    assert.equal((await auto.pick(list, { ...req, ask, first: 'rules' })).profile.name, 'Code');
    assert.equal(calls, 0);
    const none = { ...req, text: 'hello' };
    assert.equal((await auto.pick(list, { ...none, ask, jev: false })).profile, null);
    const down = await auto.pick(list, { ...none, ask: async () => { throw new Error('Router down'); } });
    assert.equal(down.profile, null);
    assert.match(down.why, /Jev unavailable \(Router down\)/);
    assert.equal((await auto.pick([make('Code', { rules: { words: ['zzz'] } })], { ...none, ask })).profile, null);
    assert.equal(calls, 0, 'Jev is only asked when a routing has a description to rate');
});

test('by default Jev is asked first and the rules only apply when it finds no fit', async () => {
    const list = [make('Docs', { description: 'writing docs' }), make('Code', { rules: { words: ['refactor'] } })];
    const hit = await auto.pick(list, { ...req, ask: async () => ({ q0: 0.9 }) });
    assert.equal(hit.profile.name, 'Docs');
    assert.equal(hit.how, 'jev');
    const miss = await auto.pick(list, { ...req, ask: async () => ({ q0: 0.1 }) });
    assert.equal(miss.profile.name, 'Code');
    assert.equal(miss.how, 'rule');
    const down = await auto.pick(list, { ...req, ask: async () => { throw new Error('Router down'); } });
    assert.equal(down.profile.name, 'Code', 'rules still work with Jev down');
    const off = await auto.pick(list, { ...req, jev: false, ask: async () => { throw new Error('never asked'); } });
    assert.equal(off.profile.name, 'Code');
    const none = await auto.pick(list, { ...req, text: 'hello', ask: async () => ({ q0: 0.1 }) });
    assert.equal(none.profile, null);
    assert.match(none.why, /best was 10%/);
});

// ---- through the Interceptor ----

let lastBody = null;
let asks = 0;
const router = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/ask') {
            asks++;
            const { text, questions } = JSON.parse(data);
            const answers = {};
            for (const [k, q] of Object.entries(questions)) answers[k] = text.includes(q.split('like: ')[1].split(/[ ?]/)[0]) ? 0.9 : 0.1;
            return res.end(JSON.stringify({ answers }));
        }
        res.end(JSON.stringify({ model: 'router-strong', win_rate: 0.9 }));
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

async function send(content, headers = { 'x-harness-profile': 'auto' }) {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    await res.json();
    return res;
}

test('Auto picks a routing by Jev, then by rule, else the default, and the log says how', async () => {
    profiles.replace([
        { ...BASE, name: 'Quick', weak: 'quick-model', threshold: 1, rules: { words: ['quick'] } },
        { ...BASE, name: 'Poems', weak: 'poem-model', threshold: 1, description: 'poetry' },
    ]);
    const monitor = require('../utils/monitor');

    let res = await send('a quick question');
    assert.equal(lastBody.model, 'quick-model');
    assert.equal(decodeURIComponent(res.headers.get('x-harness-profile')), 'Quick');
    assert.match(decodeURIComponent(res.headers.get('x-harness-auto')), /^rule: “quick” in the request/);
    assert.equal(asks, 1, 'Jev was asked first and found no fit');
    assert.equal(monitor.recentEvents(1)[0].auto.how, 'rule');

    res = await send('poetry about the sea');
    assert.equal(lastBody.model, 'poem-model');
    assert.match(decodeURIComponent(res.headers.get('x-harness-auto')), /^jev: Jev 90%/);
    assert.equal(monitor.recentEvents(1)[0].profile, 'Poems');

    res = await send('something else');
    assert.equal(lastBody.model, 'router-strong');
    assert.equal(res.headers.get('x-harness-profile'), null);
    assert.match(decodeURIComponent(res.headers.get('x-harness-auto')), /^default:/);
    assert.equal(monitor.recentEvents(1)[0].auto.how, 'default');

    // no "auto" header: no Auto, nothing recorded
    res = await send('a quick question', {});
    assert.equal(res.headers.get('x-harness-auto'), null);
});

test('Auto honours the autoJev setting', async () => {
    const settings = require('../utils/settings');
    settings.update({ autoJev: false });
    const before = asks;
    await send('poetry about the sea');
    assert.equal(lastBody.model, 'router-strong');
    assert.equal(asks, before);
    settings.update({ autoJev: true, autoFirst: 'rules' });
    await send('a quick question');
    assert.equal(lastBody.model, 'quick-model');
    assert.equal(asks, before, 'rules first: a rule held, Jev not asked');
    settings.update({ autoFirst: 'jev' });
    assert.throws(() => settings.update({ autoFirst: 'both' }), /autoFirst/);
    assert.throws(() => settings.update({ autoAskAt: 2 }), /autoAskAt/);
});
