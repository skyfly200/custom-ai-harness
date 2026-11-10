// Every key the harness creates carries a $5 limit and a 30-day expiry unless the env says otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../utils/openrouterKeys');

const base = { OPENROUTER_URL: 'https://or.test/api/v1', OPENROUTER_MANAGEMENT_KEY: 'sk-or-v1-MANAGEMENTSECRET00' };
const DAY = 24 * 3600 * 1000;

function fake() {
    const calls = [];
    const fetchFn = async (url, init = {}) => {
        calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
        return Response.json({ data: { key: 'sk-or-v1-new1new1new1new1', hash: 'h1' } });
    };
    return { calls, fetchFn };
}

test('defaults: $5 limit and a 30-day expiry', async () => {
    assert.equal(keys.limitUsd(base), 5);
    assert.equal(keys.lifetimeDays(base), 30);
    const t = Date.parse('2026-11-03T00:00:00Z');
    const f = fake();
    const made = await keys.create('dee', { env: base, fetchFn: f.fetchFn, now: () => t });
    assert.deepEqual(f.calls[0].body, { name: 'harness: dee', limit: 5, expires_at: '2026-12-03T00:00:00Z' });
    assert.equal(made.expires, t + 30 * DAY);
});

test('env overrides the limit and the lifetime', async () => {
    const env = { ...base, OPENROUTER_USER_KEY_LIMIT: '3', OPENROUTER_USER_KEY_DAYS: '7' };
    const t = Date.parse('2026-11-03T00:00:00Z');
    const f = fake();
    await keys.create('dee', { env, fetchFn: f.fetchFn, now: () => t });
    assert.deepEqual(f.calls[0].body, { name: 'harness: dee', limit: 3, expires_at: '2026-11-10T00:00:00Z' });
});

test('a bad value falls back to the default', () => {
    assert.equal(keys.limitUsd({ OPENROUTER_USER_KEY_LIMIT: 'lots' }), 5);
    assert.equal(keys.lifetimeDays({ OPENROUTER_USER_KEY_DAYS: '-1' }), 30);
});

test('the admin setting applies when no env var is set; the env var wins', async () => {
    const keysMod = require('../utils/openrouterKeys');
    keysMod.setPolicy({ limitUsd: 25, lifetimeDays: 90 });
    assert.equal(keysMod.limitUsd(base), 25);
    assert.equal(keysMod.lifetimeDays(base), 90);
    assert.equal(keysMod.limitUsd({ ...base, OPENROUTER_USER_KEY_LIMIT: '4' }), 4);
    const t = Date.parse('2026-11-03T00:00:00Z');
    const f = fake();
    await keysMod.create('dee', { env: base, fetchFn: f.fetchFn, now: () => t });
    assert.equal(f.calls[0].body.limit, 25);
    assert.equal(f.calls[0].body.expires_at, '2027-02-01T00:00:00Z');
    keysMod.setPolicy({});
    assert.equal(keysMod.limitUsd(base), 5);
});
