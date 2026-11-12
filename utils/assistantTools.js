// The assistant's tool loop. The model may call the harness's MCP tools (utils/mcp.js McpManager). A tool
// whose server is set to ask first (askBefore) does not run until the owner answers /yes or /no in the same
// conversation; the run is kept as `pending` until then. Shell and repo tools are not offered here.
const MAX_STEPS = 6;
const MAX_RESULT_CHARS = 4000;
const DECLINED = 'The person declined this action. Do not retry it; say what you would have done instead.';

const truncate = (text, max = MAX_RESULT_CHARS) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** What `ask` returned as a message: a plain string is a text answer with no tool calls. */
function normalize(out) {
    if (out && typeof out === 'object') return { content: out.content || '', tool_calls: Array.isArray(out.tool_calls) ? out.tool_calls : [] };
    return { content: String(out || ''), tool_calls: [] };
}

function parseArgs(text) {
    try {
        const value = JSON.parse(text || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/** Runs the calls and appends one tool message per call. `confirmed` is true only after the owner said /yes. */
async function execute(calls, { manager, messages, confirmed, owner }) {
    for (const call of calls) {
        const name = call.function && call.function.name;
        const args = parseArgs(call.function && call.function.arguments);
        let text;
        if (args === null) text = 'Error: the tool arguments were not a JSON object';
        else {
            try {
                const result = await manager.call(name, args, { confirmed, owner });
                text = truncate(String(result.text || ''));
            } catch (err) {
                text = `Error: ${err.message}`;
            }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
}

/**
 * Model steps until a plain answer, a call that needs approval (returned as `pending`), or the step limit.
 * `messages` is changed in place.
 */
async function drive({ messages, ask, manager, owner, conversation, steps = 0 }) {
    const tools = manager ? manager.definitions() : [];
    while (steps < MAX_STEPS) {
        steps += 1;
        const msg = normalize(await ask(messages, { conversation, owner, tools }));
        const calls = msg.tool_calls.filter((c) => c && c.function && c.function.name);
        if (!calls.length || !tools.length) return { reply: msg.content };
        messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
        if (calls.some((c) => manager.needsApproval(c.function.name))) {
            return { pending: { calls, messages: messages.slice(), steps } };
        }
        await execute(calls, { manager, messages, confirmed: false, owner });
    }
    return { reply: 'I stopped after several tool steps without a final answer. Ask again with a narrower request.' };
}

/** Continues a run that was waiting for approval: /yes runs its calls, /no tells the model they were declined. */
async function resume({ pending, approve, ask, manager, owner, conversation }) {
    const messages = pending.messages.slice();
    if (approve) await execute(pending.calls, { manager, messages, confirmed: true, owner });
    else for (const call of pending.calls) messages.push({ role: 'tool', tool_call_id: call.id, content: DECLINED });
    return drive({ messages, ask, manager, owner, conversation, steps: pending.steps });
}

/** One line per call for the approval question: "server tool {args}". */
function describePending(pending) {
    const items = pending.calls.map((c) => {
        const args = c.function.arguments || '{}';
        return `${c.function.name} ${args.length > 160 ? `${args.slice(0, 160)}…` : args}`;
    });
    return `I need your approval to run ${items.join('; ')}.`;
}

module.exports = { drive, resume, describePending, normalize, MAX_STEPS };
