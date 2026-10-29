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

const KEEP_RECENT = 8;        // tool results in the last N messages stay whole
const OLD_RESULT_CHARS = 400; // older ones are cut to this
const CUT_STEP = 6;           // the cut point moves in jumps of this many messages, so the start of the history
                              // stays the same between jumps and the provider's prompt cache keeps hitting
const SAME_CALL_LIMIT = 3;    // the same call this many times in a row is a loop
const WRAP_UP_AT = 3;         // steps left when the agent is told to finish
const PARTIAL_CHARS = 2000;   // how much of what the model was saying a run carried on is told

const READ_TOOLS = new Set(['list_files', 'read_file']);

/** What the model was saying when the steps ran out: its last words that were not a tool call. */
function partialNote(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content.trim().slice(-PARTIAL_CHARS);
    }
    return '';
}

/** Cut the bodies of old tool results so a long run's history stays affordable. */
function shrinkHistory(messages) {
    const cutoff = Math.floor((messages.length - KEEP_RECENT) / CUT_STEP) * CUT_STEP;
    return messages.map((m, i) => (m.role === 'tool' && i < cutoff && m.content.length > OLD_RESULT_CHARS
        ? { ...m, content: `${m.content.slice(0, OLD_RESULT_CHARS)}\n[... older output cut to save space ...]` } : m));
}

function toolArgs(call) {
    try { return JSON.parse(call.function.arguments || '{}'); } catch { return null; }
}

/** An old read of the same file part is a copy the model already has a newer one of: keep a stub. */
function dropRepeatedReads(messages, callName, args) {
    if (callName !== 'read_file' || !args?.path) return;
    const key = (a) => `${a.path}|${a.start || ''}|${a.end || ''}`;
    const want = key(args);
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'assistant' || !m.tool_calls) continue;
        for (const c of m.tool_calls) {
            if (c.function.name !== 'read_file') continue;
            const a = toolArgs(c);
            if (!a || key(a) !== want) continue;
            const r = messages.slice(i + 1).find((x) => x.role === 'tool' && x.tool_call_id === c.id);
            if (r && r.content.length > OLD_RESULT_CHARS) r.content = `${args.path}: read again later; see the newer copy below.`;
        }
    }
}

async function runTool(call, args, tools, emit, messages = [], recent = []) {
    emit({ type: 'tool', name: call.function.name, args: args ?? call.function.arguments });
    const sig = `${call.function.name}:${call.function.arguments}`;
    recent.push(sig);
    if (recent.length > 20) recent.shift();
    const looping = recent.length >= SAME_CALL_LIMIT && recent.slice(-SAME_CALL_LIMIT).every((s) => s === sig);
    let result;
    if (args === null) result = { text: 'Error: the arguments were not valid JSON. Send them again.' };
    else if (looping && call.function.name !== 'finish') result = { text: `You have made this exact call ${SAME_CALL_LIMIT} times in a row and nothing changed. Do something different (read another file, change your approach), or call finish and say what is blocking you.` };
    else { dropRepeatedReads(messages, call.function.name, args); result = await tools.call(call.function.name, args); }
    emit({ type: 'result', name: call.function.name, text: result.text });
    return result;
}

/**
 * run: { goal, maxSteps, deadline (ms epoch), stopped(), overBudget() (optional: true once the cost limit is spent) }.
 * `chat(messages, tools)` resolves the model's reply { message, usage }.
 * `tools` from makeTools. `emit(event)` records what happens.
 * Resolves { status: 'finished' | 'out_of_steps' | 'out_of_time' | 'out_of_budget' | 'stopped', summary, partial },
 * where partial (running out of steps only) is what the model was saying at the time.
 * That is what a run carried on from this one is given, since nothing went wrong.
 */
async function runAgent({ run, tools, chat, emit, firstContext = '', system = SYSTEM }) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: `Task:\n${run.goal}${firstContext ? `\n\n${firstContext}` : ''}` }];
    let nudges = 0, wrapped = false;
    const recent = [];
    // maxSteps of 0 means no step limit: only the deadline and the stop button end it.
    const last = run.maxSteps > 0 ? run.maxSteps : Infinity;
    for (let step = 1; step <= last; step++) {
        if (run.stopped()) return { status: 'stopped', summary: 'Stopped by a person.' };
        if (Date.now() > run.deadline) return { status: 'out_of_time', summary: 'Ran out of time.', partial: partialNote(messages) };
        if (run.overBudget?.()) return { status: 'out_of_budget', summary: 'Stopped at its cost limit.', partial: partialNote(messages) };
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
        let ran = 0;
        const calls = msg.tool_calls;
        if (calls.length > 1 && calls.every(call => READ_TOOLS.has(call.function.name))) {
            if (run.stopped()) return { status: 'stopped', summary: 'Stopped by a person.' };
            const results = await Promise.all(calls.map(call => runTool(call, toolArgs(call), tools, emit, messages, recent)));
            for (let i = 0; i < calls.length; i++) {
                messages.push({ role: 'tool', tool_call_id: calls[i].id, content: results[i].text });
                ran++;
            }
            if (run.stopped()) return { status: 'stopped', summary: 'Stopped by a person.' };
        } else for (const call of calls) {
            // a stop between two calls of one step leaves the rest unrun: the run has ended
            if (run.stopped()) break;
            const result = await runTool(call, toolArgs(call), tools, emit, messages, recent);
            messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
            ran += 1;
            if (result.finished) return { status: 'finished', summary: result.text };
            if (run.stopped()) return { status: 'stopped', summary: 'Stopped by a person.' };
        }
        // Nearly out of steps: say so while there is still one to write the summary with.
        if (!wrapped && last !== Infinity && last - step === WRAP_UP_AT && ran === msg.tool_calls.length) {
            wrapped = true;
            messages.push({ role: 'user', content: `You have ${WRAP_UP_AT} steps left. Stop exploring: finish what you can now and call finish with a summary of what is done and what is not.` });
        }
        // This was the last step. A reply that asked for more tools than there were steps
        // left would leave some of them never run, and a tool call with no result after it
        // is not a history a model can be given next time: leave them out of what is kept.
        if (step === last && ran < msg.tool_calls.length) {
            messages[messages.length - 1 - ran].tool_calls = msg.tool_calls.slice(0, ran);
        }
    }
    return { status: 'out_of_steps', summary: `Used all ${last === Infinity ? 'allowed' : last} steps without finishing.`, partial: partialNote(messages) };
}

/** The base rules plus what this stage of a workflow is for. */
function stageSystem(stage) {
    return `${SYSTEM}\n\nYour role in this run: ${stage.role}. ${stage.prompt}`;
}

// Plan mode: the same rules, minus the changes. The agent reads what it needs
// and answers with a plan the person decides on.
const PLAN_RULES = `

You are planning, not changing anything: this run may read and search the code but cannot write, edit or run commands that change the workspace. When you have read enough, call finish with your plan and nothing else:
- What you would change and why, file by file.
- The order to do it in, and what to check after each step.
- The risks, the open questions, and anything you need a person to decide.
Be concrete enough that the same plan could be carried out without you.`;

/** The base rules, the stage's role, and plan mode's rules when it is on. */
function systemFor(stage, { plan = false } = {}) {
    const base = plan ? `${SYSTEM}${PLAN_RULES}` : SYSTEM;
    return `${base}\n\nYour role in this run: ${stage.role}. ${stage.prompt}`;
}

module.exports = { runAgent, shrinkHistory, stageSystem, systemFor, PLAN_RULES, SYSTEM };
