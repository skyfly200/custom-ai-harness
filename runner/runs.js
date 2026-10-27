// Runs: start an agent on a goal in a worktree of a repo, keep its record
// (runs/<id>/run.json), and let a person approve what the command guard
// wants a decision on. One run = one branch, harness/<id>, in the user's repo.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createSandbox, attachSandbox, E2BSandbox, LocalSandbox } = require('./sandbox');
const { makeTools } = require('./tools');
const { runAgent, systemFor } = require('./agent');
const workflows = require('../utils/workflows');
const swarm = require('./swarm');
const { parseTickets } = require('./tickets');

const MAX_EVENTS = 2000;
const EVENT_TEXT = 3000;
const APPROVAL_WAIT_MS = 15 * 60 * 1000;
const MAX_AUTO_DEBUG = 2;     // debug runs of a debug run, so a hopeless failure can't loop
const MAX_DEBUG_DEPTH = 5;    // the deepest chain of retries a person may start by hand
const DIAGNOSIS_CHARS = 6000; // how much of the failure a retry is told about
// The statuses a run ends on when it ran out of steps or time rather than going wrong.
// Those are what Continue is for: Retry is for a run that failed.
const OUT_OF_LIMIT = new Set(['incomplete']);
const PARTIAL_CHARS = 8000;   // how much of what it was saying when it ran out a continue is told
const MAX_CONTINUES = 50;     // four times what a run of 200 steps and 240 minutes needs
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

/**
 * What a run that ran out of steps or time was doing, as a note to the part that
 * carries on. It is not a failure, so it is told what stands and what it was
 * saying, not what went wrong.
 */
function resumption(run) {
    const why = run.outOfSteps ? (run.maxSteps ? `all ${run.maxSteps} of its steps` : 'every step it was allowed') : `${run.maxMinutes} minutes`;
    const parts = [`This run is carried on from an earlier part of the same run (${run.id}, the same branch ${run.branch}), which used ${why} before it could finish.`];
    if (run.result?.commit) parts.push(`The work it did is committed on the branch: continue from there, and do not start the task over.`);
    else parts.push('It committed nothing, so the branch is as it started. Do not start the task over; carry on from what it said below.');
    if (run.result?.summary) parts.push(`Where it got to:\n${short(run.result.summary, 1500)}`);
    if (run.result?.tests && !run.result.tests.passed) {
        parts.push(`Its last test run failed (${run.result.tests.command}${run.result.tests.timedOut ? ', timed out' : `, exit code ${run.result.tests.code}`}):\n${short(run.result.tests.output || '', 1500)}`);
    }
    const line = (e) => {
        if (e.type === 'tool') return `- used ${e.name} ${e.args?.command ?? e.args?.path ?? ''}`.trim();
        if (e.type === 'result') return `  → ${String(e.text || '').split('\n')[0].slice(0, 200)}`;
        if (e.type === 'model' && e.text) return `- said: ${short(e.text, 600)}`;
        return '';
    };
    const tail = run.events.slice(-30).map(line).filter(Boolean).join('\n');
    if (tail) parts.push(`The last things it did:\n${tail}`);
    const said = run.partialSummary || run.partialText;
    if (said) parts.push(`What it was saying when the ${run.outOfSteps ? 'steps' : 'time'} ran out:\n${short(said, 3000)}`);
    parts.push('Check the state of the workspace first: it may have been partway through a change. Then finish the task. You have a full set of steps and minutes again, not what was left.');
    const text = parts.join('\n\n');
    return text.length > PARTIAL_CHARS ? `${text.slice(0, PARTIAL_CHARS)}\n… [cut]` : text;
}

class RunManager {
    /**
     * dir: where runs are kept. roots: folders repos may be in.
     * harnessUrl/password: the Interceptor, for model calls and the guard.
     */
    constructor({ dir, roots, harnessUrl = 'http://localhost:3000', password = '', maxRuns = 2, retryDelayMs = 3000, pollMs = 1000, autoDebug = false, sandbox = 'local' }) {
        this.pollMs = pollMs;
        this.dir = dir;
        this.roots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
        this.harnessUrl = harnessUrl.replace(/\/$/, '');
        this.password = password;
        this.maxRuns = maxRuns;
        this.retryDelayMs = retryDelayMs;
        this.autoDebugDefault = Boolean(autoDebug); // for new runs (RUNNER_AUTO_DEBUG)
        this.sandboxKind = sandbox === 'cloud' ? 'e2b' : sandbox; // local (a worktree here) or e2b (a cloud sandbox)
        this.runs = new Map();      // id -> record
        this.active = new Map();    // id -> the part a continued run is working as now
        this.live = new Map();      // id -> { sandbox, stop, resolve }
        this.queue = [];
        fs.mkdirSync(dir, { recursive: true });
        this.load();
    }

