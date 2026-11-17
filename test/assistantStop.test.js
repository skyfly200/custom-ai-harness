// The Stop button for a streamed reply: the abort reaches the model call, the words written so far are kept
// (marked stopped), a stopped /yes clears its question, and the page's stream reader (ui/assistant-stream.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../utils/assistant');
const { readReply, parseEvents, isAbort } = require('../ui/assistant-stream.js');

// a model call that writes some text, then waits until it is aborted
function hangingAsk(seen) {
    return (messages, opts) => new Promise((resolve, reject) => {
        seen.push(opts.signal);
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        opts.onDelta('Half of ');
        opts.onDelta('an answer');
    });
}

test('a stopped reply keeps its words, marked stopped, and passes the signal to the model call', async () => {
    const signals = [];
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: hangingAsk(signals), owner: 'S' });
    const stop = new AbortController();
    const pieces = [];
    const done = a.handle('web:S', 'tell me', { onDelta: (d) => { pieces.push(d); if (pieces.length === 2) stop.abort(); }, signal: stop.signal });
    assert.equal(await done, 'Half of an answer');
    assert.equal(signals[0], stop.signal);
    const last = a.history('web:S').at(-1);
    assert.deepEqual([last.role, last.content, last.stopped], ['assistant', 'Half of an answer', true]);
    assert.equal(a.history('web:S').at(-2).content, 'tell me');
});

test('stopped before any text: the turn is dropped, and the next message runs', async () => {
    let calls = 0;
    const ask = (m, opts) => {
        calls += 1;
        if (calls === 1) return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        return Promise.resolve('fine');
    };
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask, owner: 'S' });
    const stop = new AbortController();
    const first = a.handle('web:S', 'one', { onDelta: () => {}, signal: stop.signal });
    const second = a.handle('web:S', 'two', { onDelta: () => {} });
    setImmediate(() => stop.abort());
    assert.equal(await first, assistant.STOPPED);
    assert.equal(await second, 'fine');
    assert.deepEqual(a.history('web:S').map((m) => m.content), ['two', 'fine']);
});

test('an aborted signal stops before the next model step, after a tool ran', async () => {
    const stop = new AbortController();
    let asks = 0;
    const manager = {
        start: async () => {},
        definitions: () => [{ type: 'function', function: { name: 'calendar_list', parameters: {} } }],
        needsApproval: () => false,
        call: async () => { stop.abort(); return { text: 'two events' }; },
    };
    const ask = async (m, opts) => {
        asks += 1;
        opts.onDelta('Looking. ');
        return { content: 'Looking. ', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calendar_list', arguments: '{}' } }] };
    };
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask, tools: manager, owner: 'S' });
    assert.equal(await a.handle('web:S', 'what is on?', { onDelta: () => {}, signal: stop.signal }), 'Looking.');
    assert.equal(asks, 1, 'no model step after the stop');
    assert.equal(a.history('web:S').at(-1).stopped, true);
});

test('a stopped /yes clears its question, so an allowed call is not run twice', async () => {
    const stop = new AbortController();
    let ran = 0;
    const manager = {
        start: async () => {},
        definitions: () => [{ type: 'function', function: { name: 'routing_set', parameters: {} } }],
        needsApproval: () => true,
        call: async () => { ran += 1; return { text: 'set' }; },
    };
    let step = 0;
    const ask = (m, opts) => {
        step += 1;
        if (step === 1) return Promise.resolve({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'routing_set', arguments: '{}' } }] });
        return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask, tools: manager, owner: 'S' });
    assert.match(await a.handle('web:S', 'change routing', { onDelta: () => {}, signal: new AbortController().signal }), /approval/);
    assert.ok(a.pending('web:S'));
    const yes = a.handle('web:S', '/yes', { onDelta: () => {}, signal: stop.signal });
    setImmediate(() => stop.abort());
    assert.equal(await yes, assistant.STOPPED);
    assert.equal(ran, 1);
    assert.equal(a.pending('web:S'), null);
});

test('loopbackAsk aborts its request with the signal', async () => {
    let seen = null;
    const fetchImpl = (url, init) => { seen = init.signal; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
    const ask = assistant.loopbackAsk({ owner: 'S', fetchImpl, timeoutMs: 60000 });
    const stop = new AbortController();
    const call = ask([], { onDelta: () => {}, signal: stop.signal });
    stop.abort();
    await assert.rejects(call, (err) => err.name === 'AbortError');
    assert.equal(seen.aborted, true);
});

test('/notes WORDS lists the notes with all those words, ignoring case and accents', async () => {
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async () => 'x', owner: 'S' });
    await a.handle('web:S', '/remember Café on Pearl opens at 7');
    await a.handle('web:S', '/remember Dentist on Tuesday');
    await a.handle('web:S', '/remember Pearl Street parking is free on Sunday');
    assert.equal(await a.handle('web:S', '/notes cafe pearl'), '1. Café on Pearl opens at 7');
    assert.equal(await a.handle('web:S', '/notes PEARL'), '1. Café on Pearl opens at 7\n3. Pearl Street parking is free on Sunday');
    assert.match(await a.handle('web:S', '/notes boat'), /No notes match "boat"/);
    assert.equal((await a.handle('web:S', '/notes')).split('\n').length, 3);
});

// ui/assistant-stream.js, as the pages use it with a fetch Response
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const streamed = (text, size = 5) => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < text.length; i += size) c.enqueue(new TextEncoder().encode(text.slice(i, i + size))); c.close(); },
}), { headers: { 'content-type': 'text/event-stream' } });

test('readReply hands on each step\'s text and resolves to the final event', async () => {
    const texts = [];
    const done = await readReply(streamed(sse([{ step: true }, { delta: 'Looking' }, { step: true }, { delta: 'Two ' }, { delta: 'events' }, { done: true, reply: 'Two events', pending: null }])), { onText: (t) => texts.push(t) });
    assert.equal(done.reply, 'Two events');
    assert.deepEqual(texts, ['', 'Looking', '', 'Two ', 'Two events']);
});

test('readReply reads the plain JSON route, and throws the server\'s errors', async () => {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    assert.equal((await readReply(json({ reply: 'whole' }))).reply, 'whole');
    await assert.rejects(readReply(json({ error: 'the assistant is for its owner' }, 403)), /for its owner/);
    await assert.rejects(readReply(streamed(sse([{ done: true, error: 'boom' }]))), /boom/);
    await assert.rejects(readReply(streamed(sse([{ delta: 'cut' }]))), /stopped before it finished/);
});

test('readReply rejects with an abort error when its fetch is aborted', async () => {
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; c.enqueue(new TextEncoder().encode(sse([{ delta: 'Hi' }]))); } });
    const res = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const texts = [];
    const reading = readReply(res, { onText: (t) => { texts.push(t); ctrl.error(new DOMException('aborted', 'AbortError')); } });
    await assert.rejects(reading, (err) => isAbort(err));
    assert.deepEqual(texts, ['Hi']);
    assert.equal(isAbort(new Error('other')), false);
    assert.equal(typeof parseEvents, 'function');
});
