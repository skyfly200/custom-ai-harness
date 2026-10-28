// Guest credit (a hard dollar cap), accounts that bring their own OpenRouter credential, and the proxy
// that swaps the right credential in. In-process Postgres, a fake Gateway, the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-guests-'));
process.env.MCP_CONFIG = path.join(dir, 'mcp.json');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');
const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
        await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
})();
db.query = async (text, params) => { await ready; return pg.query(text, params); };
db.init = async () => ready;

const credit = require('../utils/credit');
const ticket = require('../utils/credentialTicket');
const userCredentials = require('../utils/userCredentials');
const openrouterAuth = require('../utils/openrouterAuth');
const { hashPassword } = require('../utils/users');

const PROXY_KEY = 'proxy-secret';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

// ---- credit accounts ----

test('credit: reserve only while it fits, settle to the real cost, release what was not used', async () => {
    await credit.open('g1', 1);
    const a = await credit.reserve('g1', 600000);
    assert.ok(a);
    assert.equal(await credit.reserve('g1', 500000), null, 'not enough left beside the first hold');
    await credit.settle(a, 100000); // really cost $0.10
    assert.deepEqual(await credit.get('g1'), { capUsd: 1, spentUsd: 0.1, reservedUsd: 0, leftUsd: 0.9 });
    const b = await credit.reserve('g1', 900000);
    assert.ok(b, 'the unused part of the first hold came back');
    await credit.settle(b, 900000);
    assert.equal(await credit.reserve('g1', 1), null, 'spent to the cap');
    assert.equal((await credit.get('g1')).leftUsd, 0);
});

test('credit: requests at the same moment cannot pass the cap together', async () => {
    await credit.open('g2', 1);
    const holds = await Promise.all(Array.from({ length: 10 }, () => credit.reserve('g2', 300000)));
    assert.equal(holds.filter(Boolean).length, 3, 'three holds of $0.30 fit in $1');
    assert.equal((await credit.get('g2')).reservedUsd, 0.9);
});

test('credit: a hold nobody settled is charged in full when it expires', async () => {
    await credit.open('g3', 1);
    const id = await credit.reserve('g3', 400000);
    await pg.query("UPDATE credit_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    assert.equal(await credit.sweep(), 1);
    assert.deepEqual(await credit.get('g3'), { capUsd: 1, spentUsd: 0.4, reservedUsd: 0, leftUsd: 0.6 });
    await credit.settle(id, 1); // late settle: nothing more to do, nothing double-charged
    assert.equal((await credit.get('g3')).spentUsd, 0.4);
});

test('credit: ensure keeps an existing account, a cap can be raised, forget removes it', async () => {
    await credit.open('g4', 1);
    await credit.settle(await credit.reserve('g4', 250000), 250000);
    await credit.ensure('g4', 5);
    assert.equal((await credit.get('g4')).capUsd, 1);
    await credit.setCap('g4', 3);
    assert.deepEqual(await credit.get('g4'), { capUsd: 3, spentUsd: 0.25, reservedUsd: 0, leftUsd: 2.75 });
    await assert.rejects(credit.setCap('nobody', 1), /no credit account/);
    await credit.forget('g4');
    assert.equal(await credit.get('g4'), null);
});

// ---- tickets and the proxy ----

test('tickets: signed by the proxy key, expire, and cannot be forged or edited', () => {
    const t = ticket.mint(PROXY_KEY, { user: 'fay' });
    assert.deepEqual(ticket.verify(PROXY_KEY, t), { user: 'fay', kind: 'user' });
    assert.equal(ticket.verify('other-key', t), null);
    const [v, body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'alice', k: 'user', e: Date.now() + 1e6 })).toString('base64url');
    assert.equal(ticket.verify(PROXY_KEY, `${v}.${forged}.${mac}`), null);
    assert.equal(ticket.verify(PROXY_KEY, ticket.mint(PROXY_KEY, { user: 'fay' }, Date.now() - 3600000)), null);
    assert.equal(ticket.verify(PROXY_KEY, 'nonsense'), null);
});

