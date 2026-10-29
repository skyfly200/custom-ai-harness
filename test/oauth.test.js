// Invite-only sign-in with Google/GitHub through Neon Auth, with a fake Neon Auth and an in-memory Users store
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Users } = require('../utils/users');
const { createOAuth, cookieHeaderFrom } = require('../utils/oauth');

const env = { NEON_AUTH_BASE_URL: 'https://neon.example/auth', HARNESS_ADMIN_EMAILS: 'boss@example.com' };
const newUsers = () => new Users({ admins: [], store: { data: { users: [], keys: [], invites: [] }, save() {} } });

function fakeNeon(session) {
    const calls = [];
    const fetchFn = async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith('/sign-in/social')) {
            const headers = new Headers({ 'content-type': 'application/json' });
            headers.append('set-cookie', 'neon.session_challenge=abc; Path=/; HttpOnly');
            headers.append('set-cookie', 'neon.session_challange=abc; Path=/; HttpOnly');
            return new Response(JSON.stringify({ url: 'https://accounts.example/consent', redirect: true }), { status: 200, headers });
        }
        return new Response(JSON.stringify(session), { status: session ? 200 : 401 });
    };
    return { fetchFn, calls };
}

async function run(users, session, fn) {
    const sessions = [];
    const { fetchFn, calls } = fakeNeon(session);
    const app = express();
    app.use(createOAuth({ users, env, fetchFn, safeNext: (n) => (typeof n === 'string' && n.startsWith('/') ? n : '/ui/'), startSession: (req, res, name) => sessions.push(name) }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try { await fn({ base, sessions, calls }); } finally { server.close(); }
}

const noFollow = (url, headers) => new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location, cookies: res.headers['set-cookie'] || [] }); }).on('error', reject);
});

test('cookieHeaderFrom keeps only name=value', () => {
    assert.equal(cookieHeaderFrom(['a=1; Path=/; HttpOnly', 'b=2; Secure']), 'a=1; b=2');
});

test('an invited email signs in; the challenge cookie from Neon is sent back with the verifier', async () => {
    const users = newUsers();
    users.addInvite('Friend@Example.com');
    await run(users, { user: { email: 'friend@example.com', emailVerified: true } }, async ({ base, sessions, calls }) => {
        const start = await noFollow(`${base}/auth/google?next=/ui/chat.html`);
        assert.equal(start.status, 302);
        assert.equal(start.location, 'https://accounts.example/consent');
        const nonce = start.cookies[0].split(';')[0];
        const done = await noFollow(`${base}/auth/callback?neon_auth_session_verifier=v1`, { cookie: nonce });
        assert.equal(done.status, 302);
        assert.equal(done.location, '/ui/chat.html');
        assert.deepEqual(sessions, ['friend']);
        const get = calls.find((c) => c.url.includes('/get-session'));
        assert.match(get.url, /neon_auth_session_verifier=v1/);
        assert.equal(get.init.headers.cookie, 'neon.session_challenge=abc; neon.session_challange=abc');
        // the one-time nonce is spent
        const again = await noFollow(`${base}/auth/callback?neon_auth_session_verifier=v1`, { cookie: nonce });
        assert.equal(again.status, 400);
    });
});

test('an email nobody invited is refused and no session starts', async () => {
    await run(newUsers(), { user: { email: 'stranger@example.com', emailVerified: true } }, async ({ base, sessions }) => {
        const start = await noFollow(`${base}/auth/google`);
        const done = await noFollow(`${base}/auth/callback?neon_auth_session_verifier=v`, { cookie: start.cookies[0].split(';')[0] });
        assert.equal(done.status, 403);
        assert.deepEqual(sessions, []);
    });
});

test('HARNESS_ADMIN_EMAILS signs in as an admin without an invite; an unverified email is refused', async () => {
    const users = newUsers();
    await run(users, { user: { email: 'boss@example.com', emailVerified: true } }, async ({ base, sessions }) => {
        const start = await noFollow(`${base}/auth/google`);
        await noFollow(`${base}/auth/callback?neon_auth_session_verifier=v`, { cookie: start.cookies[0].split(';')[0] });
        assert.deepEqual(sessions, ['boss']);
        assert.equal(users.find('boss').role, 'admin');
    });
    users.addInvite('late@example.com');
    await run(users, { user: { email: 'late@example.com', emailVerified: false } }, async ({ base, sessions }) => {
        const start = await noFollow(`${base}/auth/google`);
        const done = await noFollow(`${base}/auth/callback?neon_auth_session_verifier=v`, { cookie: start.cookies[0].split(';')[0] });
        assert.equal(done.status, 403);
        assert.deepEqual(sessions, []);
    });
});

test('a provider that is not offered, or a callback with no start, is refused', async () => {
    await run(newUsers(), null, async ({ base }) => {
        assert.equal((await noFollow(`${base}/auth/github`)).status, 404);
        assert.equal((await noFollow(`${base}/auth/callback?neon_auth_session_verifier=v`)).status, 400);
    });
});

test('invites: duplicates and bad addresses are refused; removing one works', () => {
    const users = newUsers();
    users.addInvite('a@b.co', 'admin');
    assert.throws(() => users.addInvite('A@B.co'), /already invited/);
    assert.throws(() => users.addInvite('nope'), /email/);
    assert.equal(users.forEmail('a@b.co').role, 'admin');
    users.removeInvite('a@b.co');
    assert.equal(users.forEmail('zzz@b.co'), null);
});

test('when Neon refuses the address, the message names it and Neon\'s reason', async () => {
    const app = express();
    const refuse = async () => new Response(JSON.stringify({ error: 'Invalid callbackURL', code: 'INVALID_CALLBACKURL' }), { status: 403 });
    app.use(createOAuth({ users: newUsers(), env: { ...env, HARNESS_PUBLIC_URL: 'https://old.example' }, fetchFn: refuse, safeNext: (n) => n, startSession() {} }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
        const html = await (await fetch(`http://127.0.0.1:${server.address().port}/auth/google`)).text();
        assert.match(html, /https:\/\/old\.example/);
        assert.match(html, /INVALID_CALLBACKURL/);
    } finally { server.close(); }
});
