// Runs: start an agent on a goal in a worktree of a repo, keep its record
// (runs/<id>/run.json), and let a person approve what the command guard
// wants a decision on. One run = one branch, harness/<id>, in the user's repo.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { LocalSandbox } = require('./sandbox');
const { makeTools } = require('./tools');
const { runAgent, stageSystem } = require('./agent');
const workflows = require('../utils/workflows');
const swarm = require('./swarm');

const MAX_EVENTS = 2000;
const EVENT_TEXT = 3000;
const APPROVAL_WAIT_MS = 15 * 60 * 1000;
const MAX_AUTO_DEBUG = 2;     // debug runs of a debug run, so a hopeless failure can't loop
const MAX_DEBUG_DEPTH = 5;    // the deepest chain of retries a person may start by hand
const DIAGNOSIS_CHARS = 6000; // how much of the failure a retry is told about
const EFFORTS = new Set(['min', 'low', 'medium', 'high', 'max']);
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = EVENT_TEXT) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}… [${v.length - n} more characters]` : v);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Write a file the way a reader never sees it half-written, but survive Windows:
 * there a virus scanner or the search indexer can hold run.json open for a moment,
 * and the rename fails with EPERM even though the file is ours. Try the rename a
 * few times, then write in place.
 */
function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(tmp, file); return; } catch (err) {
            if (!LOCKED.has(err.code) || attempt >= 3) {
                try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
                fs.writeFileSync(file, text);
                return;
            }
            pause(20 * (attempt + 1));
        }
    }
}

/** What went wrong in a finished run, as a note to the next attempt. */
function diagnosis(run) {
    const parts = [`This is another attempt at the task above. The earlier attempt (${run.id}, branch ${run.branch}) ended as ${run.status}.`];
    if (run.error) parts.push(`It stopped with this error:\n${run.error}`);
    if (run.result?.summary) parts.push(`What it reported:\n${short(run.result.summary, 1500)}`);
    if (run.result?.tests && !run.result.tests.passed) {
        parts.push(`Its test command failed (${run.result.tests.command}${run.result.tests.timedOut ? ', timed out' : `, exit code ${run.result.tests.code}`}):\n${short(run.result.tests.output || '', 2000)}`);
    }
    const line = (e) => {
        if (e.type === 'tool') return `- used ${e.name} ${e.args?.command ?? e.args?.path ?? ''}`.trim();
        if (e.type === 'result') return `  → ${String(e.text || '').split('\n')[0].slice(0, 200)}`;
        if (e.type === 'note') return `- ${e.text}`;
        if (e.type === 'stage') return `- ${e.text}`;
        return '';
    };
    const tail = run.events.slice(-40).map(line).filter(Boolean).join('\n');
    if (tail) parts.push(`The last things it did:\n${tail}`);
    parts.push('Work out from the above and from the code what actually went wrong, then finish the task. Do not repeat an approach that already failed; if the failure was environmental (a missing tool, a timeout, a file held open), say so and do the step again differently.');
    const text = parts.join('\n\n');
    return text.length > DIAGNOSIS_CHARS ? `${text.slice(0, DIAGNOSIS_CHARS)}\n… [cut]` : text;
}

class RunManager {
    /**
     * dir: where runs are kept. roots: folders repos may be in.
     * harnessUrl/password: the Interceptor, for model calls and the guard.
     */
    constructor({ dir, roots, harnessUrl = 'http://localhost:3000', password = '', maxRuns = 2, retryDelayMs = 3000, pollMs = 1000, autoDebug = false }) {
        this.pollMs = pollMs;
        this.dir = dir;
        this.roots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
        this.harnessUrl = harnessUrl.replace(/\/$/, '');
        this.password = password;
        this.maxRuns = maxRuns;
        this.retryDelayMs = retryDelayMs;
        this.autoDebugDefault = Boolean(autoDebug); // for new runs (RUNNER_AUTO_DEBUG)
        this.runs = new Map();      // id -> record
        this.live = new Map();      // id -> { sandbox, stop, resolve }
        this.queue = [];
        fs.mkdirSync(dir, { recursive: true });
        this.load();
    }

    load() {
        for (const id of fs.readdirSync(this.dir)) {
            try {
                const run = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'run.json'), 'utf8'));
                if (['queued', 'running', 'waiting'].includes(run.status)) {
                    run.status = 'failed';
                    run.error = 'The runner was restarted while this was running.';
                    run.pending = null;
                    run.ended = new Date().toISOString();
                    this.save(run);
                }
                this.runs.set(run.id, run);
            } catch { /* not a run folder */ }
        }
    }

    save(run) {
        const file = path.join(this.dir, run.id, 'run.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(run));
    }

    summary(run) {
        const { events, ...rest } = run;
        return { ...rest, eventCount: events.length };
    }

    list() { return [...this.runs.values()].sort((a, b) => b.created.localeCompare(a.created)).map((r) => this.summary(r)); }
    get(id) { return this.runs.get(id) || null; }

    /** Git repos a run may start in: the roots themselves and their direct children. */
    repos() {
        const out = [];
        for (const root of this.roots) {
            const candidates = [root];
            try { for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) candidates.push(path.join(root, e.name)); } catch { /* missing root */ }
            for (const c of candidates) if (fs.existsSync(path.join(c, '.git'))) out.push(c);
        }
        return out;
    }

    /**
     * List the sub-folders of a folder inside the allowed roots, for the folder picker.
     * No path lists the roots themselves. Each entry says whether it is a git repo.
     */
    browse(dir) {
        const entry = (p) => ({ name: path.basename(p) || p, path: p, git: fs.existsSync(path.join(p, '.git')) });
        const roots = this.roots.filter((r) => fs.existsSync(r));
        if (!dir && roots.length === 1) dir = roots[0]; // one allowed folder: start inside it
        if (!dir) return { path: '', parent: null, git: false, entries: roots.map(entry) };
        let real;
        try { real = fs.realpathSync(String(dir)); } catch { throw new Error(`${dir} does not exist`); }
        if (!fs.statSync(real).isDirectory()) throw new Error(`${dir} is not a folder`);
        const inRoot = this.roots.find((r) => real === r || real.startsWith(r + path.sep));
        if (!inRoot) throw new Error(`${dir} is not inside an allowed folder (${this.roots.join(', ') || 'none; set RUNNER_ROOTS'})`);
        let entries = [];
        try {
            entries = fs.readdirSync(real, { withFileTypes: true })
                .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
                .map((e) => entry(path.join(real, e.name)));
        } catch { /* unreadable folder: show it empty */ }
        entries.sort((a, b) => (b.git - a.git) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return { path: real, parent: real !== inRoot ? path.dirname(real) : (roots.length > 1 ? '' : null), git: fs.existsSync(path.join(real, '.git')), entries };
    }

    checkRepo(repo) {
        if (typeof repo !== 'string' || !repo.trim()) throw new Error('repo is required');
        let real;
        try { real = fs.realpathSync(repo); } catch { throw new Error(`${repo} does not exist`); }
        if (!this.roots.some((r) => real === r || real.startsWith(r + path.sep))) {
            throw new Error(`${repo} is not inside an allowed folder (${this.roots.join(', ') || 'none; set RUNNER_ROOTS'})`);
        }
        return real;
    }

    create(cfg) {
        const goal = String(cfg?.goal || '').trim();
        if (!goal) throw new Error('goal is required');
        if (goal.length > 20000) throw new Error('goal is too long (20,000 characters at most)');
        const repo = this.checkRepo(cfg.repo);
        const num = (v, lo, hi, d) => (v === undefined || v === null || v === '' ? d : Math.min(hi, Math.max(lo, Math.floor(Number(v)) || d)));
        if (cfg.effort && !EFFORTS.has(cfg.effort)) throw new Error(`effort must be one of ${[...EFFORTS].join(', ')}`);
        const isSwarm = cfg.workflow === 'swarm';
        const workflow = isSwarm ? { id: 'swarm', name: 'Swarm' } : workflows.get(cfg.workflow || workflows.FALLBACK);
        if (!workflow) throw new Error(`no workflow named ${cfg.workflow}`);
        const id = `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
        const run = {
            id, goal, repo, kind: isSwarm ? 'swarm' : 'run', parent: cfg.parent ? String(cfg.parent) : null, children: [], parts: null, workflow: workflow.id, workflowName: workflow.name, stage: null, base: cfg.base ? String(cfg.base) : null, branch: `harness/${id}`,
            profile: cfg.profile ? String(cfg.profile) : null, model: cfg.model ? String(cfg.model) : null, effort: cfg.effort || null,
            test: cfg.test ? String(cfg.test).slice(0, 500) : null,
            maxSteps: num(cfg.maxSteps, 1, 200, 40), maxMinutes: num(cfg.maxMinutes, 1, 240, 30),
            autoDebug: num(cfg.autoDebug, 0, 1, this.autoDebugDefault ? 1 : 0) === 1,
            debugOf: cfg.debugOf ? String(cfg.debugOf) : null, debugDepth: num(cfg.debugDepth, 0, 9, 0), debugRun: null,
            status: 'queued', created: new Date().toISOString(), started: null, ended: null,
            steps: 0, tokens: { in: 0, out: 0 }, pending: null, events: [], result: null, error: null,
        };
        this.runs.set(id, run);
        this.save(run);
        this.queue.push(id);
        this.pump();
        return this.summary(run);
    }

    pump() {
        const working = () => [...this.live.values()].filter((l) => !l.swarm).length;
        // a swarm only waits for its workers, so it doesn't take a place from them
        while (this.queue.length && (working() < this.maxRuns || this.runs.get(this.queue[0])?.kind === 'swarm')) {
            const id = this.queue.shift();
            const run = this.runs.get(id);
            if (run?.status === 'queued') this.execute(run).catch(() => {});
        }
    }

    event(run, e) {
        run.events.push({ t: new Date().toISOString(), ...e, ...(e.text !== undefined ? { text: short(e.text) } : {}), ...(e.args !== undefined ? { args: this.shortArgs(e.args) } : {}) });
        if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
        if (e.type === 'step') run.steps += 1;
        if (e.type === 'model' && e.usage) { run.tokens.in += e.usage.prompt_tokens || 0; run.tokens.out += e.usage.completion_tokens || 0; }
        this.save(run);
    }

    shortArgs(args) {
        if (!args || typeof args !== 'object') return short(args);
        return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, short(v, 600)]));
    }

    headers(run, n) {
        const h = { 'content-type': 'application/json', 'x-harness-request-id': `run-${run.id}-${n}` };
        if (this.password) h['x-harness-password'] = this.password;
        if (run.model) h['x-harness-model'] = run.model;
        if (run.profile) h['x-harness-profile'] = run.profile;
        if (run.effort) h['x-harness-effort'] = run.effort;
        return h;
    }

    async chat(run, messages, tools, n) {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await sleep(this.retryDelayMs * attempt * attempt);
            try {
                const res = await fetch(`${this.harnessUrl}/v1/chat/completions`, {
                    method: 'POST', headers: this.headers(run, n), signal: AbortSignal.timeout(6 * 60 * 1000),
                    body: JSON.stringify({ model: 'auto', messages, tools, tool_choice: 'auto', stream: false }),
                });
                const body = await res.json().catch(() => ({}));
                if (res.ok) {
                    const message = body.choices?.[0]?.message;
                    if (!message) throw new Error('the model answered with no message');
                    return { message, usage: body.usage, model: body.model };
                }
                lastError = new Error(`the harness answered HTTP ${res.status}: ${short(JSON.stringify(body.error || body), 300)}`);
                if (![429, 502, 503, 504].includes(res.status)) throw lastError;
            } catch (err) {
                lastError = err;
                if (err.message.startsWith('the harness answered HTTP') && !/HTTP (429|50[234])/.test(err.message)) throw err;
            }
        }
        throw lastError;
    }

    async guard(kind, text) {
        const body = kind === 'write' ? { tool: 'Write', path: text } : { tool: 'Bash', command: text };
        const headers = { 'content-type': 'application/json', ...(this.password ? { 'x-harness-password': this.password } : {}) };
        const res = await fetch(`${this.harnessUrl}/v1/guard`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    waitForApproval(run, live, info) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => settle(false, 'no one answered in 15 minutes'), APPROVAL_WAIT_MS);
            const settle = (allowed, why) => {
                clearTimeout(timer);
                live.resolve = null;
                run.pending = null;
                run.status = 'running';
                this.event(run, { type: 'approval', allowed, ...info, why });
                resolve(allowed);
            };
            live.resolve = (allowed) => settle(allowed, allowed ? 'allowed' : 'declined');
            run.pending = { ...info, at: new Date().toISOString() };
            run.status = 'waiting';
            this.event(run, { type: 'approval_needed', ...info });
        });
    }

    async swarmRun(run, live) {
        const outcome = await swarm.executeSwarm(this, run, live);
        return { sandbox: live.sandbox, outcome };
    }

    async plainRun(run, live, nextN) {
        live.sandbox = await LocalSandbox.create({ repo: run.repo, dir: path.join(this.dir, run.id, 'work'), branch: run.branch, base: run.base || 'HEAD' });
        const sandbox = live.sandbox;
        run.base = sandbox.base;
        this.event(run, { type: 'note', text: `Working on branch ${run.branch} from ${sandbox.base.slice(0, 10)}.` });
        const files = (await sandbox.git(['ls-files'])).split('\n').filter(Boolean);
        const context = `The workspace has ${files.length} tracked files. First ones:\n${files.slice(0, 150).join('\n')}${files.length > 150 ? '\n…' : ''}`;
        const workflow = workflows.get(run.workflow) || workflows.get(workflows.FALLBACK);
        const deadline = Date.now() + run.maxMinutes * 60000;
        return { sandbox, outcome: await this.runStages({ run, live, sandbox, workflow, context, deadline, nextN }) };
    }

    async execute(run) {
        const live = { sandbox: null, stopped: false, resolve: null, swarm: run.kind === 'swarm' };
        this.live.set(run.id, live);
        run.status = 'running';
        run.started = new Date().toISOString();
        this.save(run);
        let n = 0;
        try {
            const { sandbox, outcome } = run.kind === 'swarm' ? await this.swarmRun(run, live) : await this.plainRun(run, live, () => ++n);
            let commit = await sandbox.commit(`harness run ${run.id}: ${run.goal.split('\n')[0].slice(0, 60)}`);
            // a swarm's changes are already committed as merges
            if (!commit && run.kind === 'swarm') { const head = (await sandbox.git(['rev-parse', 'HEAD'])).trim(); if (head !== run.base) commit = head; }
            const result = { summary: outcome.summary, commit, diffStat: await sandbox.diffStat(), tests: null };
            if (run.test && !live.stopped) {
                this.event(run, { type: 'note', text: `Running the test command: ${run.test}` });
                const t = await sandbox.exec(run.test, { timeoutMs: 600000 });
                result.tests = { command: run.test, passed: t.code === 0 && !t.timedOut, code: t.code, timedOut: t.timedOut, output: t.output.slice(-4000) };
            }
            run.result = result;
            run.status = { finished: 'done', stopped: 'stopped' }[outcome.status] || 'incomplete';
        } catch (err) {
            run.status = live.stopped ? 'stopped' : 'failed';
            run.error = err.message;
            this.event(run, { type: 'note', text: `Error: ${err.message}` });
        } finally {
            run.pending = null;
            run.ended = new Date().toISOString();
            this.save(run);
            this.live.delete(run.id);
            this.startAutoDebug(run);
            this.pump();
        }
    }

    /** What the run being retried or debugged did and got wrong, for its successor. */
    brief(id) {
        const from = this.runs.get(id);
        return from ? diagnosis(from) : '';
    }

    /**
     * With auto debug on, a run that failed or gave up is followed by a debug run
     * that is told what went wrong, and so on for at most MAX_AUTO_DEBUG
     * generations, so a failure that cannot be fixed from here stops on its own.
     */
    startAutoDebug(run) {
        if (!run.autoDebug || run.debugRun || run.parent || run.kind === 'swarm') return;
        if (!['failed', 'incomplete'].includes(run.status)) return;
        if (run.debugDepth >= MAX_AUTO_DEBUG) {
            this.event(run, { type: 'note', text: `Auto debug has tried ${MAX_AUTO_DEBUG} times already; stopping here for a person to look.` });
            return;
        }
        try {
            const made = this.retry(run.id, { debug: true });
            this.event(run, { type: 'note', text: `Auto debug started ${made.id}, which is told what went wrong here.` });
        } catch (err) {
            this.event(run, { type: 'note', text: `Auto debug could not start: ${err.message}` });
        }
    }

    /**
     * Run a workflow's stages in order in one sandbox. Each stage is its own
     * agent loop with its own prompt, tools and effort, and gets the earlier
     * stages' summaries. A verdict stage that says FAIL sends the run back to
     * its retryTo stage (maxRetries times), with what was wrong.
     */
    async runStages({ run, live, sandbox, workflow, context, deadline, nextN }) {
        const notes = [];
        const retries = {};
        // a retry or a debug run is told what the attempt before it got wrong
        const brief = run.debugOf && !run.briefGiven ? this.brief(run.debugOf) : '';
        if (brief) run.briefGiven = true;
        let outcome = { status: 'finished', summary: '' };
        for (let i = 0; i < workflow.stages.length; i++) {
            const stage = workflow.stages[i];
            run.stage = stage.id;
            this.event(run, { type: 'stage', stage: stage.id, role: stage.role, text: `Stage ${i + 1} of ${workflow.stages.length}: ${stage.role}` });
            const tools = makeTools({
                sandbox, toolset: stage.tools,
                check: (kind, text) => this.guard(kind, text),
                approve: (info) => (live.stopped ? Promise.resolve(false) : this.waitForApproval(run, live, info)),
            });
            const handoff = notes.map((n) => `## ${n.role} (${n.stage})\n${n.summary}`).join('\n\n');
            // the stage's effort replaces the run's only when the person set none
            const stageRun = run.effort || !stage.effort ? run : { ...run, effort: stage.effort };
            outcome = await runAgent({
                run: { goal: run.goal, maxSteps: Math.min(stage.maxSteps, run.maxSteps), deadline, stopped: () => live.stopped },
                tools, system: stageSystem(stage), emit: (e) => this.event(run, { ...e, stage: stage.id }),
                firstContext: `${context}${brief ? `\n\n${brief}` : ''}${handoff ? `\n\nWhat earlier stages found or did:\n${handoff}` : ''}`,
                chat: (messages, defs) => this.chat(stageRun, messages, defs, nextN()),
            });
            notes.push({ stage: stage.id, role: stage.role, summary: outcome.summary });
            if (outcome.status !== 'finished') break;
            if (stage.verdict && /^\W*FAIL/i.test(outcome.summary)) {
                retries[stage.id] = (retries[stage.id] || 0) + 1;
                if (retries[stage.id] <= stage.maxRetries) {
                    this.event(run, { type: 'note', text: `${stage.role} said FAIL; going back to ${stage.retryTo}.` });
                    i = workflow.stages.findIndex((s) => s.id === stage.retryTo) - 1;
                    continue;
                }
                this.event(run, { type: 'note', text: `${stage.role} still says FAIL; stopping here for a person to look.` });
                outcome = { status: 'incomplete', summary: outcome.summary };
                break;
            }
        }
        run.stage = null;
        if (workflow.stages.length > 1) outcome.summary = notes.map((n) => `${n.role}: ${n.summary}`).join('\n\n');
        return outcome;
    }

    /**
     * Start the same task again, on a fresh branch from the same start, told what
     * went wrong last time. `from` is the id of the run to retry (or to debug).
     */
    retry(id, { debug = false } = {}) {
        const from = this.runs.get(id);
        if (!from) throw new Error('no such run');
        if (from.parent) throw new Error('this is one part of a swarm; retry the swarm instead');
        if (['queued', 'running', 'waiting'].includes(from.status)) throw new Error('stop the run first');
        if (from.kind === 'swarm' && !debug) throw new Error('a swarm cannot be retried as it is; use Debug');
        if (debug && ['done', 'queued', 'running', 'waiting'].includes(from.status)) throw new Error('that run did not fail, so there is nothing to debug');
        const cfg = {
            goal: from.goal, repo: from.repo, base: from.base || 'HEAD', workflow: from.workflow, profile: from.profile,
            model: from.model, effort: from.effort, test: from.test, maxSteps: from.maxSteps, maxMinutes: from.maxMinutes, autoDebug: from.autoDebug,
            // a debug run of a debug run is allowed, but only so deep, so a failure that cannot be fixed stops here
            ...(debug ? { debugOf: from.id, debugDepth: from.debugDepth + 1 } : {}),
        };
        if (cfg.debugDepth > MAX_DEBUG_DEPTH) throw new Error(`this has already been retried ${cfg.debugDepth - 1} times`);
        const made = this.createDebug(cfg, from, debug);
        return made;
    }

    /** create() plus the record of which run it is retrying. */
    createDebug(cfg, from, debug) {
        const summary = this.create(cfg);
        const run = this.runs.get(summary.id);
        from.debugRun = run.id;
        this.save(from);
        this.event(run, { type: 'note', text: debug ? `Debugging ${from.id} (which ended as ${from.status}).` : `Retry of ${from.id}.` });
        return summary;
    }

    approve(id, allow) {
        const live = this.live.get(id);
        if (!live?.resolve) throw new Error('nothing is waiting for approval');
        live.resolve(Boolean(allow));
    }

    stop(id) {
        const run = this.runs.get(id);
        if (!run) throw new Error('no such run');
        if (run.status === 'queued') {
            run.status = 'stopped';
            run.ended = new Date().toISOString();
            this.save(run);
            return;
        }
        const live = this.live.get(id);
        if (!live) throw new Error('this run is not running');
        live.stopped = true;
        live.resolve?.(false);
        live.sandbox?.stop();
    }

    /** What the run changed, from the repo's own copy of its branch (it outlives the workspace). */
    diff(id, limit = 200000) {
        const run = this.runs.get(id);
        if (!run?.result?.commit) return Promise.resolve('');
        return new Promise((resolve) => execFile('git', ['-C', run.repo, 'diff', `${run.base}..${run.branch}`], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
            const text = out || '';
            resolve(text.length > limit ? `${text.slice(0, limit)}\n[... diff cut at ${limit} characters ...]` : text);
        }));
    }

    /** Remove a finished run's workspace and record. The branch stays in the repo. */
    async remove(id) {
        const run = this.runs.get(id);
        if (!run) throw new Error('no such run');
        if (this.live.has(id) || run.status === 'queued') throw new Error('stop the run first');
        const dir = path.join(this.dir, id, 'work');
        await new LocalSandbox({ dir, repo: run.repo, branch: run.branch, base: run.base }).destroy();
        fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
        this.runs.delete(id);
    }
}

module.exports = { RunManager, EFFORTS };
