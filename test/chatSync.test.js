// Chat sync routes against a real Postgres (PGlite) running the repo migrations
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');
// A real (in-process) Postgres, with the repo's own migrations applied
const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
        await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
})();
db.query = async (text, params) => { await ready; return pg.query(text, params); };
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

const msg = (id, content, time) => ({ id, role: id.startsWith('a') ? 'assistant' : 'user', content, time });
const meta = (id, updated, extra = {}) => ({ id, title: 't', updated, ...extra });

test('delta: a new chat, then only the changed message is sent, and the order can shrink', async () => {
    await withApp('dana', async (call) => {
        let r = await call('PUT', '/ui/api/sync/chats/d1/delta', { chat: meta('d1', 10), order: ['u1', 'a1'], upserts: [msg('u1', 'hi', 1), msg('a1', 'hello', 2)], base: 0 });
        assert.deepEqual(await r.json(), { ok: true, version: 1 });
        r = await call('PUT', '/ui/api/sync/chats/d1/delta', { chat: meta('d1', 11), order: ['u1', 'a1', 'u2'], upserts: [msg('u2', 'more', 3)], base: 1 });
        assert.equal((await r.json()).version, 2);
        let got = await (await call('GET', '/ui/api/sync/chats/d1')).json();
        assert.deepEqual(got.messages.map((m) => m.id), ['u1', 'a1', 'u2']);
        assert.equal(got.messages[1].content, 'hello');
        assert.equal(got.syncVersion, 2);
        // a retry drops the last reply and writes a new one
        r = await call('PUT', '/ui/api/sync/chats/d1/delta', { chat: meta('d1', 12), order: ['u1', 'a1b'], upserts: [msg('a1b', 'again', 4)], base: 2 });
        assert.equal(r.status, 200);
        got = await (await call('GET', '/ui/api/sync/chats/d1')).json();
        assert.deepEqual(got.messages.map((m) => m.id), ['u1', 'a1b']);
        assert.equal((await pg.query("SELECT count(*)::int AS n FROM chat_messages WHERE chat_id = 'd1'")).rows[0].n, 2);
    });
});

test('delta: a save from a stale version is refused and writes nothing', async () => {
    await withApp('erin', async (call) => {
        await call('PUT', '/ui/api/sync/chats/e1/delta', { chat: meta('e1', 10), order: ['u1'], upserts: [msg('u1', 'one', 1)], base: 0 });
        await call('PUT', '/ui/api/sync/chats/e1/delta', { chat: meta('e1', 11), order: ['u1', 'a1'], upserts: [msg('a1', 'from phone', 2)], base: 1 });
        const stale = await call('PUT', '/ui/api/sync/chats/e1/delta', { chat: meta('e1', 12, { title: 'laptop' }), order: ['u1', 'u9'], upserts: [msg('u9', 'from laptop', 3)], base: 1 });
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), { ok: false, version: 2 });
        const got = await (await call('GET', '/ui/api/sync/chats/e1')).json();
        assert.deepEqual(got.messages.map((m) => m.id), ['u1', 'a1']);
        assert.equal(got.title, 't');
        // a chat the server has never seen needs base 0
        assert.equal((await call('PUT', '/ui/api/sync/chats/e2/delta', { chat: meta('e2', 1), order: [], upserts: [], base: 5 })).status, 409);
    });
});

test('delta: bad bodies are refused', async () => {
    await withApp('fay', async (call) => {
        assert.equal((await call('PUT', '/ui/api/sync/chats/f1/delta', { chat: meta('f1', 1), order: ['u1'], upserts: [], base: 'x' })).status, 400);
        assert.equal((await call('PUT', '/ui/api/sync/chats/f1/delta', { chat: meta('other', 1), order: [], upserts: [], base: 0 })).status, 400);
        assert.equal((await call('PUT', '/ui/api/sync/chats/f1/delta', { chat: meta('f1', 1), order: ['u1'], upserts: [msg('zz', 'not in order', 1)], base: 0 })).status, 400);
        assert.equal((await call('PUT', '/ui/api/sync/chats/f1/delta', { chat: meta('f1', 1), order: ['bad id!'], upserts: [], base: 0 })).status, 400);
    });
});

test('the whole-chat PUT still works and is stored as rows; delete removes them', async () => {
    await withApp('gus', async (call) => {
        await call('PUT', '/ui/api/sync/chats/g1', { id: 'g1', title: 'whole', updated: 5, messages: [msg('u1', 'a', 1), msg('a1', 'b', 2)] });
        assert.equal((await pg.query("SELECT count(*)::int AS n FROM chat_messages WHERE chat_id = 'g1'")).rows[0].n, 2);
        const got = await (await call('GET', '/ui/api/sync/chats/g1')).json();
        assert.deepEqual(got.messages.map((m) => m.content), ['a', 'b']);
        assert.equal((await call('PUT', '/ui/api/sync/chats/g1', { id: 'g1', title: 'older', updated: 1, messages: [] })).status, 409);
        await call('DELETE', '/ui/api/sync/chats/g1');
        assert.equal((await pg.query("SELECT count(*)::int AS n FROM chat_messages WHERE chat_id = 'g1'")).rows[0].n, 0);
        assert.equal((await call('GET', '/ui/api/sync/chats/g1')).status, 404);
    });
});

