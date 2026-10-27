// Run keys: capped, short-lived model keys for one agent run (utils/runKeys.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunKeys, costOf, unlessRunKey, UNKNOWN_PRICE } = require('../utils/runKeys');

const req = (over = {}) => ({ method: 'POST', path: '/v1/chat/completions', headers: {}, ...over });
const call = (mw, r) => new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body, passed: false }); } };
    mw(r, res, () => resolve({ passed: true, req: r }));
});

test('a key works for chat completions, is stripped from the request, and can be revoked', async () => {
    const keys = new RunKeys();
    const made = keys.create({ label: 'run r1', maxUsd: 1 });
    assert.match(made.key, /^hk_run_/);
    const mw = keys.middleware();
    const r = req({ headers: { authorization: `Bearer ${made.key}`, 'x-api-key': made.key } });
    const out = await call(mw, r);
    assert.equal(out.passed, true);
    assert.equal(r.harnessRunKey.id, made.id);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers['x-api-key'], undefined);
    assert.deepEqual(keys.revoke(made.id), { spent: 0, requests: 1 });
    assert.equal(keys.revoke(made.id), null);
    const after = await call(mw, req({ headers: { authorization: `Bearer ${made.key}` } }));
    assert.equal(after.code, 401);
});

test('a key is refused anywhere but chat completions, so the gate (which does not know it) refuses it', async () => {
    const keys = new RunKeys();
    const { key } = keys.create({ maxUsd: 1 });
    const mw = keys.middleware();
    for (const over of [{ path: '/ui/api/settings' }, { path: '/v1/guard' }, { method: 'GET' }]) {
        const r = req({ ...over, headers: { authorization: `Bearer ${key}` } });
        const out = await call(mw, r);
        assert.equal(out.passed, true);
        assert.equal(r.harnessRunKey, undefined, 'not marked, so the gate still applies');
        let gated = false;
        await new Promise((resolve) => unlessRunKey(() => { gated = true; resolve(); })(r, {}, resolve));
        assert.equal(gated, true);
    }
    const open = req({ headers: { authorization: `Bearer ${key}` } });
    await call(mw, open);
    let reached = false;
    unlessRunKey(() => { throw new Error('the gate must not run'); })(open, {}, () => { reached = true; });
    assert.equal(reached, true);
});

test('other keys and passwords are left alone', async () => {
    const keys = new RunKeys();
    const out = await call(keys.middleware(), req({ headers: { authorization: 'Bearer hk_abc' } }));
    assert.equal(out.passed, true);
    assert.equal((await call(keys.middleware(), req({ headers: { authorization: 'Bearer hk_run_forged' } }))).code, 401);
});

test('a key stops at its cap with 402 and expires', async () => {
    let now = 1000;
    const keys = new RunKeys({ now: () => now });
    const { id, key } = keys.create({ maxUsd: 0.5, ttlMinutes: 10 });
    const mw = keys.middleware();
    const send = () => call(mw, req({ headers: { authorization: `Bearer ${key}` } }));
    assert.equal((await send()).passed, true);
    keys.charge(id, 0.3);
    assert.equal((await send()).passed, true);
    keys.charge(id, 0.3);
    const over = await send();
    assert.equal(over.code, 402);
    assert.match(over.body.error, /\$0\.5 is used up/);
    const second = keys.create({ maxUsd: 5, ttlMinutes: 1 });
    now += 61000;
    const gone = await call(mw, req({ headers: { authorization: `Bearer ${second.key}` } }));
    assert.equal(gone.code, 401);
    assert.match(gone.body.error, /expired/);
});

test('a key needs a positive cap', () => {
    const keys = new RunKeys();
    for (const bad of [undefined, 0, -1, 'x']) assert.throws(() => keys.create({ maxUsd: bad }), /above 0/);
});

test('cost comes from the Gateway price, free models cost nothing, unknown prices are charged high', () => {
    const counts = { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0 };
    const price = { inputCost: 3e-6, outputCost: 15e-6, cacheReadCost: 0.3e-6 };
    assert.ok(Math.abs(costOf(price, counts) - (0.003 + 0.0015 + 0.00015)) < 1e-12);
    assert.equal(costOf({ free: true, inputCost: 0, outputCost: 0 }, counts), 0);
    assert.ok(Math.abs(costOf(null, counts) - (1000 * UNKNOWN_PRICE.inputCost + 100 * UNKNOWN_PRICE.outputCost + 500 * UNKNOWN_PRICE.inputCost)) < 1e-12);
    // listed model whose price is unknown (null) is also charged high
    assert.ok(costOf({ inputCost: null, outputCost: null }, counts) > 0.01);
});
