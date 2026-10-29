const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../runner/agent');

const toolCall = (name, id) => ({
    id, type: 'function', function: { name, arguments: JSON.stringify({ path: id }) },
});

async function runWithCalls(names) {
    let active = 0;
    let maxActive = 0;
    const calls = names.map((name, i) => toolCall(name, String(i)));
    const histories = [];
    let chats = 0;
    const result = await runAgent({
        run: { goal: 'test', maxSteps: 2, deadline: Date.now() + 10000, stopped: () => false },
        tools: {
            definitions: [],
            async call(name, args) {
                if (name === 'finish') return { text: args.summary, finished: true };
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise(resolve => setTimeout(resolve, 25));
                active--;
                return { text: `${name}:${args.path}` };
            },
        },
        async chat(messages) {
            histories.push(messages);
            if (chats++ === 0) return { message: { tool_calls: calls } };
            return { message: { tool_calls: [toolCall('finish', 'finish')] } };
        },
        emit() {},
    });
    return { result, maxActive, histories };
}

test('runs a group of read-only file tools concurrently and keeps results in call order', async () => {
    const { result, maxActive, histories } = await runWithCalls(['read_file', 'list_files']);
    assert.equal(result.status, 'finished');
    assert.equal(maxActive, 2);
    assert.deepEqual(histories[1].filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]), [
        ['0', 'read_file:0'],
        ['1', 'list_files:1'],
    ]);
});

test('keeps a turn with a mutating tool sequential', async () => {
    const { result, maxActive } = await runWithCalls(['read_file', 'edit_file']);
    assert.equal(result.status, 'finished');
    assert.equal(maxActive, 1);
});

test('a repeated read keeps only the newest copy, and a loop is told to change approach', async () => {
    const calls = [];
    let n = 0;
    const tools = { definitions: [], async call(name, args) { calls.push([name, args]); return name === 'finish' ? { text: 'done', finished: true } : { text: 'x'.repeat(2000) }; } };
    const seen = [];
    const chat = async (messages) => {
        seen.push(messages);
        n++;
        const call = (name, args) => ({ message: { content: '', tool_calls: [{ id: `c${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
        return n <= 4 ? call('read_file', { path: 'a.js' }) : call('finish', { summary: 'ok' });
    };
    const out = await runAgent({ run: { goal: 'g', maxSteps: 0, deadline: Date.now() + 1e5, stopped: () => false }, tools, chat, emit() {} });
    assert.equal(out.status, 'finished');
    const last = seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(last[0], /read again later/);
    assert.match(last.at(-1), /exact call 3 times/);
    assert.equal(calls.filter(([name]) => name === 'read_file').length, 2); // the third and fourth never ran
});

test('the agent is told to wrap up three steps before the end', async () => {
    const tools = { definitions: [], async call() { return { text: 'ok' }; } };
    let n = 0, seenWrap = 0;
    const chat = async (messages) => {
        if (messages.some((m) => m.role === 'user' && /steps left/.test(m.content))) seenWrap++;
        n++;
        return { message: { content: '', tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: `d${n}` }) } }] } };
    };
    const out = await runAgent({ run: { goal: 'g', maxSteps: 8, deadline: Date.now() + 1e5, stopped: () => false }, tools, chat, emit() {} });
    assert.equal(out.status, 'out_of_steps');
    assert.ok(seenWrap >= 1);
});
