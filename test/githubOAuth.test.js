'use strict';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const oauth = require('../utils/githubOAuth');
const db = require('../utils/db');
const userGithub = require('../utils/userGithub');

const CALLBACK = 'https://agents.example.com/ui/api/me/github/callback';
const OAUTH_APP = { GITHUB_CLIENT_ID: 'Iv1.abc', GITHUB_CLIENT_SECRET: 'shh' };
const GH_APP = { ...OAUTH_APP, GITHUB_APP_SLUG: 'harness-chat' };
const stateOf = (url) => new URL(url).searchParams.get('state');

test('an OAuth App asks for the repo scope; a GitHub App asks for none and links to its install page', () => {
    const o = new URL(oauth.begin({ owner: 'amy', callback: CALLBACK, env: OAUTH_APP }));
    assert.equal(o.origin + o.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(o.searchParams.get('client_id'), 'Iv1.abc');
    assert.equal(o.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(o.searchParams.get('scope'), 'repo');
    const a = new URL(oauth.begin({ owner: 'amy', callback: CALLBACK, env: GH_APP }));
    assert.equal(a.searchParams.get('scope'), null);
    assert.equal(oauth.installUrl(GH_APP), 'https://github.com/apps/harness-chat/installations/new');
    assert.equal(oauth.installUrl(OAUTH_APP), null);
});

test('begin needs the client id and secret and a signed-in person', () => {
    assert.throws(() => oauth.begin({ owner: 'amy', callback: CALLBACK, env: {} }), /GITHUB_CLIENT_ID/);
    assert.throws(() => oauth.begin({ owner: '', callback: CALLBACK, env: OAUTH_APP }), /signed in/);
    assert.equal(oauth.configured({}), false);
    assert.equal(oauth.configured(OAUTH_APP), true);
});

test('finish trades the code once, for the same person only, and says where to go back to', async () => {
    const state = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK, back: 'chat.html', env: OAUTH_APP }));
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"access_token":"ghu_x","refresh_token":"ghr_y","expires_in":28800}'); };
    const got = await oauth.finish({ owner: 'amy', state, code: 'C1', env: OAUTH_APP, fetchFn });
    assert.deepEqual(got, { token: 'ghu_x', refresh: 'ghr_y', expiresIn: 28800, back: 'chat.html' });
    assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token');
    assert.deepEqual(calls[0].body, { client_id: 'Iv1.abc', client_secret: 'shh', code: 'C1', redirect_uri: CALLBACK });
    await assert.rejects(oauth.finish({ owner: 'amy', state, code: 'C1', env: OAUTH_APP, fetchFn }), /expired/);
    const other = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK, env: OAUTH_APP }));
    await assert.rejects(oauth.finish({ owner: 'bob', state: other, code: 'C', env: OAUTH_APP, fetchFn }), /someone else/);
    const declined = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK, env: OAUTH_APP }));
    await assert.rejects(oauth.finish({ owner: 'amy', state: declined, code: '', env: OAUTH_APP, fetchFn }), /did not send a code/);
});

test('GitHub saying 200 with an error body is a refusal', async () => {
    const state = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK, env: OAUTH_APP }));
    const fetchFn = async () => new Response('{"error":"bad_verification_code","error_description":"The code passed is incorrect or expired."}');
    await assert.rejects(oauth.finish({ owner: 'amy', state, code: 'C', env: OAUTH_APP, fetchFn }), /incorrect or expired/);
});

test('an OAuth connection is stored encrypted, a GitHub App token is renewed before it runs out, a pasted token replaces it', async () => {
    const pg = new PGlite();
    const dir = path.join(__dirname, '..', 'migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    const realQuery = db.query;
    db.query = async (text, params) => pg.query(text, params);
    try {
        await userGithub.setOAuth('amy', { token: 'ghu_first', refresh: 'ghr_first', expiresIn: 28800 }, async (t) => { assert.equal(t, 'ghu_first'); return 'amycat'; });
        const raw = (await pg.query('SELECT secret_enc, refresh_enc FROM user_github')).rows[0];
        assert.ok(!raw.secret_enc.includes('ghu_first') && !raw.refresh_enc.includes('ghr_first'));
        assert.deepEqual(await userGithub.status('amy').then((s) => [s.set, s.login, s.via]), [true, 'amycat', 'oauth']);
        let refreshed = 0;
        const refreshFn = async (r) => { refreshed++; assert.equal(r, 'ghr_first'); return { token: 'ghu_second', refresh: 'ghr_second', expiresIn: 28800 }; };
        assert.equal(await userGithub.resolve('amy', refreshFn), 'ghu_first'); // not due yet
        assert.equal(refreshed, 0);
        await pg.query("UPDATE user_github SET expires = $1", [Date.now() + 5000]); // inside the 60 s window? no: 5 s left
        const [a, b] = await Promise.all([userGithub.resolve('amy', refreshFn), userGithub.resolve('amy', refreshFn)]);
        assert.deepEqual([a, b], ['ghu_second', 'ghu_second']);
        assert.equal(refreshed, 1); // two requests, one refresh
        assert.equal(await userGithub.resolve('amy', refreshFn), 'ghu_second');
        // a failed refresh gives no token rather than a stale one
        await pg.query("UPDATE user_github SET expires = $1", [Date.now() - 1000]);
        assert.equal(await userGithub.resolve('amy', async () => { throw new Error('revoked'); }), null);
        // a pasted token replaces the connection
        await userGithub.setToken('amy', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', async () => 'amycat');
        const st = await userGithub.status('amy');
        assert.equal(st.via, 'token');
        assert.equal(await userGithub.resolve('amy', refreshFn), 'ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    } finally { db.query = realQuery; }
});
