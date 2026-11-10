// The assistant: commands, notes, per-conversation history, the file store, and the loopback model call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const assistant = require('../utils/assistant');
const internalAuth = require('../utils/internalAuth');

const echo = async (messages) => `you said: ${messages[messages.length - 1].content}`;

test('notes can be saved, listed and forgotten', async () => {
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: echo, owner: 'Skyler' });
    assert.equal(await a.handle('web:Skyler', '/notes'), 'No notes yet. Use /remember TEXT to add one.');
    assert.equal(await a.handle('web:Skyler', '/remember I prefer metric units'), 'Saved note 1.');
    assert.equal(await a.handle('telegram:42', '/remember Dentist on Friday'), 'Saved note 2.');
    assert.equal(await a.handle('web:Skyler', '/notes'), '1. I prefer metric units\n2. Dentist on Friday');
    assert.equal(await a.handle('web:Skyler', '/forget 1'), 'Forgot note 1.');
    assert.equal(await a.handle('web:Skyler', '/forget 1'), 'Give the number of a note from /notes, for example /forget 2.');
    assert.deepEqual(a.notes().map((n) => n.text), ['Dentist on Friday']);
});

test('a note reaches the model in the system prompt of every conversation', async () => {
    const seen = [];
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async (messages) => { seen.push(messages); return 'ok'; }, owner: 'Skyler', name: 'Max' });
    await a.handle('web:Skyler', '/remember Call my sister on Sundays');
    await a.handle('slack:C1', 'hello');
    const system = seen[0][0];
    assert.equal(system.role, 'system');
    assert.match(system.content, /You are Max, a personal assistant for Skyler/);
    assert.match(system.content, /- Call my sister on Sundays/);
});

test('history carries across turns in one conversation and stays apart between conversations', async () => {
    const seen = [];
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async (messages) => { seen.push(messages.map((m) => m.role + ':' + m.content)); return `r${seen.length}`; }, owner: 'S' });
    assert.equal(await a.handle('telegram:1', 'first'), 'r1');
    assert.equal(await a.handle('telegram:1', 'second'), 'r2');
    assert.equal(await a.handle('telegram:2', 'other'), 'r3');
    assert.deepEqual(seen[1].slice(1), ['user:first', 'assistant:r1', 'user:second'].map((x) => x));
    assert.deepEqual(seen[2].slice(1), ['user:other']);
});

test('/reset starts a new conversation but keeps the notes', async () => {
    const seen = [];
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async (messages) => { seen.push(messages); return 'ok'; }, owner: 'S' });
    await a.handle('web:S', 'hi');
    await a.handle('web:S', '/remember keep me');
    assert.match(await a.handle('web:S', '/reset'), /Saved notes are kept/);
    await a.handle('web:S', 'after reset');
    assert.equal(seen[1].length, 2); // system + the new user message only
    assert.equal(a.notes().length, 1);
});

test('a failed model call says so and stores nothing for that turn', async () => {
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async () => { throw new Error('upstream down'); }, owner: 'S' });
    assert.match(await a.handle('web:S', 'hello'), /could not get an answer just now \(upstream down\)/);
    assert.deepEqual(a.history('web:S'), []);
});

test('turns in one conversation run in order even when they overlap', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const a = assistant.createAssistant({
        store: assistant.memoryStore(),
        ask: async (messages) => { seen.push(messages.length); if (seen.length === 1) await gate; return 'ok'; },
        owner: 'S',
    });
    const first = a.handle('slack:C', 'one');
    const second = a.handle('slack:C', 'two');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 1);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(seen, [2, 4]); // the second turn saw the first one's exchange
});

test('the file store saves and reloads, and refuses to overwrite a file it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assistant-'));
    const file = path.join(dir, 'assistant.json');
    const store = assistant.fileStore(file);
    const a = assistant.createAssistant({ store, ask: echo, owner: 'S' });
    return a.handle('web:S', '/remember persisted').then(async () => {
        const again = assistant.createAssistant({ store: assistant.fileStore(file), ask: echo, owner: 'S' });
        assert.deepEqual(again.notes().map((n) => n.text), ['persisted']);
        fs.writeFileSync(file, '{ not json');
        const broken = assistant.createAssistant({ store: assistant.fileStore(file), ask: echo, owner: 'S' });
        await assert.rejects(broken.handle('web:S', '/remember more'));
        assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    });
});

test('loopbackAsk calls this server as the owner, signed, and reads the reply', async () => {
    let got = null;
    const server = http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            got = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(data) };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'hello back' } }] }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const ask = assistant.loopbackAsk({ owner: 'Skyler', port: server.address().port, profile: 'work' });
        const reply = await ask([{ role: 'user', content: 'hi' }]);
        assert.equal(reply.content, 'hello back');
        assert.deepEqual(reply.tool_calls, []);
        assert.equal(got.url, '/v1/chat/completions');
        assert.equal(got.method, 'POST');
        assert.equal(got.body.stream, false);
        assert.equal(got.headers['x-harness-internal-user'], 'Skyler');
        assert.equal(got.headers['x-harness-profile'], 'work');
        assert.equal(got.headers['x-harness-internal-sig'], internalAuth.sign('Skyler'));
    } finally {
        server.close();
    }
});

test('loopbackAsk turns an error status into an error the assistant reports', async () => {
    const fetchImpl = async () => new Response('no route', { status: 503 });
    const ask = assistant.loopbackAsk({ owner: 'S', fetchImpl });
    await assert.rejects(ask([]), /answered 503: no route/);
    const json = assistant.loopbackAsk({ owner: 'S', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'gateway down', code: 502 } }), { status: 502 }) });
    await assert.rejects(json([]), (err) => err.message === 'the harness answered 502: gateway down');
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask, owner: 'S' });
    assert.match(await a.handle('web:S', 'hi'), /could not get an answer just now/);
});

test('a web message bills the logged-in person; a channel message bills the configured owner', async () => {
    const billed = [];
    const a = assistant.createAssistant({
        store: assistant.memoryStore(),
        ask: async (messages, { owner }) => { billed.push(owner); return 'ok'; },
        owner: 'Skyler',
    });
    await a.handle('web:Dana', 'hi', { owner: 'Dana' });
    await a.handle('telegram:42', 'hi');
    assert.deepEqual(billed, ['Dana', 'Skyler']);
});

test('loopbackAsk signs the request for the person it is told to bill', async () => {
    let headers = null;
    const ask = assistant.loopbackAsk({ owner: 'Skyler', fetchImpl: async (url, init) => { headers = init.headers; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); } });
    await ask([], { owner: 'Dana' });
    assert.equal(headers['x-harness-internal-user'], 'Dana');
    assert.equal(headers['x-harness-internal-sig'], internalAuth.sign('Dana'));
});
