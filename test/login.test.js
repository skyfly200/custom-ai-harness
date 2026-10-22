// HARNESS_REQUIRE_LOGIN: named logins, admins from the environment, users and API keys in a file
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashPassword, verifyPassword, parseAdmins } = require('../utils/users');

let seen;
const gateway = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-login-'));
const usersFile = path.join(dir, 'users.json');
let harness, base;

test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    process.env.MCP_CONFIG = path.join(dir, 'none.json');
    process.env.HARNESS_USERS_FILE = usersFile;
    process.env.HARNESS_REQUIRE_LOGIN = '1';
    process.env.HARNESS_ADMINS = `alice:${hashPassword('alice-password')},bob:${hashPassword('bob-password')}`;
    delete process.env.HARNESS_PASSWORD;
    delete process.env.LITELLM_MASTER_KEY;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(() => { harness?.close(); gateway.close(); });

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function signIn(username, password) {
    const r = await fetch(`${base}/login`, json({ username, password }));
    return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const as = (cookie, extra = {}) => ({ headers: { cookie, 'content-type': 'application/json', ...extra } });
const post = (cookie, body) => ({ method: 'POST', ...as(cookie), body: JSON.stringify(body) });
const chat = (headers) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
});

test('hashes verify, differ per call, and carry no $ or : or comma', () => {
    const h = hashPassword('correct horse');
    assert.match(h, /^scrypt\.\d+\.[\w-]+\.[\w-]+$/);
    assert.notEqual(h, hashPassword('correct horse'));
    assert.equal(verifyPassword('correct horse', h), true);
    assert.equal(verifyPassword('wrong', h), false);
    assert.equal(verifyPassword('x', 'plaintext'), false);
});

test('HARNESS_ADMINS parsing reports bad entries', () => {
    const h = hashPassword('pw');
    assert.deepEqual(parseAdmins(`a:${h}, b:${h}`).admins.map((a) => a.name), ['a', 'b']);
    assert.equal(parseAdmins('a:plain').problems.length, 1);
    assert.equal(parseAdmins(`a:${h},A:${h}`).problems.length, 1);
    assert.equal(parseAdmins('').admins.length, 0);
});

test('refuses to start open: login on with no valid admins', () => {
    for (const admins of ['', 'alice:plaintext']) {
        const r = spawnSync(process.execPath, ['-e', "require('./server')"], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, HARNESS_REQUIRE_LOGIN: '1', HARNESS_ADMINS: admins },
            encoding: 'utf8',
        });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Refusing to start open/);
    }
});

