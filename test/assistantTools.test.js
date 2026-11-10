// The assistant's tool loop: read tools run, tools set to ask first wait for /yes or /no, and the loop is bounded.
const test = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../utils/assistant');
const tooling = require('../utils/assistantTools');

// A fake McpManager: "calendar_list" needs no approval, "mail_send" does.
function fakeManager() {
    const calls = [];
    return {
        calls,
        start: async () => {},
        definitions: () => [
            { type: 'function', function: { name: 'calendar_list', description: 'list events', parameters: {} } },
            { type: 'function', function: { name: 'mail_send', description: 'send mail', parameters: {} } },
        ],
        needsApproval: (name) => name === 'mail_send',
        call: async (name, args, { confirmed = false } = {}) => {
            calls.push({ name, args, confirmed });
            return { text: `${name} ok` };
        },
    };
}

const toolCall = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });

// A scripted model: each call to ask returns the next entry; records the messages it was given.
function scripted(replies) {
    const seen = [];
    let i = 0;
    const ask = async (messages, opts) => {
        seen.push({ messages: messages.map((m) => ({ ...m })), tools: opts.tools });
        if (i >= replies.length) throw new Error('script ran out');
        return replies[i++];
    };
    return { ask, seen };
}

test('a tool that needs no approval runs, and the model answers with its result', async () => {
    const manager = fakeManager();
    const model = scripted([
        { content: '', tool_calls: [toolCall('c1', 'calendar_list')] },
        'You have two events today.',
    ]);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, tools: manager, owner: 'S' });
    assert.equal(await a.handle('web:S', 'what is on today?'), 'You have two events today.');
    assert.deepEqual(manager.calls, [{ name: 'calendar_list', args: {}, confirmed: false }]);
    const last = model.seen[1].messages.at(-1);
    assert.equal(last.role, 'tool');
    assert.equal(last.content, 'calendar_list ok');
    assert.equal(model.seen[0].tools.length, 2);
});

test('a tool that needs approval waits for /yes, then runs with the owner confirmed', async () => {
    const manager = fakeManager();
    const model = scripted([
        { content: '', tool_calls: [toolCall('m1', 'mail_send', '{"to":"a@example.com"}')] },
        'Sent.',
    ]);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, tools: manager, owner: 'S' });
    const question = await a.handle('telegram:42', 'email a@example.com');
    assert.match(question, /I need your approval to run mail_send \{"to":"a@example.com"\}\. Send \/yes/);
    assert.deepEqual(manager.calls, [], 'nothing runs before the answer');

    assert.equal(await a.handle('telegram:42', '/yes'), 'Sent.');
    assert.deepEqual(manager.calls, [{ name: 'mail_send', args: { to: 'a@example.com' }, confirmed: true }]);
});

test('/no tells the model the action was declined, and nothing runs', async () => {
    const manager = fakeManager();
    const model = scripted([
        { content: '', tool_calls: [toolCall('m1', 'mail_send')] },
        'Okay, I did not send it.',
    ]);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, tools: manager, owner: 'S' });
    await a.handle('web:S', 'send it');
    assert.equal(await a.handle('web:S', '/no'), 'Okay, I did not send it.');
    assert.deepEqual(manager.calls, []);
    assert.match(model.seen[1].messages.at(-1).content, /The person declined this action/);
});

test('while an approval is waiting, other messages are held and the model is not called', async () => {
    const manager = fakeManager();
    const model = scripted([{ content: '', tool_calls: [toolCall('m1', 'mail_send')] }]);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, tools: manager, owner: 'S' });
    await a.handle('web:S', 'send it');
    assert.match(await a.handle('web:S', 'hello?'), /Send \/yes to allow it or \/no to decline/);
    assert.equal(model.seen.length, 1);
});

test('a bad argument string becomes an error the model sees, and the tool is not called', async () => {
    const manager = fakeManager();
    const model = scripted([
        { content: '', tool_calls: [toolCall('c1', 'calendar_list', '{not json')] },
        'Sorry, that did not work.',
    ]);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, tools: manager, owner: 'S' });
    assert.equal(await a.handle('web:S', 'list'), 'Sorry, that did not work.');
    assert.deepEqual(manager.calls, []);
    assert.match(model.seen[1].messages.at(-1).content, /not a JSON object/);
});

test('the loop stops after its step limit instead of calling tools forever', async () => {
    const manager = fakeManager();
    const forever = Array.from({ length: tooling.MAX_STEPS + 2 }, (_, i) => ({ content: '', tool_calls: [toolCall(`c${i}`, 'calendar_list')] }));
    const model = scripted(forever);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, tools: manager, owner: 'S' });
    assert.match(await a.handle('web:S', 'loop'), /stopped after several tool steps/);
    assert.equal(manager.calls.length, tooling.MAX_STEPS);
});

test('without tools the model answers as before, with no tool list offered', async () => {
    const model = scripted(['plain answer']);
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask: model.ask, owner: 'S' });
    assert.equal(await a.handle('web:S', 'hi'), 'plain answer');
    assert.deepEqual(model.seen[0].tools, []);
});
