const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const auth = require('../utils/openrouterAuth');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-auth-'));
const tokenFile = path.join(tmp, 'jwt');
fs.writeFileSync(tokenFile, 'idp.jwt.one\n');

// A stand-in for OpenRouter: /oauth/token and one API path
function fakeOpenRouter(opts = {}) {
    const log = { exchanges: [], calls: [] };
    let n = 0;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.post('/api/v1/oauth/token', (req, res) => {
        log.exchanges.push(req.body);
        if (opts.status) return res.status(opts.status).json({ error: 'invalid_grant', error_description: 'policy paused' });
        res.json({ access_token: `or-token-${++n}`, token_type: 'Bearer', expires_in: opts.expiresIn ?? 900, scope: 'inference' });
    });
    app.post('/api/v1/chat/completions', (req, res) => {
        log.calls.push({ authorization: req.headers.authorization, body: req.body });
        res.json({ ok: true, echo: req.body });
    });
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${server.address().port}/api/v1` }));
    });
}

const env = (url, extra = {}) => ({ OPENROUTER_URL: url, OPENROUTER_FEDERATION_POLICY_ID: 'pol_1', OPENROUTER_FEDERATION_TOKEN_FILE: tokenFile, ...extra });

test('without a policy id the static key is used and nothing is exchanged', async () => {
    const a = auth.createAuth({ env: { OPENROUTER_API_KEY: ' sk-or-static ' } });
    assert.equal(await a.key(), 'sk-or-static');
    assert.deepEqual(a.status(), { mode: 'key', ok: true });
    assert.equal(auth.createAuth({ env: {} }).configured(), false);
});

test('exchanges the identity provider JWT for a token, caches it, and renews before it expires', async () => {
    const or = await fakeOpenRouter();
    let t = 1_000_000;
    const a = auth.createAuth({ env: env(or.url), now: () => t });
    assert.equal(await a.key(), 'or-token-1');
    assert.equal(await a.key(), 'or-token-1');
    assert.equal(or.log.exchanges.length, 1);
    assert.deepEqual(or.log.exchanges[0], {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        federation_policy_id: 'pol_1',
        subject_token: 'idp.jwt.one',
    });
    assert.equal(a.status().expiresInSec, 900);
    fs.writeFileSync(tokenFile, 'idp.jwt.two');
    t += (900 - 61) * 1000; // still more than a minute left
    assert.equal(await a.key(), 'or-token-1');
    t += 2 * 1000;          // inside the last minute
    assert.equal(await a.key(), 'or-token-2');
    assert.equal(or.log.exchanges[1].subject_token, 'idp.jwt.two', 'the file is read again for each exchange');
    or.server.close();
});

test('requests arriving together share one exchange', async () => {
    const or = await fakeOpenRouter();
    const a = auth.createAuth({ env: env(or.url) });
    const keys = await Promise.all([a.key(), a.key(), a.key()]);
    assert.deepEqual(keys, ['or-token-1', 'or-token-1', 'or-token-1']);
    assert.equal(or.log.exchanges.length, 1);
    or.server.close();
});

test('a refused exchange says why, and is not retried for a few seconds', async () => {
    const or = await fakeOpenRouter({ status: 400 });
    let t = 5_000_000;
    const a = auth.createAuth({ env: env(or.url), now: () => t });
    await assert.rejects(a.key(), /HTTP 400.*policy paused/);
    await assert.rejects(a.key(), /policy paused/);
    assert.equal(or.log.exchanges.length, 1);
    assert.equal(a.status().ok, false);
    t += 6000;
    await assert.rejects(a.key(), /policy paused/);
    assert.equal(or.log.exchanges.length, 2);
    or.server.close();
});

test('the JWT can come from a URL (bare or JSON, with headers) or a command', async () => {
    const or = await fakeOpenRouter();
    const idp = express();
    idp.get('/token', (req, res) => req.headers['metadata-flavor'] === 'Google' ? res.json({ token: 'from.url.jwt' }) : res.status(403).end());
    const server = await new Promise((r) => { const s = idp.listen(0, '127.0.0.1', () => r(s)); });
    const url = `http://127.0.0.1:${server.address().port}/token`;
    await auth.createAuth({ env: { OPENROUTER_URL: or.url, OPENROUTER_FEDERATION_POLICY_ID: 'p', OPENROUTER_FEDERATION_TOKEN_URL: url, OPENROUTER_FEDERATION_TOKEN_HEADERS: 'Metadata-Flavor: Google' } }).key();
    assert.equal(or.log.exchanges.at(-1).subject_token, 'from.url.jwt');
    await auth.createAuth({ env: { OPENROUTER_URL: or.url, OPENROUTER_FEDERATION_POLICY_ID: 'p', OPENROUTER_FEDERATION_TOKEN_COMMAND: 'node -e "process.stdout.write(\'from.cmd.jwt\')"' } }).key();
    assert.equal(or.log.exchanges.at(-1).subject_token, 'from.cmd.jwt');
    await assert.rejects(auth.createAuth({ env: { OPENROUTER_URL: or.url, OPENROUTER_FEDERATION_POLICY_ID: 'p', OPENROUTER_FEDERATION_TOKEN_URL: url } }).key(), /HTTP 403/);
    server.close(); or.server.close();
});

test('settings problems are named', () => {
    assert.match(auth.problems({ OPENROUTER_FEDERATION_POLICY_ID: 'p' })[0], /where the identity provider/);
    assert.match(auth.problems({ OPENROUTER_FEDERATION_POLICY_ID: 'p', OPENROUTER_FEDERATION_TOKEN_FILE: 'a', OPENROUTER_FEDERATION_TOKEN_URL: 'b' })[0], /only one/);
    assert.deepEqual(auth.problems({}), []);
});

test('the proxy swaps the caller\'s key for the current token and rejects other callers', async () => {
    const or = await fakeOpenRouter();
    const e = env(or.url, { OPENROUTER_PROXY_KEY: 'local-key' });
    const app = express();
    app.use('/openrouter-proxy', auth.proxyHandler(auth.createAuth({ env: e }), { env: e }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/openrouter-proxy/v1/chat/completions`;
    const post = (key) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: 'm', messages: [] }) });

    assert.equal((await post('wrong')).status, 401);
    assert.equal((await post()).status, 401);
    assert.equal(or.log.calls.length, 0);
    const ok = await post('local-key');
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).echo, { model: 'm', messages: [] });
    assert.equal(or.log.calls[0].authorization, 'Bearer or-token-1');
    server.close(); or.server.close();
});

test('the proxy is shut without a key, and reports a failed sign-in as 502', async () => {
    const or = await fakeOpenRouter({ status: 400 });
    const open = { ...env(or.url) };
    const keyed = { ...open, LITELLM_MASTER_KEY: 'sk-master' };
    const app = express();
    app.use('/shut', auth.proxyHandler(auth.createAuth({ env: open }), { env: open }));
    app.use('/keyed', auth.proxyHandler(auth.createAuth({ env: keyed }), { env: keyed }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const at = (p, key) => fetch(`http://127.0.0.1:${server.address().port}${p}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await at('/shut', 'x')).status, 503);
    const failed = await at('/keyed', 'sk-master');
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error.message, /policy paused/);
    server.close(); or.server.close();
});