test('the migration splits whole-chat rows into messages, keeping order and giving id-less messages an id', async () => {
    const legacy = new PGlite();
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
    for (const f of files.filter((x) => x < '003')) await legacy.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    await legacy.query(`INSERT INTO chats (owner, id, title, updated, data) VALUES ('hal', 'h1', 'old', 9, $1::jsonb), ('hal', 'h2', 'empty', 9, '{"id":"h2","messages":[]}'::jsonb)`,
        [JSON.stringify({ id: 'h1', title: 'old', system: 'be brief', messages: [{ id: 'x1', role: 'user', content: 'q' }, { role: 'assistant', content: 'no id' }, { id: 'x3', role: 'user', content: 'again' }] })]);
    await legacy.exec(fs.readFileSync(path.join(dir, files.find((x) => x.startsWith('003'))), 'utf8'));
    const chat = (await legacy.query("SELECT data, msg_order FROM chats WHERE id = 'h1'")).rows[0];
    assert.deepEqual(chat.msg_order, ['x1', 'm2', 'x3']);
    assert.equal(chat.data.messages, undefined);
    assert.equal(chat.data.system, 'be brief');
    const rows = (await legacy.query("SELECT id, data FROM chat_messages WHERE chat_id = 'h1' ORDER BY id")).rows;
    assert.deepEqual(rows.map((r) => r.id), ['m2', 'x1', 'x3']);
    assert.equal(rows.find((r) => r.id === 'm2').data.id, 'm2');
    assert.deepEqual((await legacy.query("SELECT msg_order FROM chats WHERE id = 'h2'")).rows[0].msg_order, []);
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM chats_before_rows')).rows[0].n, 2);
    // running it again changes nothing
    await legacy.exec(fs.readFileSync(path.join(dir, files.find((x) => x.startsWith('003'))), 'utf8'));
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM chat_messages')).rows[0].n, 3);
});

test('attachments: stored apart from the chat, per owner, with limits, deleted with the chat', async () => {
    const img = 'data:image/png;base64,' + Buffer.from('not really a png').toString('base64');
    let aid;
    await withApp('alice', async (call) => {
        const r = await call('POST', '/ui/api/sync/chats/c9/attachments', { kind: 'image', name: 'a.png', body: img });
        assert.equal(r.status, 200);
        ({ id: aid } = await r.json());
        // the same bytes in the same chat are stored once
        assert.equal((await (await call('POST', '/ui/api/sync/chats/c9/attachments', { kind: 'image', name: 'a.png', body: img })).json()).id, aid);
        assert.equal((await (await call('GET', '/ui/api/sync/attachments')).json()).used, Buffer.byteLength(img));
        const got = await (await call('GET', `/ui/api/sync/chats/c9/attachments/${aid}`)).json();
        assert.deepEqual([got.kind, got.name, got.body], ['image', 'a.png', img]);
        const raw = await call('GET', `/ui/api/sync/chats/c9/attachments/${aid}/raw`);
        assert.equal(raw.headers.get('content-type'), 'image/png');
        assert.equal(Buffer.from(await raw.arrayBuffer()).toString(), 'not really a png');
        // refused: a bad kind, an image that is not a data URL
        assert.equal((await call('POST', '/ui/api/sync/chats/c9/attachments', { kind: 'video', name: 'x', body: 'y' })).status, 400);
        assert.equal((await call('POST', '/ui/api/sync/chats/c9/attachments', { kind: 'image', name: 'x', body: 'hello' })).status, 400);
    });
    await withApp('bob', async (call) => {
        assert.equal((await call('GET', `/ui/api/sync/chats/c9/attachments/${aid}`)).status, 404);
        assert.equal((await (await call('GET', '/ui/api/sync/attachments')).json()).used, 0);
    });
    await withApp('alice', async (call) => {
        await call('PUT', '/ui/api/sync/chats/c9', { id: 'c9', title: 't', updated: 1, messages: [] });
        await call('DELETE', '/ui/api/sync/chats/c9');
        assert.equal((await call('GET', `/ui/api/sync/chats/c9/attachments/${aid}`)).status, 404);
    });
});

test('attachments: per-file and per-person limits', async () => {
    process.env.HARNESS_ATTACH_MAX_MB = '0.001'; // about 1 KB a file
    process.env.HARNESS_ATTACH_QUOTA_MB = '0.002'; // about 2 KB in all
    try {
        await withApp('carol', async (call) => {
            const post = (text) => call('POST', '/ui/api/sync/chats/q1/attachments', { kind: 'text', name: 'f.txt', body: text });
            assert.equal((await post('x'.repeat(2000))).status, 413);
            assert.equal((await post('a'.repeat(1000))).status, 200);
            assert.equal((await post('b'.repeat(1000))).status, 200);
            assert.equal((await post('c'.repeat(1000))).status, 413);
        });
    } finally { delete process.env.HARNESS_ATTACH_MAX_MB; delete process.env.HARNESS_ATTACH_QUOTA_MB; }
});