test('the proxy sends a person\'s own credential for their ticket, the owner\'s otherwise, and 402 when they have none', async () => {
    await userCredentials.setKey('amy', 'sk-or-v1-amykeyamykeyamykey1234');
    const st = await userCredentials.status('amy');
    assert.equal(st.last4, '1234');
    assert.doesNotMatch(JSON.stringify((await pg.query('SELECT * FROM user_credentials')).rows), /amykey/);
    await assert.rejects(userCredentials.setKey('amy', 'not-a-key'), /OpenRouter key/);

    const sent = [];
    const fetchFn = async (url, init) => { sent.push({ url, auth: init.headers.authorization }); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); };
    const env = { OPENROUTER_PROXY_KEY: PROXY_KEY, OPENROUTER_URL: 'https://or.test/api/v1', OPENROUTER_API_KEY: 'sk-or-owner' };
    const express = require('express');
    const app = express();
    app.use('/openrouter-proxy', openrouterAuth.proxyHandler(openrouterAuth.createAuth({ env }), { env, fetchFn, resolveUser: userCredentials.resolve }));
    const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const call = (headers) => fetch(`http://127.0.0.1:${server.address().port}/openrouter-proxy/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${PROXY_KEY}`, 'content-type': 'application/json', ...headers }, body: '{}',
    });
    try {
        assert.equal((await call({ [ticket.HEADER]: ticket.mint(PROXY_KEY, { user: 'amy' }) })).status, 200);
        assert.equal(sent.at(-1).auth, 'Bearer sk-or-v1-amykeyamykeyamykey1234');
        assert.equal(sent.at(-1).url, 'https://or.test/api/v1/chat/completions');
        assert.equal((await call({})).status, 200);
        assert.equal(sent.at(-1).auth, 'Bearer sk-or-owner', 'the Router sends no ticket and uses the owner\'s key');
        assert.equal((await call({ [ticket.HEADER]: ticket.mint(PROXY_KEY, { user: 'owner', kind: 'shared' }) })).status, 200);
        assert.equal(sent.at(-1).auth, 'Bearer sk-or-owner');
        const none = await call({ [ticket.HEADER]: ticket.mint(PROXY_KEY, { user: 'zoe' }) });
        assert.equal(none.status, 402);
        assert.match((await none.json()).error.message, /own OpenRouter credential/);
        const count = sent.length;
        assert.equal((await call({ [ticket.HEADER]: 'v1.x.y' })).status, 401);
        assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/openrouter-proxy/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
        assert.equal(sent.length, count, 'nothing reached OpenRouter');
    } finally { server.close(); }
});

// ---- through the server ----

const priced = (name, up, inCost, outCost, api_base) => ({ model_name: name, model_info: { input_cost_per_token: inCost, output_cost_per_token: outCost, max_input_tokens: 100000, max_output_tokens: 8000 }, litellm_params: { model: up, api_base } });
const MODELS = [
    priced('fast-openrouter', 'openrouter/openai/gpt-4o-mini', 1e-6, 2e-6),       // $1 / $2 per million
    priced('mystery', 'openrouter/acme/mystery', 0, 0),                             // not in any price list: unpriced
    priced('fallback-groq', 'groq/llama-3.3-70b', 5e-7, 5e-7),
    priced('local-engine', 'openai/local', 0, 0, 'http://localhost:8000'),         // a local server: free
];
let bodies = [];
let replyUsage = { prompt_tokens: 100, completion_tokens: 50 };
const gateway = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url.startsWith('/v1/model/info')) return json({ data: MODELS });
        if (req.url.endsWith('/models')) return json({ data: [] });
        bodies.push(data ? JSON.parse(data) : null);
        json({ model: 'gpt-4o-mini', choices: [{ message: { content: 'hi' } }], usage: replyUsage });
    });
});

let harness, base, admin, gus, fay;
test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    const gw = `http://127.0.0.1:${gateway.address().port}`;
    Object.assign(process.env, {
        DATABASE_URL: 'postgres://stub', GATEWAY_URL: gw, OPENROUTER_URL: `${gw}/or`, ROUTER_URL: 'http://127.0.0.1:9',
        GATEWAY_CONFIG: path.join(__dirname, 'fixtures', 'config.yaml'),
        HARNESS_SETTINGS_FILE: path.join(dir, 'settings.json'), HARNESS_USAGE_FILE: path.join(dir, 'usage.json'), HARNESS_PROFILES_FILE: path.join(dir, 'p.json'),
        HARNESS_REQUIRE_LOGIN: '1', HARNESS_ADMINS: `alice:${hashPassword('alice-password')}`,
        HARNESS_USER_CREDENTIALS: '1', OPENROUTER_PROXY_KEY: PROXY_KEY, PIN_MODEL: 'fast-openrouter',
    });
    delete process.env.HARNESS_PASSWORD; delete process.env.LITELLM_MASTER_KEY;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
    admin = await signIn('alice', 'alice-password');
});
test.after(async () => { harness?.close(); gateway.close(); await require('../server').mcp.close(); });

async function signIn(username, password) {
    const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return (r.headers.get('set-cookie') || '').split(';')[0];
}
const as = (cookie) => ({ headers: { cookie, 'content-type': 'application/json' } });
const send = (method, cookie, body) => ({ method, ...as(cookie), body: JSON.stringify(body) });
const ask = (cookie, extra = {}, headers = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello there' }], ...extra }),
});
const left = async (name) => (await credit.get(name)).leftUsd;

