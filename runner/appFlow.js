// The Wayfinder app flow: a person defines an app, and the harness plans it and builds it.
//
// Two agents run in a row, both on Sonnet with medium reasoning, and both can call an
// advisor on Opus for a second opinion:
//
//   1. The planner grills the person one question at a time (features, data, users, what
//      "done" means) and finishes with a Wayfinder ticket draft (utils/tickets: build,
//      research and decision tickets, each with the tickets it depends on).
//   2. The orchestrator walks that draft. It starts a worker for each build or research
//      ticket whose dependencies are done. A worker is a run on Haiku with minimal
//      reasoning, on its own branch; finished build work is merged into the app's branch.
//      While the workers run, the orchestrator asks the person the decision tickets, one at a
//      time, so the grilling and the building happen side by side. A failed worker is not
//      retried until the advisor has said what to change.
//
// The app's sandbox holds the app's branch; a worker's commit is merged into it as the swarm
// merges its parts (runner/swarm.js). The person answers through the run's question card
// (runHumanStage), the same as a workflow's "human" stage. The model calls go through the
// Interceptor like every other request, so their cost shows in the run and on the Usage page.
'use strict';

const path = require('path');
const advisor = require('../utils/advisor');

const MODELS = {
    planner: process.env.APP_PLANNER_MODEL || 'or-claude-sonnet-latest',
    orchestrator: process.env.APP_ORCHESTRATOR_MODEL || 'or-claude-sonnet-latest',
    advisor: process.env.APP_ADVISOR_MODEL || 'or-claude-opus-latest',
    worker: process.env.APP_WORKER_MODEL || 'or-claude-haiku-5.5',
};
const EFFORTS = { planner: 'medium', orchestrator: 'medium', advisor: 'high', worker: 'min' };

