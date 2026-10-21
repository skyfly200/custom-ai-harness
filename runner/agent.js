// The agent loop: ask the model what to do, run the tools it calls in the
// sandbox, feed the results back, until it calls finish, runs out of steps or
// time, or is stopped. The model is reached through the Interceptor like any
// other client, so the run's routing, effort, caching, compression and
// fallbacks all apply.
'use strict';

const SYSTEM = `You are a software engineer working alone in a git workspace on a copy of the user's repository. Complete the task you are given, using the tools.

Rules:
- Look before you change: list files, read the relevant code, search with run_command.
- Make the smallest change that completes the task, in the style of the code around it. Do not reformat or rewrite unrelated code.
- Check your work: run the project's tests or a command that proves the change works, and fix what fails.
- You cannot ask questions. If something is ambiguous, pick the most reasonable reading and say so in your summary.
- Never touch secrets, .env files or the .git folder. Do not push or publish anything: the person will review your branch.
- When you are done, or cannot continue, call finish with a short summary: what you changed, how you checked it, and anything they should look at.`;

const KEEP_RECENT = 12;       // tool results in the last N messages stay whole
const OLD_RESULT_CHARS = 400; // older ones are cut to this

/** Cut the bodies of old tool results so a long run's history stays affordable. */
function shrinkHistory(messages) {
    const cutoff = messages.length - KEEP_RECENT;
    return messages.map((m, i) => (m.role === 'tool' && i < cutoff && m.content.length > OLD_RESULT_CHARS
        ? { ...m, content: `${m.content.slice(0, OLD_RESULT_CHARS)}\n[... older output cut to save space ...]` } : m));
}

/**
 * run: { goal, maxSteps, deadline (ms epoch), stopped() }.
 * `chat(messages, tools)` resolves the model's reply { message, usage }.
 * `tools` from makeTools. `emit(event)` records what happens.
 * Resolves { status: 'finished' | 'out_of_steps' | 'out_of_time' | 'stopped', summary }.
 */
async function runAgent({ run, tools, chat, emit, firstContext = '', system = SYSTEM }) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: `Task:\n${run.goal}${firstContext ? `\n\n${firstContext}` : ''}` }];
    let nudges = 0;
    for (let step = 1; step <= run.maxSteps; step++) {
        if (run.stopped()) return { status: 'stopped', summary: 'Stopped by a person.' };
        if (Date.now() > run.deadline) return { status: 'out_of_time', summary: 'Ran out of time.' };
        emit({ type: 'step', step });
        const reply = await chat(shrinkHistory(messages), tools.definitions);
        const msg = reply.message;
        emit({ type: 'model', text: msg.content || '', calls: (msg.tool_calls || []).length, usage: reply.usage, model: reply.model });
        messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (!msg.tool_calls?.length) {
            if (++nudges > 2) return { status: 'finished', summary: msg.content || 'The model stopped without a summary.' };
            messages.push({ role: 'user', content: 'Use a tool to continue, or call finish if you are done.' });
            continue;
        }
        for (const call of msg.tool_calls) {
            let args;
            try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = null; }
            emit({ type: 'tool', name: call.function.name, args: args ?? call.function.arguments });
            const result = args === null
                ? { text: 'Error: the arguments were not valid JSON. Send them again.' }
                : await tools.call(call.function.name, args);
            emit({ type: 'result', name: call.function.name, text: result.text });
            messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
            if (result.finished) return { status: 'finished', summary: result.text };
            if (run.stopped()) return { status: 'stopped', summary: 'Stopped by a person.' };
        }
    }
    return { status: 'out_of_steps', summary: `Used all ${run.maxSteps} steps without finishing.` };
}

/** The base rules plus what this stage of a workflow is for. */
function stageSystem(stage) {
    return `${SYSTEM}\n\nYour role in this run: ${stage.role}. ${stage.prompt}`;
}

module.exports = { runAgent, shrinkHistory, stageSystem, SYSTEM };