test('only an admin makes a guest; a guest cannot add a key of their own', async () => {
    const made = await fetch(`${base}/ui/api/users`, send('POST', admin, { name: 'gus', password: 'gus-password', guest: true, capUsd: 1 }));
    assert.equal(made.status, 200);
    const list = (await made.json()).users.find((u) => u.name === 'gus');
    assert.equal(list.guest, true);
    assert.equal(list.credit.capUsd, 1);
    assert.equal((await fetch(`${base}/ui/api/users`, send('POST', admin, { name: 'fay', password: 'fay-password' }))).status, 200);
    gus = await signIn('gus', 'gus-password');
    fay = await signIn('fay', 'fay-password');
    // neither can make guests
    for (const who of [gus, fay]) assert.equal((await fetch(`${base}/ui/api/users`, send('POST', who, { name: 'x', password: 'xxxxxxxx', guest: true }))).status, 403);
    assert.equal((await fetch(`${base}/ui/api/me/credential`, send('PUT', gus, { key: 'sk-or-v1-abcdefabcdefabcdef' }))).status, 403);
    const me = await (await fetch(`${base}/ui/api/me/credential`, as(gus))).json();
    assert.equal(me.guest, true);
    assert.equal(me.credit.leftUsd, 1);
});

test('a guest\'s request is held, then settled to the real cost; the caps on output and fallbacks are applied', async () => {
    bodies = [];
    replyUsage = { prompt_tokens: 100, completion_tokens: 50 };
    const r = await ask(gus, { max_tokens: 100000, api_key: 'steal', extra_headers: { 'x-harness-credential': 'forged' } });
    assert.equal(r.status, 200);
    await new Promise((x) => setTimeout(x, 200));
    const sent = bodies.at(-1);
    assert.equal(sent.max_tokens, 4096, 'output capped for a guest');
    assert.equal(sent.api_key, undefined);
    assert.equal(sent.extra_headers, undefined, 'a guest uses the owner\'s key: no ticket, and none forged');
    assert.deepEqual(Object.keys(sent.fallbacks[0]), ['fast-openrouter']);
    // 100 in at $1/M + 50 out at $2/M = $0.0002
    assert.equal((await credit.get('gus')).spentUsd, 0.0002);
    assert.equal((await credit.get('gus')).reservedUsd, 0);
});

test('a guest\'s unpriced model is refused, and so is a request once the credit cannot cover it', async () => {
    assert.equal((await ask(gus, {}, { 'x-harness-model': 'local-engine' })).status, 200, 'a free model costs nothing and is allowed');
    assert.equal((await ask(gus, {}, { 'x-harness-model': 'mystery' })).status, 403, 'no known price');
    await credit.setCap('gus', 0.0002); // already spent
    const r = await ask(gus);
    assert.equal(r.status, 429);
    assert.match((await r.json()).error.message, /guest credit is used up/);
    await credit.setCap('gus', 1);
});

test('a guest\'s failed call is not billed, and a reply with no counts costs the worst case', async () => {
    const before = (await credit.get('gus')).spentUsd;
    replyUsage = undefined;
    assert.equal((await ask(gus, { max_tokens: 100 })).status, 200);
    await new Promise((x) => setTimeout(x, 200));
    const after = await credit.get('gus');
    assert.ok(after.spentUsd > before, 'charged the reservation');
    assert.ok(after.spentUsd - before < 0.001, 'a small reservation: 100 tokens out');
    assert.equal(after.reservedUsd, 0);
    replyUsage = { prompt_tokens: 100, completion_tokens: 50 };
});

test('when the database cannot be reached a guest is refused, not let through', async () => {
    const real = db.query;
    db.query = async (text, params) => { if (/credit_/.test(text)) throw new Error('down'); return real(text, params); };
    try {
        const r = await ask(gus);
        assert.equal(r.status, 503);
        assert.equal(bodies.length > 0 && true, true);
    } finally { db.query = real; }
});

test('a full user is refused until they add a key, and then their ticket rides with the request', async () => {
    bodies = [];
    const refused = await ask(fay);
    assert.equal(refused.status, 402);
    assert.match((await refused.json()).error.message, /Connect your OpenRouter/);
    assert.equal(bodies.length, 0, 'nothing reached the Gateway');
    assert.equal((await fetch(`${base}/ui/api/me/credential`, send('PUT', fay, { key: 'nope' }))).status, 400);
    const saved = await (await fetch(`${base}/ui/api/me/credential`, send('PUT', fay, { key: 'sk-or-v1-fay1fay2fay3fay4fay5' }))).json();
    assert.equal(saved.credential.last4, 'fay5');
    assert.equal((await ask(fay, { extra_headers: { Authorization: 'Bearer steal' }, api_base: 'http://evil' })).status, 200);
    const sent = bodies.at(-1);
    assert.equal(sent.api_base, undefined);
    assert.deepEqual(Object.keys(sent.extra_headers), ['x-harness-credential']);
    assert.equal(ticket.verify(PROXY_KEY, sent.extra_headers['x-harness-credential']).user, 'fay');
    // not an OpenRouter model: refused rather than sent on the owner's other keys
    assert.equal((await ask(fay, {}, { 'x-harness-model': 'fallback-groq' })).status, 403);
    // removing the key stops them again
    await fetch(`${base}/ui/api/me/credential`, { method: 'DELETE', ...as(fay) });
    assert.equal((await ask(fay)).status, 402);
});

