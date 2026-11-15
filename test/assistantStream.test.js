// The assistant's streamed replies: reading a chat-completions event stream, loopbackAsk asking for one, and
// handle() passing each step and piece of text on (the floating assistant's /ui/api/assistant/stream).
const test = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../utils/assistant');

const sse = (events) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const chunks = (text, size) => (async function* () { for (let i = 0; i < text.length; i += size) yield new TextEncoder().encode(text.slice(i, i + size)); })();

test('readCompletionStream joins text and tool-call pieces, across chunk boundaries', async () => {
    const body = sse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'cal', arguments: '{"d' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ay":1}' } }] } }] },
        '[DONE]',
    ]);
    const seen = [];
    const out = await assistant.readCompletionStream(chunks(body, 7), (d) => seen.push(d));
    assert.equal(out.content, 'Hello');
    assert.deepEqual(seen, ['Hel', 'lo']);
    assert.deepEqual(out.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'cal', arguments: '{"day":1}' } }]);
});

test('readCompletionStream reports an error event', async () => {
    await assert.rejects(assistant.readCompletionStream(chunks(sse([{ error: { message: 'rate limited' } }]), 50)), /rate limited/);
});

test('loopbackAsk asks for a stream only when given onDelta, and reads either answer', async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (body.stream) return new Response(sse([{ choices: [{ delta: { content: 'streamed' } }] }, '[DONE]']), { headers: { 'content-type': 'text/event-stream' } });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'whole' } }] }), { headers: { 'content-type': 'application/json' } });
    };
    const ask = assistant.loopbackAsk({ owner: 'S', fetchImpl });
    assert.equal((await ask([{ role: 'user', content: 'hi' }])).content, 'whole');
    const pieces = [];
    assert.equal((await ask([{ role: 'user', content: 'hi' }], { onDelta: (d) => pieces.push(d) })).content, 'streamed');
    assert.deepEqual(bodies.map((b) => b.stream), [false, true]);
    assert.deepEqual(pieces, ['streamed']);

    // a server that answers a stream request with plain JSON still works
    const plain = assistant.loopbackAsk({ owner: 'S', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'json' } }] }), { headers: { 'content-type': 'application/json' } }) });
    assert.equal((await plain([], { onDelta: () => {} })).content, 'json');
});

test('handle streams each model step: onStep before it, its text through onDelta; the saved reply is the last step', async () => {
    const manager = {
        start: async () => {},
        definitions: () => [{ type: 'function', function: { name: 'calendar_list', parameters: {} } }],
        needsApproval: () => false,
        call: async () => ({ text: 'two events' }),
    };
    let step = 0;
    const ask = async (messages, opts) => {
        step += 1;
        if (step === 1) { opts.onDelta('Let me look. '); return { content: 'Let me look. ', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calendar_list', arguments: '{}' } }] }; }
        opts.onDelta('You have '); opts.onDelta('two events.');
        return { content: 'You have two events.', tool_calls: [] };
    };
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask, tools: manager, owner: 'S' });
    const events = [];
    const reply = await a.handle('web:S', 'what is on?', { onStep: () => events.push('step'), onDelta: (d) => events.push(d) });
    assert.equal(reply, 'You have two events.');
    assert.deepEqual(events, ['step', 'Let me look. ', 'step', 'You have ', 'two events.']);
    assert.equal(a.history('web:S').at(-1).content, 'You have two events.');
});

test('commands answer at once and do not stream', async () => {
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async () => { throw new Error('not called'); }, owner: 'S' });
    const events = [];
    assert.match(await a.handle('web:S', '/notes', { onStep: () => events.push('step'), onDelta: (d) => events.push(d) }), /No notes yet/);
    assert.deepEqual(events, []);
});

test('without onDelta the model is asked as before, with no onDelta passed on', async () => {
    let opts = null;
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: async (m, o) => { opts = o; return 'ok'; }, owner: 'S' });
    assert.equal(await a.handle('web:S', 'hi'), 'ok');
    assert.equal(opts.onDelta, undefined);
});
