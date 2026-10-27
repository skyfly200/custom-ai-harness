// Chat sync routes against an in-memory stand-in for Postgres
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const chats = new Map(); // owner/id -> row
const data = new Map();
const db = require('../utils/db');
db.query = async (text, p) => {
    if (/FROM chats WHERE owner = \$1 ORDER/.test(text)) return { rows: [...chats.values()].filter((r) => r.owner === p[0]).map((r) => ({ id: r.id, title: r.title, project: r.project, updated: String(r.updated), deleted: r.deleted })) };
    if (/FROM user_data/.test(text)) return { rows: [...data.values()].filter((r) => r.owner === p[0]).map((r) => ({ key: r.key, value: r.value, updated: String(r.updated) })) };
    if (/SELECT data FROM chats/.test(text)) { const r = chats.get(`${p[0]}/${p[1]}`); return { rows: r && !r.deleted ? [{ data: r.data }] : [] }; }
    if (/INSERT INTO chats/.test(text)) {
        const k = `${p[0]}/${p[1]}`, old = chats.get(k);
        if (old && old.updated > p[4]) return { rows: [] };
        chats.set(k, { owner: p[0], id: p[1], title: p[2], project: p[3], updated: p[4], data: JSON.parse(p[5]), deleted: false });
        return { rows: [{ id: p[1] }] };
    }
    if (/UPDATE chats SET deleted_at/.test(text)) { const r = chats.get(`${p[0]}/${p[1]}`); if (r) { r.deleted = true; r.data = {}; } return { rows: [] }; }
    if (/INSERT INTO user_data/.test(text)) {
        const k = `${p[0]}/${p[1]}`, old = data.get(k);
        if (old && old.updated > p[3]) return { rows: [] };
        data.set(k, { owner: p[0], key: p[1], value: JSON.parse(p[2]), updated: p[3] });
        return { rows: [{ key: p[1] }] };
    }
    throw new Error(`unexpected query ${text}`);
};
const { createChatSync } = require('../utils/chatSync');

async function withApp(user, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { if (user) req.harnessUser = { name: user }; next(); });
    app.use(createChatSync());
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = (method, path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    try { await fn(call); } finally { server.close(); }
}

test('chats: save, newer wins, stale copy refused, delete', async () => {
    await withApp('alice', async (call) => {
        assert.equal((await call('PUT', '/ui/api/sync/chats/c1', { id: 'c1', title: 'one', updated: 100, messages: [] })).status, 200);
        assert.equal((await call('PUT', '/ui/api/sync/chats/c1', { id: 'c1', title: 'old', updated: 50, messages: [] })).status, 409);
        assert.equal((await (await call('GET', '/ui/api/sync/chats/c1')).json()).title, 'one');
        const list = await (await call('GET', '/ui/api/sync')).json();
        assert.deepEqual(list.chats.map((c) => [c.id, c.updated, c.deleted]), [['c1', 100, false]]);
        await call('DELETE', '/ui/api/sync/chats/c1');
        assert.equal((await call('GET', '/ui/api/sync/chats/c1')).status, 404);
        assert.equal((await (await call('GET', '/ui/api/sync')).json()).chats[0].deleted, true);
    });
});

test('chats belong to their owner', async () => {
    await withApp('alice', async (call) => { await call('PUT', '/ui/api/sync/chats/secret', { id: 'secret', title: 'mine', updated: 1, messages: [] }); });
    await withApp('bob', async (call) => {
        assert.equal((await call('GET', '/ui/api/sync/chats/secret')).status, 404);
        assert.deepEqual((await (await call('GET', '/ui/api/sync')).json()).chats, []);
    });
});

test('bad ids, bodies and data keys are refused', async () => {
    await withApp(null, async (call) => {
        assert.equal((await call('PUT', '/ui/api/sync/chats/..x', { id: '..x', updated: 1 })).status, 400);
        assert.equal((await call('PUT', '/ui/api/sync/chats/ok', { id: 'other', updated: 1 })).status, 400);
        assert.equal((await call('PUT', '/ui/api/sync/data/not-allowed', { value: 1, updated: 1 })).status, 400);
        assert.equal((await call('PUT', '/ui/api/sync/data/harness-projects', { value: [{ id: 'p' }], updated: 5 })).status, 200);
        const got = await (await call('GET', '/ui/api/sync')).json();
        assert.equal(got.owner, 'local');
        assert.deepEqual(got.data['harness-projects'], { value: [{ id: 'p' }], updated: 5 });
    });
});
