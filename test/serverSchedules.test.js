// Scheduled messages sent by the server, against a real (in-process) Postgres
process.env.DATABASE_URL = 'postgres://unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');
const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
        await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
})();
db.query = async (text, params) => { await ready; return pg.query(text, params); };
const serverSchedules = require('../utils/serverSchedules');
const internalAuth = require('../utils/internalAuth');
const { nextRun } = require('../ui/schedule');

const put = async (owner, key, value, updated = 1) => {
    await ready;
    if (key === 'harness-schedules') await pg.query("DELETE FROM user_data WHERE key = 'harness-schedules' AND owner <> $1", [owner]); // each test sees only its own
    await pg.query('INSERT INTO user_data (owner, key, value, updated) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (owner, key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated', [owner, key, JSON.stringify(value), updated]);
};
const schedulesOf = async (owner) => (await pg.query("SELECT value, updated FROM user_data WHERE owner = $1 AND key = 'harness-schedules'", [owner])).rows[0];
const messagesOf = async (owner, chat) => {
    const { rows } = await pg.query('SELECT msg_order FROM chats WHERE owner = $1 AND id = $2', [owner, chat]);
    const byId = new Map((await pg.query('SELECT id, data FROM chat_messages WHERE owner = $1 AND chat_id = $2', [owner, chat])).rows.map((r) => [r.id, r.data]));
    return rows[0].msg_order.map((id) => byId.get(id));
};
const NOW = Date.parse('2026-10-28T18:00:00Z');
const make = (calls, answer = 'the answer') => serverSchedules.create({ now: () => NOW, complete: async (c) => { calls.push(c); return typeof answer === 'function' ? answer(c) : { text: answer, model: 'weak' }; } });

test('a due schedule makes a chat, saves the reply and moves to the next run', async () => {
    await put('ann', 'harness-schedules', [{ id: 's1', name: 'Digest', prompt: 'Summarise today', repeat: 'daily', start: NOW - 86400000, next: NOW - 1000, target: 'new', tz: 'America/Denver' },
        { id: 's2', prompt: 'later', repeat: 'daily', start: NOW, next: NOW + 3600000, target: 'new' }]);
    const calls = [];
    const sched = make(calls);
    await Promise.all(await sched.tick());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].owner, 'ann');
    assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'Summarise today' }]);
    const list = (await schedulesOf('ann')).value;
    assert.equal(list[0].last, NOW);
    assert.ok(list[0].next > NOW);
    assert.equal(list[1].next, NOW + 3600000);
    const chats = (await pg.query("SELECT id, title FROM chats WHERE owner = 'ann'")).rows;
    assert.equal(chats.length, 1);
    assert.match(chats[0].title, /^Digest · Oct 28/);
    const [user, reply] = await messagesOf('ann', chats[0].id);
    assert.deepEqual([user.role, user.content, user.scheduled], ['user', 'Summarise today', true]);
    assert.deepEqual([reply.role, reply.content, reply.streaming, reply.model], ['assistant', 'the answer', undefined, 'weak']);
    // nothing is due now
    assert.equal((await sched.tick()).length, 0);
    assert.equal(sched.busy(), true); // schedules exist: stay awake
});

test('a schedule that just ran is not run twice, and a one-off ends', async () => {
    await put('bob', 'harness-schedules', [{ id: 'a', prompt: 'x', repeat: 'once', start: NOW - 5000, next: NOW - 1000, target: 'new', last: NOW - 30000 },
        { id: 'b', prompt: 'y', repeat: 'once', start: NOW - 5000, next: NOW - 1000, target: 'new' }]);
    const calls = [];
    await Promise.all(await make(calls).tick());
    assert.deepEqual(calls.map((c) => c.body.messages.at(-1).content), ['y']);
    assert.deepEqual((await schedulesOf('bob')).value.map((s) => s.next), [null, null]);
});

test('a stale copy loses the claim', async () => {
    await put('cy', 'harness-schedules', [{ id: 'a', prompt: 'x', repeat: 'daily', start: NOW - 1e6, next: NOW - 1000, target: 'new' }], 5);
    const calls = [];
    const sched = serverSchedules.create({
        now: () => NOW,
        complete: async (c) => { calls.push(c); return { text: 'ok' }; },
    });
    // another writer moves the row between the look and the claim
    const real = db.query;
    let moved = false;
    db.query = async (text, params) => {
        if (/^UPDATE user_data/.test(text) && !moved) { moved = true; await pg.query("UPDATE user_data SET updated = 99 WHERE owner = 'cy'"); }
        return real(text, params);
    };
    try { await Promise.all(await sched.tick()); } finally { db.query = real; }
    assert.equal(calls.length, 0);
    assert.equal(Number((await schedulesOf('cy')).updated), 99);
});