const MAX_QUESTIONS = 12;     // grilling questions the planner may ask
const MAX_WORKERS = 3;        // workers running at once
const MAX_ATTEMPTS = 3;       // tries at one ticket before it is given up
const MAX_ADVICE = 8;         // advisor calls per app
const MAX_TICKETS = 20;
const MAX_PLAN_STEPS = 40;
const MAX_ORCH_STEPS = 150;
const KINDS = new Set(['build', 'research', 'decision']);
const TERMINAL = new Set(['done', 'failed', 'stopped', 'incomplete', 'interrupted']);
const SETTLED = new Set(['done', 'failed', 'skipped']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const PLANNER_TOOLS = [
    fn('ask_person', 'Ask the person one grilling question about the app. One question per call. Give up to four short options when there are clear choices; the answer comes back in the tool result.', { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']),
    fn('read_file', 'Read a tracked file from the repository (path as listed in the context). Long files are cut.', { path: { type: 'string' } }, ['path']),
    fn('search_code', 'Search the repository for a fixed string; returns matching lines with file and line number.', { text: { type: 'string' } }, ['text']),
    fn('ask_advisor', 'Ask the advisor, a stronger model, about a trade-off or a design you are unsure of. It answers in words and cannot read the repository: send what it needs.', { question: { type: 'string' }, context: { type: 'string' } }, ['question']),
    fn('finish', 'Finish planning with the Wayfinder ticket draft, as one JSON object in a string (the shape in the instructions).', { draft: { type: 'string' } }, ['draft']),
];

const ORCHESTRATOR_TOOLS = [
    fn('status', 'List every ticket with its kind, status, attempts and notes.', {}),
    fn('dispatch', 'Start a worker on a build or research ticket whose dependencies are done. A ticket that failed needs ask_advisor (with its ticket_id) first.', { ticket_id: { type: 'string' } }, ['ticket_id']),
    fn('wait', 'Wait until a running worker finishes, merge what it did, and report. Use it when nothing is ready and workers are running.', {}),
    fn('ask_person', 'Ask the person a decision ticket\'s question, or any question the app needs answered. Workers keep running while you wait. Pass ticket_id when the answer settles a decision ticket.', { question: { type: 'string' }, ticket_id: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']),
    fn('ask_advisor', 'Ask the advisor, a stronger model, for help: a failed ticket (pass ticket_id, then dispatch it again), a design question, or a merge that went wrong.', { question: { type: 'string' }, context: { type: 'string' }, ticket_id: { type: 'string' } }, ['question']),
    fn('finish', 'Finish when every ticket is done, failed or skipped. Summarise what was built and what was left out.', { summary: { type: 'string' } }, ['summary']),
];

const PLANNER_SYSTEM = `You plan an app for a person, step by step, as the Wayfinder method does: a shared map of decisions and tasks that is resolved one ticket at a time. You grill the person before you plan: ask one question per turn with ask_person, starting with what the app must do for its users, then the data it keeps, who signs in, where it runs and what "done" looks like. Ask at most ${MAX_QUESTIONS} questions, and only the ones that change the plan. When an answer is empty, the person skipped it: choose the simplest option and say so in the draft. Read the code with read_file and search_code when the app extends this repository.

When the grilling is enough, call finish with ONE JSON object (no prose) of this shape:
{"goal":"string","destinations":[{"id":"kebab-id","outcome":"observable outcome"}],"tickets":[{"id":"kebab-id","kind":"build|research|decision","title":"short title","description":"self-contained description","acceptance_criteria":["verifiable condition"],"depends_on":["ticket-id"]}]}
- A build ticket is one small, independently checkable piece of code, written so a worker with no other context can do it. Give it acceptance criteria it can verify by running tests or the app.
- A research ticket answers a question from the code and changes nothing.
- A decision ticket is a question still open after the grilling; the orchestrator will ask the person it later, so put it before the build tickets that need its answer, and make those depend on it.
- depends_on states real prerequisites only. List tickets prerequisites first, and keep the graph acyclic. At most ${MAX_TICKETS} tickets.`;

const ORCHESTRATOR_SYSTEM = `You build an app from a Wayfinder ticket draft that a planner made with the person. You do not write code yourself: you start workers, answer and ask the person, and merge their work. Each turn, call one tool.

- dispatch starts a worker on a ready build or research ticket (its dependencies are done). Up to ${MAX_WORKERS} run at once. A worker is a small model with minimal reasoning: give it nothing to decide.
- While workers run, ask_person the decision tickets, one question at a time, short, with options when there are some. The answer settles the ticket and unblocks what depends on it.
- If nothing is ready and workers are running, call wait.
- When a worker fails, call ask_advisor with its ticket_id and the failure, then dispatch the ticket again. The advisor's answer goes to the worker.
- Call finish only when every ticket is done, failed or skipped.`;

/** Read the planner's draft (a JSON object, or text with one in it) into tickets, or throw a message the planner can act on. */
function readDraft(input) {
    let draft = input;
    if (typeof draft === 'string') {
        const start = draft.indexOf('{');
        const end = draft.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('the draft is not a JSON object');
        try { draft = JSON.parse(draft.slice(start, end + 1)); } catch { throw new Error('the draft is not valid JSON'); }
    }
    const list = Array.isArray(draft?.tickets) ? draft.tickets : null;
    if (!list || !list.length) throw new Error('the draft has no tickets');
    if (list.length > MAX_TICKETS) throw new Error(`a draft may have ${MAX_TICKETS} tickets at most (it has ${list.length})`);
    const ids = new Set();
    const tickets = list.map((t) => {
        const id = String(t?.id ?? '').trim();
        if (!id) throw new Error('every ticket needs an id');
        if (ids.has(id)) throw new Error(`ticket id “${id}” is used twice`);
        ids.add(id);
        const kind = t.kind || 'build';
        if (!KINDS.has(kind)) throw new Error(`ticket “${id}” kind must be build, research or decision`);
        return {
            id, kind, title: String(t.title || id).slice(0, 80),
            description: String(t.description || t.title || id).trim().slice(0, 8000),
            acceptance: (Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : []).map(String).slice(0, 20),
            depends_on: (Array.isArray(t.depends_on) ? t.depends_on : []).map(String),
            status: 'todo', attempts: 0, advice: [], adviceFresh: false, decision: null, result: null, child: null, note: null,
        };
    });
    const byId = new Map(tickets.map((t) => [t.id, t]));
    for (const t of tickets) for (const d of t.depends_on) {
        if (d === t.id) throw new Error(`ticket “${t.id}” depends on itself`);
        if (!byId.has(d)) throw new Error(`ticket “${t.id}” depends on “${d}”, which is not in the draft`);
    }
    const seen = new Map();
    const visit = (id) => {
        if (seen.get(id) === 'doing') throw new Error(`the tickets depend on each other in a loop at “${id}”`);
        if (seen.get(id) === 'done') return;
        seen.set(id, 'doing');
        for (const d of byId.get(id).depends_on) visit(d);
        seen.set(id, 'done');
    };
    for (const t of tickets) visit(t.id);
    return { goal: String(draft.goal || '').slice(0, 2000), tickets };
}

/** A ticket is ready when every ticket it depends on is settled as done. */
function ready(t, byId) {
    return t.status === 'todo' && t.depends_on.every((d) => byId.get(d)?.status === 'done');
}

/** A todo ticket that depends on one that failed or was skipped is skipped too, all the way down. */
function cascade(tickets, byId) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const t of tickets) {
            if (t.status !== 'todo') continue;
            const lost = t.depends_on.find((d) => ['failed', 'skipped'].includes(byId.get(d).status));
            if (lost) { t.status = 'skipped'; t.note = `needs “${lost}”, which was left out`; changed = true; }
        }
    }
}

/** The task a worker is given: the ticket, the decisions it depends on, and the advisor's advice on an earlier try. */
function taskFor(t, byId, goal) {
    const decided = t.depends_on.map((d) => byId.get(d)).filter((d) => d.decision !== null).map((d) => `- ${d.title}: ${d.decision || 'no answer, so choose the simplest option and say so'}`);
    const parts = [t.description];
    if (t.acceptance.length) parts.push(`Acceptance criteria:\n${t.acceptance.map((c) => `- ${c}`).join('\n')}`);
    if (decided.length) parts.push(`Decisions the person made:\n${decided.join('\n')}`);
    if (t.advice.length) parts.push(`The advisor said, after an earlier try failed (${t.lastError || 'it failed'}):\n${t.advice[t.advice.length - 1]}`);
    parts.push(`This is one ticket of a larger app: "${goal}". Do only this ticket and leave the rest to other workers.`);
    return parts.join('\n\n').slice(0, 12000);
}

/**
 * One agent: a loop of model calls, each answered with the tools' results, until it calls finish
 * (act returns done) or runs out of steps, time or patience. `act` runs one tool call.
 */
async function converse(ctx, { label, model, effort, system, messages, tools, maxSteps, act }) {
    let nudges = 0;
    let lastText = '';
    for (let step = 0; step < maxSteps; step++) {
        if (ctx.live.stopped) return { status: 'stopped', summary: 'Stopped by a person.' };
        if (Date.now() > ctx.deadline) return { status: 'incomplete', summary: `${label}: ran out of time.` };
        const res = await ctx.manager.chat(ctx.run, [{ role: 'system', content: system }, ...messages], tools, ++ctx.n, effort, model);
        ctx.manager.event(ctx.run, { type: 'model', stage: label, model: res.model, usage: res.usage, route: res.route });
        const msg = res.message || {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        messages.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (msg.content) lastText = String(msg.content).trim();
        if (!calls.length) {
            if (++nudges > 3) return { status: 'incomplete', summary: `${label}: stopped answering with tools. ${lastText}`.trim() };
            messages.push({ role: 'user', content: 'Call one of your tools. Call finish when you are done.' });
            continue;
        }
        for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}') || {}; } catch { args = null; }
            const out = args === null ? { text: 'The arguments were not valid JSON. Send the call again.' } : await act(call.function?.name, args);
            messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
            if (out.done) return out.done;
        }
    }
    return { status: 'incomplete', summary: `${label}: used ${maxSteps} steps without finishing.` };
}

/** One advisor answer, in words, for a question the agent sends. */
async function adviseOnce(ctx, question, context) {
    if (ctx.advice >= MAX_ADVICE) return 'The advisor has already been asked as often as this app allows. Decide it yourself and say so.';
    ctx.advice += 1;
    const req = advisor.request({ model: MODELS.advisor, effort: EFFORTS.advisor }, { question, context });
    const res = await ctx.manager.chat(ctx.run, req.messages, [], ++ctx.n, EFFORTS.advisor, MODELS.advisor);
    ctx.manager.event(ctx.run, { type: 'model', stage: 'Advisor', model: res.model, usage: res.usage, route: res.route });
    return advisor.answer({ choices: [{ message: res.message }], usage: res.usage }).text;
}

/** Ask the person through the run's question card; resolves { status, answer }. */
async function askPerson(ctx, { id, question, options = [] }) {
    return ctx.manager.runHumanStage({ run: ctx.run, live: ctx.live, stage: { id, role: 'Wayfinder', question, options, defaultOption: null, timeoutMinutes: 60 } });
}

/** The planner: grills the person, reads the repository, and finishes with a draft. */
async function planApp(ctx, files) {
    const { sandbox, run } = ctx;
    let asked = 0;
    const messages = [{ role: 'user', content: `The app to build:\n${run.goal}\n\nThe repository has ${files.length} tracked files. First ones:\n${files.slice(0, 150).join('\n')}${files.length > 150 ? '\n…' : ''}` }];
    return converse(ctx, {
        label: 'Planner', model: MODELS.planner, effort: EFFORTS.planner, system: PLANNER_SYSTEM, messages, tools: PLANNER_TOOLS, maxSteps: MAX_PLAN_STEPS,
        act: async (name, args) => {
            if (name === 'ask_person') {
                if (asked >= MAX_QUESTIONS) return { text: `You have asked ${MAX_QUESTIONS} questions, the most this app allows. Decide the rest and record what is still open as decision tickets.` };
                asked += 1;
                const options = (Array.isArray(args.options) ? args.options : []).map(String).filter(Boolean).slice(0, 4);
                const got = await askPerson(ctx, { id: `grill-${asked}`, question: String(args.question || '').slice(0, 1000), options });
                if (got.status !== 'finished') return { done: got, text: 'stopped' };
                return { text: got.answer ? `The person answered: ${got.answer}` : 'The person skipped this question. Choose the simplest option and say so in the draft.' };
            }
            if (name === 'read_file') {
                const p = String(args.path || '');
                if (!files.includes(p)) return { text: `“${p}” is not a tracked file. Use a path from the list.` };
                const text = await sandbox.git(['show', `${run.base}:${p}`]).catch(() => '');
                return { text: text ? text.slice(0, 6000) + (text.length > 6000 ? '\n… (cut)' : '') : 'The file could not be read.' };
            }
            if (name === 'search_code') {
                const text = String(args.text || '').slice(0, 200);
                if (!text) return { text: 'Give the text to search for.' };
                const found = await sandbox.git(['grep', '-n', '-I', '-F', '--max-count=5', '-e', text, run.base]).catch(() => '');
                return { text: found ? found.slice(0, 4000) : 'No matches.' };
            }
            if (name === 'ask_advisor') return { text: await adviseOnce(ctx, String(args.question || ''), String(args.context || '')) };
            if (name === 'finish') {
                try {
                    const draft = readDraft(args.draft);
                    return { done: { status: 'finished', draft } };
                } catch (err) {
                    return { text: `The draft is not usable: ${err.message}. Fix it and call finish again.` };
                }
            }
            return { text: `There is no tool named ${name}.` };
        },
    });
}

/** The orchestrator: starts workers, asks the person decisions, merges, and finishes. */
async function traverse(ctx, draft) {
    const { run, sandbox, manager } = ctx;
    const tickets = draft.tickets;
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const cloud = ctx.cloud;
    const list = () => tickets.map((t) => `- ${t.id} (${t.kind}, ${t.status}${t.attempts ? `, attempt ${t.attempts}` : ''}): ${t.title}${t.note ? ` — ${t.note}` : ''}`).join('\n');

    // the board the run page shows: each ticket's state now, saved on the run after every change
    const publish = () => {
        run.appTickets = tickets.map((t) => ({
            id: t.id, kind: t.kind, title: t.title, status: t.status, attempts: t.attempts, note: t.note,
            depends_on: t.depends_on, decision: t.decision, child: t.child, diffStat: t.diffStat || '', result: t.result ? String(t.result).slice(0, 400) : null,
        }));
        manager.save(run);
    };
    // a finished worker's branch goes into the app's branch, as the swarm merges its parts
    const merge = async (t, child) => {
        if (cloud && sandbox.importBranches) await sandbox.importBranches([child.branch]);
        try {
            await sandbox.git(['-c', 'user.name=Bright Chat runner', '-c', 'user.email=runner@localhost', 'merge', '--no-ff', '-q', '-m', `Merge ${child.branch}: ${t.title}`, child.branch]);
            t.status = 'done';
            t.note = 'merged';
            t.diffStat = child.result?.diffStat || '';
            manager.event(run, { type: 'note', text: `Merged “${t.title}” (${child.branch}).` });
        } catch (err) {
            await sandbox.git(['merge', '--abort']).catch(() => {});
            failed(t, 'its work conflicts with what is already merged');
            manager.event(run, { type: 'note', text: `Could not merge “${t.title}”: ${err.message.split('\n')[0]}` });
        }
    };
    const failed = (t, why) => {
        t.lastError = why;
        t.adviceFresh = false;
        t.status = t.attempts >= MAX_ATTEMPTS ? 'failed' : 'needs_advice';
        t.note = t.status === 'failed' ? `given up after ${t.attempts} tries: ${why}` : `failed (${why}); ask the advisor before trying again`;
        manager.event(run, { type: 'note', text: `“${t.title}” ${t.status === 'failed' ? 'was given up' : 'failed'}: ${why}.` });
    };
    // look at every running worker that has finished, and settle its ticket
    const reap = async () => {
        for (const t of tickets) {
            if (t.status !== 'running') continue;
            const child = manager.get(t.child);
            if (!child || !TERMINAL.has(child.status)) continue;
            if (child.status !== 'done') { failed(t, child.error || child.status); continue; }
            if (t.kind === 'research') { t.status = 'done'; t.result = child.result?.summary || ''; t.note = 'answered'; continue; }
            if (!child.result?.commit) { t.status = 'done'; t.note = 'changed nothing'; continue; }
            await merge(t, child);
        }
        cascade(tickets, byId);
        publish();
    };
    const running = () => tickets.filter((t) => t.status === 'running').length;
    const pendingWork = () => tickets.some((t) => ['todo', 'running', 'needs_advice'].includes(t.status));

    const dispatch = (t) => {
        if (!t) return 'There is no ticket with that id.';
        if (t.kind === 'decision') return `${t.id} is a decision ticket: ask_person settles it.`;
        if (t.status === 'running') return `${t.id} is already running.`;
        if (SETTLED.has(t.status)) return `${t.id} is ${t.status}; there is nothing to dispatch.`;
        if (t.status === 'needs_advice' && !t.adviceFresh) return `${t.id} failed. Call ask_advisor with ticket_id "${t.id}" first, then dispatch it again.`;
        if (t.status === 'todo' && !ready(t, byId)) return `${t.id} is waiting for ${t.depends_on.filter((d) => byId.get(d).status !== 'done').join(', ')}.`;
        if (running() >= MAX_WORKERS) return `${MAX_WORKERS} workers are already running. Call wait, then dispatch.`;
        const dependsOnBuild = t.depends_on.some((d) => byId.get(d).kind === 'build' && byId.get(d).status === 'done');
        if (cloud && dependsOnBuild) {
            t.status = 'skipped';
            t.note = 'builds on work already merged, which needs the local sandbox';
            return `${t.id} was left out: ${t.note}.`;
        }
        const base = cloud ? run.base : run.branch;
        const child = manager.create({
            owner: run.owner, goal: taskFor(t, byId, run.goal), repo: run.repo, base, parent: run.id,
            workflow: t.kind === 'research' ? 'research' : 'general', model: MODELS.worker, effort: EFFORTS.worker,
            sandbox: run.sandbox, maxMinutes: run.maxMinutes, maxCost: run.maxCost, maxSteps: 0,
        });
        t.child = child.id;
        t.status = 'running';
        t.attempts += 1;
        t.adviceFresh = false;
        (run.children ||= []).push(child.id);
        manager.event(run, { type: 'note', text: `Started a worker for “${t.title}” (try ${t.attempts}).` });
        publish();
        return `Started a worker for ${t.id} (try ${t.attempts}).`;
    };

    const finished = () => {
        const left = tickets.filter((t) => !SETTLED.has(t.status));
        if (left.length) return { text: `Not finished yet: ${left.map((t) => `${t.id} (${t.status})`).join(', ')}. Work through them first.` };
        return null;
    };

    const result = await converse(ctx, {
        label: 'Orchestrator', model: MODELS.orchestrator, effort: EFFORTS.orchestrator, system: ORCHESTRATOR_SYSTEM,
        messages: [{ role: 'user', content: `The app: ${run.goal}\n\nThe ticket draft:\n${list()}` }],
        tools: ORCHESTRATOR_TOOLS, maxSteps: MAX_ORCH_STEPS,
        act: async (name, args) => {
            await reap();
            if (name === 'status') return { text: list() };
            if (name === 'dispatch') return { text: dispatch(byId.get(String(args.ticket_id || ''))) };
            if (name === 'wait') {
                // until one of the running workers has finished (its ticket is settled or needs advice)
                const before = running();
                while (before && running() >= before && !ctx.live.stopped && Date.now() < ctx.deadline) {
                    await sleep(manager.pollMs);
                    await reap();
                }
                return { text: list() };
            }
            if (name === 'ask_person') {
                const t = args.ticket_id ? byId.get(String(args.ticket_id)) : null;
                if (args.ticket_id && (!t || t.kind !== 'decision')) return { text: `“${args.ticket_id}” is not a decision ticket, so the answer cannot settle it. Ask without ticket_id.` };
                const options = (Array.isArray(args.options) ? args.options : []).map(String).filter(Boolean).slice(0, 4);
                const got = await askPerson(ctx, { id: t ? t.id : 'question', question: String(args.question || '').slice(0, 1000), options });
                if (got.status !== 'finished') return { done: got, text: 'stopped' };
                if (t) {
                    t.decision = got.answer || '';
                    t.status = 'done';
                    t.note = got.answer ? `decided: ${got.answer}` : 'left open by the person';
                    cascade(tickets, byId);
                    publish();
                }
                return { text: got.answer ? `The person answered: ${got.answer}` : 'The person did not answer; the workers will choose the simplest option.' };
            }
            if (name === 'ask_advisor') {
                const answer = await adviseOnce(ctx, String(args.question || ''), String(args.context || ''));
                const t = args.ticket_id ? byId.get(String(args.ticket_id)) : null;
                if (t && t.status === 'needs_advice') { t.advice.push(answer); t.adviceFresh = true; }
                return { text: answer };
            }
            if (name === 'finish') {
                const left = finished();
                if (left) return { text: left.text };
                const built = tickets.filter((t) => t.status === 'done' && t.kind !== 'decision');
                const summary = [
                    `Built ${built.filter((t) => t.kind === 'build').length} of ${tickets.filter((t) => t.kind === 'build').length} build tickets.`,
                    ...tickets.map((t) => `- ${t.id} [${t.kind}, ${t.status}]: ${t.title}${t.note ? ` (${t.note})` : ''}`),
                    ...(String(args.summary || '').trim() ? ['', String(args.summary).trim().slice(0, 4000)] : []),
                ].join('\n');
                const status = tickets.every((t) => t.status === 'done') ? 'finished' : 'incomplete';
                return { done: { status, summary } };
            }
            return { text: `There is no tool named ${name}.` };
        },
    });
    return result;
}

/** Run the whole flow for one app run. Returns { status, summary } like the swarm does. */
async function executeAppFlow(manager, run, live) {
    const { createSandbox, isCloud } = require('./sandbox');
    const sandbox = await createSandbox({ kind: run.sandbox || manager.sandboxKind, repo: run.repo, dir: path.join(manager.dir, run.id, 'work'), branch: run.branch, base: run.base || 'HEAD' });
    live.sandbox = sandbox;
    run.base = sandbox.base;
    if (isCloud(sandbox.kind)) { run.sandboxId = sandbox.id; manager.save(run); }
    manager.event(run, { type: 'note', text: `Building the app on branch ${run.branch} from ${sandbox.base.slice(0, 10)}.` });
    const files = (await sandbox.git(['ls-files'])).split('\n').filter(Boolean);
    const ctx = { manager, run, live, sandbox, cloud: isCloud(sandbox.kind), n: 0, advice: 0, deadline: Date.now() + run.maxMinutes * 60000 };

    const planned = await planApp(ctx, files);
    if (planned.status !== 'finished') return { status: planned.status, summary: `Planning: ${planned.summary || 'stopped.'}` };
    const draft = planned.draft;
    manager.event(run, { type: 'plan', text: draft.tickets.map((t, i) => `${i + 1}. [${t.kind}] ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(', ')})` : ''}`).join('\n') });
    run.appDraft = { goal: draft.goal, tickets: draft.tickets.map(({ id, kind, title, depends_on }) => ({ id, kind, title, depends_on })) };
    manager.save(run);

    run.appTickets = draft.tickets.map((t) => ({ id: t.id, kind: t.kind, title: t.title, status: t.status, attempts: 0, note: null, depends_on: t.depends_on, decision: null, child: null, diffStat: '', result: null }));
    manager.save(run);
    const built = await traverse(ctx, draft);
    if (live.stopped) {
        for (const id of run.children || []) { try { manager.stop(id); } catch { /* already finished */ } }
        return { status: 'stopped', summary: 'Stopped by a person.' };
    }
    return built;
}

module.exports = { executeAppFlow, planApp, traverse, readDraft, cascade, ready, taskFor, MODELS, EFFORTS, PLANNER_TOOLS, ORCHESTRATOR_TOOLS, MAX_WORKERS, MAX_ATTEMPTS, MAX_QUESTIONS };