    load() {
        const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
        const wasRunning = (run) => {
            if (!['queued', 'running', 'waiting'].includes(run.status)) return false;
            run.status = 'failed';
            run.error = 'The runner was restarted while this was running.';
            run.pending = null;
            run.ended = new Date().toISOString();
            // its cloud sandbox would otherwise go on billing until E2B's own timeout
            if (run.sandboxId) E2BSandbox.destroyById(run.sandboxId).catch(() => {});
            return true;
        };
        for (const id of fs.readdirSync(this.dir)) {
            let run;
            try { run = read(path.join(this.dir, id, 'run.json')); } catch { continue; } // not a run folder
            // a continued run leaves a record of each part beside its own: a part that was
            // still working when the runner stopped is folded into the run, like a run is
            this.runs.set(run.id, run);
            const folder = path.join(this.dir, id);
            const files = fs.readdirSync(folder).filter((f) => /^leg-\d+\.json$/.test(f));
            const legs = files.map((f) => { try { return read(path.join(folder, f)); } catch { return null; } })
                .filter(Boolean).sort((a, b) => a.continues - b.continues);
            for (const leg of legs) {
                if (leg.continues <= (run.legs || 0)) continue; // handed over already
                wasRunning(leg);
                this.foldLeg(leg);
            }
            // the run's own record now holds what they did
            for (const f of files) fs.rmSync(path.join(folder, f), { force: true });
            if (wasRunning(run)) this.save(run);
        }
    }

