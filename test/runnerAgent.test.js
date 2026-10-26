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
