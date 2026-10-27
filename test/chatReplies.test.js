// The server keeping a reply for a page that has gone, against a real (in-process) Postgres
process.env.DATABASE_URL = 'postgres://unused';
process.env.HARNESS_REPLY_SAVE_DELAY_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');
const usage = require('../utils/usage');

const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
        await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
})();
db.query = async (text, params) => { await ready; return pg.query(text, params); };
const replies = require('../utils/chatReplies');

const chatWith = async (id, order, messages = []) => {
    await ready;
    await pg.query(`INSERT INTO chats (owner, id, title, updated, data, msg_order, version) VALUES ('local', $1, 't', 1, '{}'::jsonb, $2::jsonb, 3)`, [id, JSON.stringify(order)]);
    for (const m of messages) await pg.query(`INSERT INTO chat_messages (owner, chat_id, id, data) VALUES ('local', $1, $2, $3::jsonb)`, [id, m.id, JSON.stringify(m)]);
};
const row = async (chat, id) => (await pg.query('SELECT data FROM chat_messages WHERE chat_id = $1 AND id = $2', [chat, id])).rows[0]?.data;
const version = async (chat) => Number((await pg.query('SELECT version FROM chats WHERE id = $1', [chat])).rows[0].version);
const settle = () => new Promise((r) => setTimeout(r, 150));
const request = (chat, message) => ({ headers: { 'x-harness-chat-id': chat, 'x-harness-message-id': message } });

test('a reply the page never saved is added to the chat after its last message', async () => {
    await chatWith('r1', ['u1'], [{ id: 'u1', role: 'user', content: 'hi' }]);
    replies.afterReply(request('r1', 'a1'), { text: 'hello there', model: 'strong' });
    await settle();
    assert.equal((await row('r1', 'a1')).content, 'hello there');
    assert.deepEqual((await pg.query("SELECT msg_order FROM chats WHERE id = 'r1'")).rows[0].msg_order, ['u1', 'a1']);
    assert.equal(await version('r1'), 4);
});

test('a copy the page left half-streamed is replaced; a finished one is left alone', async () => {
    await chatWith('r2', ['u1', 'a1', 'a2'], [{ id: 'u1', role: 'user', content: 'q' }, { id: 'a1', role: 'assistant', content: 'par', streaming: true },
        { id: 'a2', role: 'assistant', content: 'the page finished this', rounds: [1] }]);
    replies.afterReply(request('r2', 'a1'), { text: 'partial and the rest', model: 'm' });
    replies.afterReply(request('r2', 'a2'), { text: 'server copy', model: 'm' });
    await settle();
    assert.equal((await row('r2', 'a1')).content, 'partial and the rest');
    assert.equal((await row('r2', 'a2')).content, 'the page finished this');
});

test('a reply cut off by the page closing says so', async () => {
    await chatWith('r3', ['u1']);
    replies.afterReply(request('r3', 'a1'), { text: 'half an ans', model: 'm', aborted: true });
    await settle();
    assert.match((await row('r3', 'a1')).content, /^half an ans\n\n\*\(cut off/);
});

test('nothing is written for a chat the server does not have, a deleted chat, empty text or bad ids', async () => {
    replies.afterReply(request('nochat', 'a1'), { text: 'x' });
    await chatWith('r4', []);
    await pg.query("UPDATE chats SET deleted_at = now() WHERE id = 'r4'");
    replies.afterReply(request('r4', 'a1'), { text: 'x' });
    replies.afterReply(request('r4', 'a1'), { text: '   ' });
    replies.afterReply(request('bad id', 'a1'), { text: 'x' });
    replies.afterReply({ headers: {} }, { text: 'x' });
    await settle();
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM chat_messages WHERE chat_id IN ('nochat', 'r4')")).rows[0].n, 0);
    assert.equal(replies.busy(), false);
});

function reply(headers, chunks) {
    const res = new EventEmitter();
    res.headers = headers;
    return { res, play: () => { for (const c of chunks) res.emit('data', Buffer.from(c)); res.emit('end'); } };
}
const tapText = (headers, chunks, abort) => new Promise((resolve) => {
    const { res, play } = reply(headers, chunks);
    usage.tap(res, resolve);
    if (abort) { for (const c of chunks) res.emit('data', Buffer.from(c)); res.emit('aborted'); } else play();
});

test('tap collects the words from OpenAI and Anthropic streams and from whole replies', async () => {
    const sse = { 'content-type': 'text/event-stream' };
    const openai = await tapText(sse, ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n']);
    assert.equal(openai.text, 'Hello');
    assert.equal(openai.aborted, false);
    const anthropic = await tapText(sse, ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi "}}\n\n', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"there"}}\n\n']);
    assert.equal(anthropic.text, 'Hi there');
    assert.equal((await tapText({ 'content-type': 'application/json' }, ['{"choices":[{"message":{"content":"whole"}}]}'])).text, 'whole');
    assert.equal((await tapText({ 'content-type': 'application/json' }, ['{"type":"message","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}'])).text, 'ab');
});

test('tap says when the reply was cut off', async () => {
    const out = await tapText({ 'content-type': 'text/event-stream' }, ['data: {"choices":[{"delta":{"content":"half"}}]}\n\n'], true);
    assert.equal(out.text, 'half');
    assert.equal(out.aborted, true);
});