test('an existing chat: history, project instructions and routing go with the message; a failure is written into the reply', async () => {
    await put('dee', 'harness-projects', [{ id: 'p1', name: 'Work', instructions: 'Be brief.', route: 'p:cheap' }]);
    await pg.query(`INSERT INTO chats (owner, id, title, project, updated, data, msg_order, version) VALUES ('dee', 'c1', 't', 'p1', 1, '{"id":"c1","project":"p1","system":"Sys."}'::jsonb, '["m1","m2"]'::jsonb, 2)`);
    await pg.query(`INSERT INTO chat_messages (owner, chat_id, id, data) VALUES ('dee','c1','m1','{"id":"m1","role":"user","content":"hello","attachments":[{"kind":"text","name":"n.txt","text":"FILE"}]}'::jsonb), ('dee','c1','m2','{"id":"m2","role":"assistant","content":"hi"}'::jsonb)`);
    await put('dee', 'harness-schedules', [{ id: 'a', prompt: 'again', repeat: 'hourly', start: NOW - 7200000, next: NOW - 1, target: 'chat:c1' }]);
    const calls = [];
    await Promise.all(await make(calls, () => { throw new Error('HTTP 402: out of credit'); }).tick());
    assert.deepEqual(calls[0].body.messages, [
        { role: 'system', content: 'Instructions for the project "Work":\n\nBe brief.\n\nSys.' },
        { role: 'user', content: 'hello\n\n<file name="n.txt">\nFILE\n</file>' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'again' }]);
    assert.deepEqual(calls[0].headers, { 'x-harness-profile': 'cheap' });
    const msgs = await messagesOf('dee', 'c1');
    assert.equal(msgs.length, 4);
    assert.equal(msgs[2].content, 'again');
    assert.match(msgs[3].content, /scheduled run failed: HTTP 402: out of credit/);
});

test('nextRun keeps the wall-clock time through daylight saving', () => {
    const start = Date.parse('2026-03-05T16:00:00Z'); // 9:00 in Denver
    assert.equal(new Date(nextRun(start, 'daily', Date.parse('2026-03-08T20:00:00Z'), 'America/Denver')).toISOString(), '2026-03-09T15:00:00.000Z');
    assert.equal(new Date(nextRun(start, 'weekdays', Date.parse('2026-03-06T20:00:00Z'), 'America/Denver')).toISOString(), '2026-03-09T15:00:00.000Z');
    assert.equal(new Date(nextRun(start, 'weekly', Date.parse('2026-03-06T20:00:00Z'), 'America/Denver')).toISOString(), '2026-03-12T15:00:00.000Z');
    assert.equal(nextRun(start, 'once', start + 1, 'America/Denver'), null);
    assert.equal(nextRun(start, 'hourly', start + 1), start + 3600000);
    assert.equal(nextRun(start, 'daily', start - 1, 'Not/AZone'), start);
});

test('internal calls: only a valid signature from this machine counts', () => {
    const mw = internalAuth.middleware((n) => (n === 'ann' ? { name: 'ann', role: 'user' } : null));
    const run = (req) => { const res = { status(c) { this.code = c; return this; }, json() { return this; } }; let next = false; mw(req, res, () => { next = true; }); return { res, next }; };
    const base = { method: 'POST', path: '/v1/chat/completions', socket: { remoteAddress: '127.0.0.1' } };
    const good = { ...base, headers: Object.fromEntries(Object.entries(internalAuth.headersFor('ann'))) };
    const r = run(good);
    assert.ok(r.next && good.harnessInternal && good.harnessUser.name === 'ann');
    assert.equal(run({ ...base, headers: { 'x-harness-internal-user': 'ann', 'x-harness-internal-sig': 'a'.repeat(64) } }).res.code, 401);
    assert.equal(run({ ...good, socket: { remoteAddress: '10.0.0.5' } }).res.code, 401);
    assert.equal(run({ ...good, path: '/ui/api/users' }).res.code, 401);
    const none = { ...base, headers: {} };
    assert.ok(run(none).next && !none.harnessInternal);
});