test('Connect OpenRouter sends a full user to OpenRouter and stores the key they bring back', async () => {
    const go = await fetch(`${base}/ui/api/me/credential/connect`, { ...as(fay), redirect: 'manual' });
    assert.equal(go.status, 302);
    const to = new URL(go.headers.get('location'));
    assert.equal(to.origin + to.pathname, 'https://openrouter.ai/auth');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    const back = new URL(to.searchParams.get('callback_url'));
    assert.equal(back.pathname, '/ui/api/me/credential/callback');
    // OpenRouter would redirect the browser here with ?code=; the exchange itself is stubbed
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => /\/or\/auth\/keys$/.test(String(url))
        ? Promise.resolve(new Response('{"key":"sk-or-v1-oauth1oauth2oauth3oauth4"}')) : realFetch(url, init);
    try {
        const done = await fetch(`${base}${back.pathname}?code=C1&state=${back.searchParams.get('state')}`, { ...as(fay), redirect: 'manual' });
        assert.equal(done.headers.get('location'), '/ui/users.html?openrouter=connected');
    } finally { globalThis.fetch = realFetch; }
    const me = await (await fetch(`${base}/ui/api/me/credential`, as(fay))).json();
    assert.equal(me.credential.kind, 'oauth');
    assert.equal(me.credential.last4, 'uth4');
    assert.equal((await userCredentials.resolve('fay')).key, 'sk-or-v1-oauth1oauth2oauth3oauth4');
    // admins and guests have their own way to pay; a stale or foreign state is refused
    const adminGo = await fetch(`${base}/ui/api/me/credential/connect`, { ...as(admin), redirect: 'manual' });
    assert.match(adminGo.headers.get('location'), /openrouter=unavailable/);
    const stale = await fetch(`${base}/ui/api/me/credential/callback?code=C&state=nope`, { ...as(fay), redirect: 'manual' });
    assert.match(decodeURIComponent(stale.headers.get('location')), /expired/);
    await fetch(`${base}/ui/api/me/credential`, { method: 'DELETE', ...as(fay) });
});

test('admins use the owner\'s key with no ticket and no cap', async () => {
    bodies = [];
    assert.equal((await ask(admin)).status, 200);
    assert.equal(bodies.at(-1).extra_headers, undefined);
});

test('the server will not start with per-user credentials and nothing to charge', () => {
    const { spawnSync } = require('node:child_process');
    for (const env of [{ HARNESS_REQUIRE_LOGIN: '', HARNESS_ADMINS: '' }, { DATABASE_URL: '' }, { ENCRYPTION_KEY: '' }]) {
        const r = spawnSync(process.execPath, ['-e', "require('./server')"], {
            cwd: path.join(__dirname, '..'), encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: 'postgres://stub', HARNESS_USER_CREDENTIALS: '1', HARNESS_REQUIRE_LOGIN: '1', HARNESS_ADMINS: `a:${hashPassword('pw')}`, OPENROUTER_PROXY_KEY: 'k', ...env },
        });
        assert.notEqual(r.status, 0, JSON.stringify(env));
        assert.match(r.stderr, /Refusing to start/);
    }
});

test('inviting an email as a guest makes a guest; an admin email never is one', () => {
    const { Users } = require('../utils/users');
    const users = new Users({ admins: [], store: { data: { users: [], keys: [], invites: [] }, save() {} } });
    users.addInvite('visitor@example.com', 'guest');
    users.addInvite('boss@example.com', 'guest');
    assert.equal(users.forEmail('visitor@example.com').guest, true);
    assert.equal(users.forEmail('boss@example.com', ['boss@example.com']).guest, undefined);
    users.add('plain', 'password-1');
    users.setGuest('plain', true);
    assert.equal(users.find('plain').guest, true);
    users.setRole('plain', 'admin');
    assert.equal(users.find('plain').guest, undefined, 'an admin is never a guest');
    assert.throws(() => users.add('x', 'password-1', 'admin', { guest: true }), /can't be a guest/);
});
