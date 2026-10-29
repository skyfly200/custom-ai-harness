// The owner's main OpenRouter key renewed through the Management API, with a stubbed OpenRouter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mainKey = require('../utils/mainKey');

const MGMT = 'sk-or-v1-MANAGEMENTSECRET00';
const base = () => ({ OPENROUTER_URL: 'https://or.test/api/v1', OPENROUTER_MANAGEMENT_KEY: MGMT, OPENROUTER_MAIN_KEY_RENEW: '1', OPENROUTER_API_KEY: 'sk-or-v1-pastedpastedpasted1234' });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mainkey-')), 'main.json');

function fake({ valid = () => true } = {}) {
    const calls = [];
    let n = 0;
    const fetchFn = async (url, init = {}) => {
        const auth = init.headers?.authorization;
        calls.push({ url, method: init.method || 'GET', auth, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === 'POST') { n++; return Response.json({ data: { key: `sk-or-v1-main${n}main${n}main${n}main${n}`, hash: `mh${n}` } }); }
        if (init.method === 'DELETE') return Response.json({ deleted: true });
        return valid(auth) ? Response.json({ data: {} }) : new Response('{}', { status: 401 });
    };
    return { calls, fetchFn };
}

test('only on with the switch and a management key', () => {
    assert.equal(mainKey.enabled(base()), true);
    assert.equal(mainKey.enabled({ ...base(), OPENROUTER_MAIN_KEY_RENEW: '' }), false);
    assert.equal(mainKey.enabled({ ...base(), OPENROUTER_MANAGEMENT_KEY: '' }), false);
});

test('first start issues the harness\'s own key, saves it, and puts it where the proxy reads it; the pasted key is left alone', async () => {
    const env = { ...base(), OPENROUTER_MAIN_KEY_LIMIT: '50', OPENROUTER_MAIN_KEY_FILE: tmp() };
    const { calls, fetchFn } = fake();
    const r = mainKey.create({ env, store: mainKey.createStore({ env }), fetchFn });
    await r.start(); r.stop();
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-v1-main1main1main1main1');
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ name: 'harness: main', limit: 50 }]);
    assert.equal(calls[0].auth, `Bearer ${MGMT}`);
    assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'nothing deleted: the pasted key\'s hash is unknown');
    assert.equal(JSON.parse(fs.readFileSync(env.OPENROUTER_MAIN_KEY_FILE, 'utf8')).hash, 'mh1');
});

test('no limit configured: none is sent (the main key is not capped at the per-user default)', async () => {
    const env = { ...base(), OPENROUTER_MAIN_KEY_FILE: tmp() };
    const { calls, fetchFn } = fake();
    const r = mainKey.create({ env, store: mainKey.createStore({ env }), fetchFn });
    await r.start(); r.stop();
    assert.deepEqual(calls.find((c) => c.method === 'POST').body, { name: 'harness: main' });
});

test('a restart loads the saved key and does not issue another while it is good', async () => {
    const env = { ...base(), OPENROUTER_MAIN_KEY_FILE: tmp() };
    const a = fake();
    const r1 = mainKey.create({ env, store: mainKey.createStore({ env }), fetchFn: a.fetchFn });
    await r1.start(); r1.stop();
    const env2 = { ...env, OPENROUTER_API_KEY: 'sk-or-v1-pastedpastedpasted1234' };
    const b = fake();
    const r2 = mainKey.create({ env: env2, store: mainKey.createStore({ env: env2 }), fetchFn: b.fetchFn });
    await r2.start(); r2.stop();
    assert.equal(env2.OPENROUTER_API_KEY, 'sk-or-v1-main1main1main1main1');
    assert.equal(b.calls.some((c) => c.method === 'POST'), false);
});

test('refused or about to expire: a new key is saved first, then the old one deleted; once an hour', async () => {
    const env = { ...base(), OPENROUTER_MAIN_KEY_DAYS: '30', OPENROUTER_MAIN_KEY_FILE: tmp() };
    let t = Date.parse('2026-10-29T00:00:00Z');
    const now = () => t;
    const f = fake();
    let invalidated = 0;
    const r = mainKey.create({ env, store: mainKey.createStore({ env }), fetchFn: f.fetchFn, now, auth: { invalidate: () => invalidated++ } });
    await r.start(); r.stop();
    assert.equal(f.calls.find((c) => c.method === 'POST').body.expires_at, '2026-11-28T00:00:00Z');
    t += 61 * 60000;
    assert.equal(await r.renew(), true);
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-v1-main2main2main2main2');
    assert.equal(f.calls.at(-1).url, 'https://or.test/api/v1/keys/mh1');
    assert.equal(f.calls.at(-1).method, 'DELETE');
    assert.equal(invalidated, 2, "once for the first issue, once for the renewal");
    assert.equal(await r.renew(), false, 'not again within the hour');
    assert.equal(JSON.parse(fs.readFileSync(env.OPENROUTER_MAIN_KEY_FILE, 'utf8')).hash, 'mh2');
});

test('a refused key is replaced at the start; an unreachable OpenRouter is not a reason to replace', async () => {
    const env = { ...base(), OPENROUTER_MAIN_KEY_FILE: tmp() };
    fs.writeFileSync(env.OPENROUTER_MAIN_KEY_FILE, JSON.stringify({ key: 'sk-or-v1-deaddeaddeaddead1234', hash: 'old', expires: null }));
    const f = fake({ valid: (auth) => auth !== 'Bearer sk-or-v1-deaddeaddeaddead1234' });
    const r = mainKey.create({ env, store: mainKey.createStore({ env }), fetchFn: f.fetchFn });
    await r.start(); r.stop();
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-v1-main1main1main1main1');
    assert.equal(f.calls.at(-1).url, 'https://or.test/api/v1/keys/old');

    const env2 = { ...base(), OPENROUTER_MAIN_KEY_FILE: tmp() };
    fs.writeFileSync(env2.OPENROUTER_MAIN_KEY_FILE, JSON.stringify({ key: 'sk-or-v1-goodgoodgoodgood1234', hash: 'g', expires: null }));
    let posts = 0;
    const down = async (url, init = {}) => { if (init.method === 'POST') posts++; throw new Error('offline'); };
    const r2 = mainKey.create({ env: env2, store: mainKey.createStore({ env: env2 }), fetchFn: down });
    await r2.start(); r2.stop();
    assert.equal(posts, 0);
    assert.equal(env2.OPENROUTER_API_KEY, 'sk-or-v1-goodgoodgoodgood1234');
});

test('the proxy tells the renewal when OpenRouter refuses the main key, and still answers 401', async () => {
    const openrouterAuth = require('../utils/openrouterAuth');
    const express = require('express');
    const env = { OPENROUTER_PROXY_KEY: 'proxy-secret', OPENROUTER_URL: 'https://or.test/api/v1', OPENROUTER_API_KEY: 'sk-or-main' };
    let refused = 0;
    const app = express();
    app.use('/openrouter-proxy', openrouterAuth.proxyHandler(openrouterAuth.createAuth({ env }), {
        env, fetchFn: async () => new Response('{}', { status: 401 }), onBadMain: () => refused++,
    }));
    const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/openrouter-proxy/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 401);
        assert.equal(refused, 1);
    } finally { server.close(); }
});