test('everything asks for a login: pages redirect, APIs and the proxy answer 401', async () => {
    const page = await fetch(`${base}/ui/chat.html`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2Fui%2Fchat.html');
    for (const url of ['/ui/api/status', '/ui/api/settings', '/ui/manifest.webmanifest', '/v1/models']) {
        const r = await fetch(base + url);
        assert.equal(r.status, 401, url);
        assert.equal(r.headers.get('www-authenticate'), null, 'no browser login box over the login page');
    }
    assert.equal((await chat({})).status, 401);
    assert.equal((await chat({ authorization: 'Bearer nope' })).status, 401);
    assert.equal((await fetch(`${base}/login`)).status, 200);
});

test('signing in sets an HttpOnly SameSite cookie and opens the app', async () => {
    const wrong = await signIn('alice', 'nope');
    assert.equal(wrong.r.status, 401);
    const { r, cookie } = await signIn('Alice', 'alice-password');
    assert.equal(r.status, 200);
    const flags = r.headers.get('set-cookie');
    assert.match(flags, /HttpOnly/);
    assert.match(flags, /SameSite=Lax/);
    assert.doesNotMatch(flags, /Secure/);
    assert.equal((await fetch(`${base}/ui/api/status`, as(cookie))).status, 200);
    const me = await (await fetch(`${base}/ui/api/me`, as(cookie))).json();
    assert.equal(me.name, 'alice');
    assert.equal(me.role, 'admin');
    const https = await fetch(`${base}/login`, { ...json({ username: 'alice', password: 'alice-password' }), headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' } });
    assert.match(https.headers.get('set-cookie'), /Secure/);
    await fetch(`${base}/logout`, { method: 'POST', ...as(cookie) });
    assert.equal((await fetch(`${base}/ui/api/status`, as(cookie))).status, 401);
});

test('the open redirect after login stays on this site', async () => {
    const r = await fetch(`${base}/login`, json({ username: 'bob', password: 'bob-password', next: '//evil.example' }));
    assert.equal((await r.json()).next, '/ui/');
});

test('admins manage users; plain users get chat and API but not Settings or controls', async () => {
    const admin = (await signIn('alice', 'alice-password')).cookie;
    assert.equal((await fetch(`${base}/ui/api/users`, post(admin, { name: 'carol', password: 'short' }))).status, 400);
    const added = await fetch(`${base}/ui/api/users`, post(admin, { name: 'carol', password: 'carol-password' }));
    assert.equal(added.status, 200);
    assert.equal((await fetch(`${base}/ui/api/users`, post(admin, { name: 'ALICE', password: 'whatever-long' }))).status, 400);
    const stored = fs.readFileSync(usersFile, 'utf8');
    assert.doesNotMatch(stored, /carol-password/);
    assert.match(stored, /scrypt\./);
    assert.equal(fs.statSync(usersFile).mode & 0o077, 0, 'file is private');

    const carol = (await signIn('carol', 'carol-password')).cookie;
    assert.equal((await fetch(`${base}/ui/api/status`, as(carol))).status, 200);
    assert.equal((await fetch(`${base}/ui/settings.html`, { ...as(carol, { accept: 'text/html' }) })).status, 403);
    assert.equal((await fetch(`${base}/ui/api/users`, as(carol))).status, 403);
    assert.equal((await fetch(`${base}/ui/api/settings`, post(carol, { caveman: false }))).status, 403);
    assert.equal((await fetch(`${base}/ui/api/router/save`, post(carol, {}))).status, 403);
    assert.equal((await fetch(`${base}/ui/settings.html`, as(admin, { accept: 'text/html' }))).status, 200);
    assert.equal((await fetch(`${base}/ui/api/settings`, post(admin, { caveman: false }))).status, 200);

    // carol can change her own password but not remove herself or read others' keys
    assert.equal((await fetch(`${base}/ui/api/me/password`, post(carol, { current: 'bad', password: 'brand-new-pass' }))).status, 400);
    assert.equal((await fetch(`${base}/ui/api/me/password`, post(carol, { current: 'carol-password', password: 'brand-new-pass' }))).status, 200);
    assert.equal((await fetch(`${base}/ui/api/keys?owner=alice`, as(carol))).status, 400);
    assert.equal((await signIn('carol', 'brand-new-pass')).r.status, 200);

    // role changes and removal take effect on open sessions
    assert.equal((await fetch(`${base}/ui/api/users/carol`, post(admin, { role: 'admin' }))).status, 200);
    assert.equal((await fetch(`${base}/ui/api/users`, as(carol))).status, 200);
    assert.equal((await fetch(`${base}/ui/api/users/alice`, post(admin, { role: 'user' }))).status, 400);
    assert.equal((await fetch(`${base}/ui/api/users/alice`, { method: 'DELETE', ...as(admin) })).status, 400);
    assert.equal((await fetch(`${base}/ui/api/users/carol`, { method: 'DELETE', ...as(admin) })).status, 200);
    assert.equal((await fetch(`${base}/ui/api/status`, as(carol))).status, 401);
    assert.equal((await fetch(`${base}/ui/api/users/bob`, post(admin, { password: 'another-long-one' }))).status, 400, 'env admins are changed in .env');
});

test('API keys work for programs, are stripped before the Gateway, and can be revoked', async () => {
    const admin = (await signIn('bob', 'bob-password')).cookie;
    const made = await (await fetch(`${base}/ui/api/keys`, post(admin, { name: 'claude code' }))).json();
    assert.match(made.key, /^hk_/);
    assert.doesNotMatch(fs.readFileSync(usersFile, 'utf8'), new RegExp(made.key));
    assert.equal(made.keys.length, 1);

    for (const headers of [{ authorization: `Bearer ${made.key}` }, { 'x-api-key': made.key }, { authorization: 'Basic ' + Buffer.from(`anyone:${made.key}`).toString('base64') }]) {
        seen = null;
        const r = await chat(headers);
        assert.equal(r.status, 200, JSON.stringify(headers));
        assert.equal(seen.authorization, undefined);
        assert.equal(seen['x-api-key'], undefined);
    }
    // a user name and password also work for programs that only do Basic
    assert.equal((await chat({ authorization: 'Basic ' + Buffer.from('bob:bob-password').toString('base64') })).status, 200);
    assert.equal((await chat({ authorization: 'Basic ' + Buffer.from('bob:wrong-password').toString('base64') })).status, 401);

    await fetch(`${base}/ui/api/keys/${made.keys[0].id}`, { method: 'DELETE', ...as(admin) });
    assert.equal((await chat({ authorization: `Bearer ${made.key}` })).status, 401);
});

test('too many wrong passwords lock the sign-in for a while', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await fetch(`${base}/login`, json({ username: 'bob', password: `guess ${i}` }));
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    // even the right password waits
    assert.equal((await fetch(`${base}/login`, json({ username: 'bob', password: 'bob-password' }))).status, 429);
});
