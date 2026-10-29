// Usage per person through the running server: nobody sees another person's usage
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashPassword } = require('../utils/users');
const { fakeGateway } = require('./helpers/stubs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-userusage-api-'));
const usageFile = path.join(dir, 'usage.json');
// A file from before per-user tracking: rows have no `user`
fs.writeFileSync(usageFile, JSON.stringify({ since: '2026-09-01T00:00:00.000Z', rows: { old: { day: '2026-09-01', client: 'Chat page', route: 'Router', model: 'old', servedBy: 'old', provider: 'Groq', requests: 5, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, estimated: 0 } } }));
process.env.HARNESS_USAGE_FILE = usageFile;

let harness, base, gateway;
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function signIn(username, password) {
    const r = await fetch(`${base}/login`, json({ username, password }));
    return (r.headers.get('set-cookie') || '').split(';')[0];
}
const as = (cookie, extra = {}) => ({ headers: { cookie, 'content-type': 'application/json', ...extra } });
const post = (cookie, body) => ({ method: 'POST', ...as(cookie), body: JSON.stringify(body) });
const ask = (headers, text) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: text }] }),
});
const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 30)); }
    assert.fail(`timed out waiting for ${what}`);
};
const mine = async (cookie, days = 0) => (await fetch(`${base}/ui/api/usage?days=${days}`, as(cookie))).json();
const requestsOf = (summary) => summary.rows.reduce((n, r) => n + r.requests, 0);

test('start a server with logins', async () => {
    gateway = fakeGateway();
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.MCP_CONFIG = path.join(dir, 'none.json');
    process.env.HARNESS_USERS_FILE = path.join(dir, 'users.json');
    process.env.HARNESS_REQUIRE_LOGIN = '1';
    process.env.HARNESS_ADMINS = `alice:${hashPassword('alice-password')}`;
    process.env.RUNNER_TOKEN = 'runner-secret';
    delete process.env.HARNESS_PASSWORD;
    delete process.env.LITELLM_MASTER_KEY;
    delete process.env.DATABASE_URL;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(() => { harness?.close(); gateway?.close(); });

test('each person counts their own requests, from the page and from an API key', async () => {
    const alice = await signIn('alice', 'alice-password');
    for (const name of ['dave', 'erin']) {
        assert.equal((await fetch(`${base}/ui/api/users`, post(alice, { name, password: `${name}-password`, role: 'user' }))).status, 200);
    }
    const dave = await signIn('dave', 'dave-password');
    const erin = await signIn('erin', 'erin-password');
    const key = (await (await fetch(`${base}/ui/api/keys`, post(dave, { name: 'cli' }))).json()).key;

    assert.equal((await ask({ cookie: dave }, 'dave secret one')).status, 200);
    assert.equal((await ask({ authorization: `Bearer ${key}` }, 'dave secret two')).status, 200);
    assert.equal((await ask({ cookie: erin }, 'erin question')).status, 200);
    // an agent run the runner makes for dave
    assert.equal((await ask({ 'x-runner-token': 'runner-secret', 'x-harness-run-owner': 'dave', 'x-harness-request-id': 'run-abc-1' }, 'dave run step')).status, 200);

    await until(async () => requestsOf(await mine(dave)) === 3, 'dave\'s three requests');
    await until(async () => requestsOf(await mine(erin)) === 1, 'erin\'s request');

    const d = await mine(dave);
    assert.equal(d.scope.user, 'dave');
    assert.deepEqual(d.rows.map((r) => r.client).sort(), ['Agent run', 'OpenAI API client']);
    assert.equal(requestsOf(await mine(erin)), 1);
    // an admin's Usage page is also their own: alice made no requests, and the old usage is not hers
    const a = await mine(alice);
    assert.equal(requestsOf(a), 0);
    assert.equal(a.scope.user, 'alice');
});

test('the admin view totals everyone, and only admins can open it', async () => {
    const alice = await signIn('alice', 'alice-password');
    const dave = await signIn('dave', 'dave-password');
    const erin = await signIn('erin', 'erin-password');

    const all = await (await fetch(`${base}/ui/api/admin/usage?days=0`, as(alice))).json();
    const by = Object.fromEntries(all.users.map((u) => [u.user, u.requests]));
    assert.deepEqual(by, { dave: 3, erin: 1, '': 5 }, 'the old usage is under the unassigned bucket');
    assert.equal(all.login, true);
    assert.deepEqual(all.people.map((p) => p.name).sort(), ['alice', 'dave', 'erin']);
    assert.ok(all.rows.every((r) => 'user' in r) && all.daily.every((r) => 'user' in r));
    // the week view leaves the September usage out
    const week = await (await fetch(`${base}/ui/api/admin/usage?days=7`, as(alice))).json();
    assert.equal(week.users.some((u) => u.user === ''), false);

    for (const cookie of [dave, erin]) {
        const r = await fetch(`${base}/ui/api/admin/usage`, as(cookie));
        assert.equal(r.status, 403);
        assert.doesNotMatch(JSON.stringify(await r.json()), /dave|erin/);
        assert.equal((await fetch(`${base}/ui/usage-users.html`, as(cookie, { accept: 'text/html' }))).status, 403);
        assert.equal((await fetch(`${base}/ui/api/usage/clear`, post(cookie, {}))).status, 403);
    }
    assert.equal((await fetch(`${base}/ui/usage-users.html`, as(alice, { accept: 'text/html' }))).status, 200);
    assert.equal((await fetch(`${base}/ui/api/admin/usage`)).status, 401);
    assert.equal((await fetch(`${base}/ui/api/usage`)).status, 401);
    // asking for someone else's totals does nothing: the person is the signed-in one
    const sneaky = await (await fetch(`${base}/ui/api/usage?days=0&user=dave`, as(erin))).json();
    assert.equal(requestsOf(sneaky), 1);
    assert.doesNotMatch(JSON.stringify(sneaky), /dave/);
});

test('the routing log shows a member only their own requests; admins see all', async () => {
    const alice = await signIn('alice', 'alice-password');
    const dave = await signIn('dave', 'dave-password');
    const erin = await signIn('erin', 'erin-password');
    const prompts = async (cookie) => (await (await fetch(`${base}/ui/api/events?limit=50`, as(cookie))).json()).map((e) => e.prompt);
    const erinSees = await prompts(erin);
    assert.deepEqual(erinSees, ['erin question']);
    assert.equal((await prompts(dave)).length, 3);
    assert.equal((await prompts(dave)).includes('erin question'), false);
    assert.equal((await prompts(alice)).length, 4);

    // the live feed too: erin's stream carries erin's request, never dave's
    const stream = await fetch(`${base}/ui/api/live`, { headers: { cookie: erin } });
    const reader = stream.body.getReader();
    let seen = '';
    const reading = (async () => {
        const decoder = new TextDecoder();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            seen += decoder.decode(value);
            if (seen.includes('erin live')) return;
        }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await ask({ cookie: dave }, 'dave live secret');
    await ask({ cookie: erin }, 'erin live');
    await Promise.race([reading, new Promise((r) => setTimeout(r, 4000))]);
    await reader.cancel().catch(() => {});
    assert.match(seen, /erin live/);
    assert.doesNotMatch(seen, /dave live secret/);
});