    save(run) {
        // the record of a part of a continued run sits beside the run's own, so the run
        // itself keeps its id, goal and branch, and nothing is lost if the runner stops
        const file = path.join(this.dir, run.id, run.carriesOn ? `leg-${run.continues}.json` : 'run.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(run));
    }

    summary(run) {
        const { events, ...rest } = run;
        return { ...rest, eventCount: events.length };
    }

    list() {
        return [...this.runs.values()].map((r) => this.active.get(r.id) || r)
            .sort((a, b) => b.created.localeCompare(a.created)).map((r) => this.summary(r));
    }

    /** The run, or the part of it that is working now if it has been carried on. */
    get(id) { return this.active.get(id) || this.runs.get(id) || null; }

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
        // num() reads 0 as "no value, use the default", which is right for depths and
        // retries. For a limit, 0 is a real choice (no limit), so it needs its own.
        const num0 = (v, lo, hi, d) => {
            if (v === undefined || v === null || v === '') return d;
            const n = Math.floor(Number(v));
            return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
        };
        if (cfg.effort && !EFFORTS.has(cfg.effort)) throw new Error(`effort must be one of ${[...EFFORTS].join(', ')}`);
        const isSwarm = cfg.workflow === 'swarm';
        const workflow = isSwarm ? { id: 'swarm', name: 'Swarm' } : workflows.get(cfg.workflow || workflows.FALLBACK);
        if (!workflow) throw new Error(`no workflow named ${cfg.workflow}`);
        let tickets = null;
        if (cfg.tickets && String(cfg.tickets).trim()) {
            if (!isSwarm) throw new Error('a ticket draft needs the Swarm workflow');
            tickets = parseTickets(cfg.tickets).tickets;
        }
        const id = `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
        const run = {
            id, goal, repo, kind: isSwarm ? 'swarm' : 'run', parent: cfg.parent ? String(cfg.parent) : null, children: [], parts: null, tickets, workflow: workflow.id, workflowName: workflow.name, stage: null, base: cfg.base ? String(cfg.base) : null, branch: `harness/${id}`,
            profile: cfg.profile ? String(cfg.profile) : null, model: cfg.model ? String(cfg.model) : null, effort: cfg.effort || null,
            test: cfg.test ? String(cfg.test).slice(0, 500) : null,
            // Plan mode: the agent may read and search, but changes nothing. It
            // finishes with a plan instead of an edit, and the branch gets no commit.
            plan: cfg.plan === true || cfg.plan === 1 || cfg.plan === '1' || cfg.plan === 'true' || cfg.plan === 'plan',
            // 0 means no step limit: the agent runs until it calls finish, runs out of
            // time or is stopped. maxMinutes still bounds it, so it cannot run forever.
            maxSteps: num0(cfg.maxSteps, 0, 10000, 0), maxMinutes: num(cfg.maxMinutes, 1, 240, 30),
            autoDebug: num(cfg.autoDebug, 0, 1, this.autoDebugDefault ? 1 : 0) === 1,
            sandbox: this.sandboxKind, sandboxId: null,
            debugOf: cfg.debugOf ? String(cfg.debugOf) : null, debugDepth: num(cfg.debugDepth, 0, 9, 0), debugRun: null,
            // a run carried on after it ran out of steps or time: the same run and branch,
            // not a new one. continues counts the carries-on, legs the parts done so far and
            // carriesOn is the run this leg belongs to (null on the run itself).
            continues: num(cfg.continues, 0, MAX_CONTINUES, 0), carriesOn: cfg.carriesOn ? String(cfg.carriesOn) : null, legs: 0, resumeNote: null,
            outOfSteps: null, partialText: null, partialSummary: null,
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
            const run = this.active.get(id) || this.runs.get(id);
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
        // a part carried on from an earlier one takes the branch as it stands, with that part's work on it
        live.sandbox = await (run.carriesOn ? attachSandbox : createSandbox)({ kind: run.sandbox || this.sandboxKind, repo: run.repo, dir: path.join(this.dir, run.id, 'work'), branch: run.branch, base: run.base || 'HEAD' });
        const sandbox = live.sandbox;
        run.base = sandbox.base;
        if (sandbox.kind === 'e2b') { run.sandboxId = sandbox.id; this.save(run); }
        this.event(run, { type: 'note', text: `Working on branch ${run.branch} from ${sandbox.base.slice(0, 10)}${sandbox.kind === 'e2b' ? ` in an E2B sandbox (${sandbox.id})` : ''}.` });
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
            // Plan mode changes nothing, so there is nothing to commit and no branch to
            // hand back: the plan itself is the result.
            let commit = run.plan ? null : await sandbox.commit(`harness run ${run.id}: ${run.goal.split('\n')[0].slice(0, 60)}`);
            // a swarm's changes are already committed as merges
            if (!commit && run.kind === 'swarm') { const head = (await sandbox.git(['rev-parse', 'HEAD'])).trim(); if (head !== run.base) commit = head; }
            const result = { summary: outcome.summary, commit, diffStat: run.plan ? '' : await sandbox.diffStat(), tests: null };
            if (run.test && !live.stopped && !run.plan) {
                this.event(run, { type: 'note', text: `Running the test command: ${run.test}` });
                const t = await sandbox.exec(run.test, { timeoutMs: 600000 });
                result.tests = { command: run.test, passed: t.code === 0 && !t.timedOut, code: t.code, timedOut: t.timedOut, output: t.output.slice(-4000) };
            }
            run.result = result;
            // what it was saying when it ran out, kept for the part that carries on
            run.outOfSteps = outcome.status === 'out_of_steps';
            run.partialText = run.outOfSteps || outcome.status === 'out_of_time' ? outcome.partial || null : null;
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
            // a leg of a continued run hands its record back to the run itself
            if (run.carriesOn) this.foldLeg(run);
            // a cloud sandbox is billed by the minute, so it goes as soon as the run does; a local
            // worktree stays, so the run page keeps working and its branch can still be inspected
            if (live.sandbox?.kind === 'e2b') live.sandbox.destroy().catch(() => {});
            else await live.sandbox?.close?.();
            this.startAutoDebug(run);
            this.pump();
        }
    }

    /** What the run being retried or debugged did and got wrong, for its successor. */
    brief(id) {
        const from = this.get(id);
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
        // a retry or a debug run is told what the attempt before it got wrong, and a part
        // carried on from one that ran out of steps or time is told where that part got to
        const brief = !run.briefGiven ? (run.debugOf ? this.brief(run.debugOf) : String(run.resumeNote || '')) : '';
        if (brief) run.briefGiven = true;
        let outcome = { status: 'finished', summary: '' };
        for (let i = 0; i < workflow.stages.length; i++) {
            const stage = workflow.stages[i];
            run.stage = stage.id;
            this.event(run, { type: 'stage', stage: stage.id, role: stage.role, text: `Stage ${i + 1} of ${workflow.stages.length}: ${stage.role}` });
            const tools = makeTools({
                sandbox, toolset: run.plan ? 'read' : stage.tools,
                check: (kind, text) => this.guard(kind, text),
                approve: (info) => (live.stopped ? Promise.resolve(false) : this.waitForApproval(run, live, info)),
            });
            const handoff = notes.map((n) => `## ${n.role} (${n.stage})\n${n.summary}`).join('\n\n');
            // the stage's effort replaces the run's only when the person set none
            const stageRun = run.effort || !stage.effort ? run : { ...run, effort: stage.effort };
            outcome = await runAgent({
                run: { goal: run.goal, maxSteps: run.maxSteps ? Math.min(stage.maxSteps, run.maxSteps) : stage.maxSteps, deadline, stopped: () => live.stopped },
                tools, system: systemFor(stage, { plan: run.plan }), emit: (e) => this.event(run, { ...e, stage: stage.id }),
                firstContext: `${context}${brief ? `\n\n${brief}` : ''}${handoff ? `\n\nWhat earlier stages found or did:\n${handoff}` : ''}`,
                chat: (messages, defs) => this.chat(stageRun, messages, defs, nextN()),
            });
            if (outcome.status === 'out_of_steps') run.partialSummary = outcome.summary;
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
        const from = this.get(id);
        if (!from) throw new Error('no such run');
        if (from.parent) throw new Error('this is one part of a swarm; retry the swarm instead');
        if (['queued', 'running', 'waiting'].includes(from.status)) throw new Error('stop the run first');
        if (from.kind === 'swarm' && !debug) throw new Error('a swarm cannot be retried as it is; use Debug');
        // running out of steps or time is not a failure: that is what Continue is for
        if (OUT_OF_LIMIT.has(from.status)) throw new Error('that run only ran out of steps or time, so nothing went wrong: use Continue');
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

    /**
     * Carry a run that ran out of steps or time on, in the same run: same id, same
     * record, same branch, and the commits and uncommitted files the earlier part
     * left are still there for the agent to go on from. It is not a retry (nothing
     * went wrong) and it is not a new run.
     *
     * A leg is a run while it works, so the page shows it working and Stop ends it.
     * When the leg ends, what it did takes the run's place (run.legs counts the parts
     * done so far) and the record says how it stands, so the page is a run all along.
     */
    continueRun(id) {
        const run = this.runs.get(id);
        if (!run) throw new Error('no such run');
        if (run.parent) throw new Error('this is one part of a swarm; continue the swarm instead');
        if (run.kind === 'swarm') throw new Error('a swarm cannot be continued as it is');
        if (['queued', 'running', 'waiting'].includes(run.status)) throw new Error('stop the run first');
        if (run.status !== 'incomplete') throw new Error(`only a run that ran out of steps or time can be continued, not one that ended as ${run.status}`);
        const continues = (run.continues || 0) + 1;
        if (continues > MAX_CONTINUES) throw new Error(`this run has already been continued ${MAX_CONTINUES} times`);
        // what this part did, said now, while the run's record still holds it
        const resumeNote = resumption(run);
        const leg = {
            ...run, continues, carriesOn: run.id, briefGiven: false, resumeNote,
            result: null, error: null, pending: null, events: [], steps: 0,
            tokens: { in: run.tokens.in, out: run.tokens.out },
            status: 'queued', created: new Date().toISOString(), started: null, ended: null,
            outOfSteps: null, partialText: null, partialSummary: run.partialSummary || null,
        };
        // the leg works on behalf of the run: the run's own record stays as it is
        this.active.set(leg.id, leg);
        this.save(leg);
        this.event(leg, { type: 'note', text: `Carrying the run on after it ran out of ${run.outOfSteps ? 'steps' : 'time'}; it goes on from where the earlier part got to, on the same branch.` });
        this.queue.push(leg.id);
        this.pump();
        return this.summary(leg);
    }

    /** A finished leg of a continued run hands what it did to the run it carries on. */
    foldLeg(leg) {
        const root = this.runs.get(leg.carriesOn);
        if (!root) return;
        if (this.active.get(root.id) === leg) this.active.delete(root.id);
        const events = [...root.events, ...leg.events];
        Object.assign(root, leg, { id: root.id, branch: root.branch, carriesOn: null, resumeNote: null, parts: root.parts, children: root.children, legs: (root.legs || 0) + 1, events: events.slice(-MAX_EVENTS) });
        this.save(root);
        // the run's own record is the one record now
        fs.rmSync(path.join(this.dir, leg.id, `leg-${leg.continues}.json`), { force: true });
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
        const run = this.get(id);
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
        const run = this.runs.get(id) || this.active.get(id);
        if (!run?.result?.commit) return Promise.resolve('');
        return new Promise((resolve) => execFile('git', ['-C', run.repo, 'diff', `${run.base}..${run.branch}`], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
            const text = out || '';
            resolve(text.length > limit ? `${text.slice(0, limit)}\n[... diff cut at ${limit} characters ...]` : text);
        }));
    }

    /** Remove a finished run's workspace and record. The branch stays in the repo. */
    async remove(id) {
        const run = this.get(id);
        if (!run) throw new Error('no such run');
        if (this.live.has(id) || run.status === 'queued') throw new Error('stop the run first');
        const dir = path.join(this.dir, id, 'work');
        if (run.sandbox === 'e2b') {
            // the sandbox is gone, and with it the only copy of the tree it worked in; the branch it
            // handed back is what is left, so there is no worktree here to remove
            if (run.sandboxId) await E2BSandbox.destroyById(run.sandboxId);
        } else {
            await new LocalSandbox({ dir, repo: run.repo, branch: run.branch, base: run.base }).destroy();
        }
        fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
        this.runs.delete(id);
        this.active.delete(id);
    }
}

module.exports = { RunManager, EFFORTS };
