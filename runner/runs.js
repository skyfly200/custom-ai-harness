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
const { runAgent } = require('./agent');

const MAX_EVENTS = 2000;
const EVENT_TEXT = 3000;
const APPROVAL_WAIT_MS = 15 * 60 * 1000;
const EFFORTS = new Set(['min', 'low', 'medium', 'high', 'max']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = EVENT_TEXT) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}… [${v.length - n} more characters]` : v);

class RunManager {
    /**
     * dir: where runs are kept. roots: folders repos may be in.
     * harnessUrl/password: the Interceptor, for model calls and the guard.
     */
    constructor({ dir, roots, harnessUrl = 'http://localhost:3000', password = '', maxRuns = 2, retryDelayMs = 3000 }) {
        this.dir = dir;
        this.roots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
        this.harnessUrl = harnessUrl.replace(/\/$/, '');
        this.password = password;
        this.maxRuns = maxRuns;
        this.retryDelayMs = retryDelayMs;
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
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(run));
        fs.renameSync(`${file}.tmp`, file);
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
        const id = `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
        const run = {
            id, goal, repo, base: cfg.base ? String(cfg.base) : null, branch: `harness/${id}`,
            profile: cfg.profile ? String(cfg.profile) : null, model: cfg.model ? String(cfg.model) : null, effort: cfg.effort || null,
            test: cfg.test ? String(cfg.test).slice(0, 500) : null,
            maxSteps: num(cfg.maxSteps, 1, 200, 40), maxMinutes: num(cfg.maxMinutes, 1, 240, 30),
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
        while (this.live.size < this.maxRuns && this.queue.length) {
            const id = this.queue.shift();
            const run = this.runs.get(id);
            if (run?.status === 'queued') this.execute(run).catch(() => {});
        }
    }

    event(run, e) {
        run.events.push({ t: new Date().toISOString(), ...e, ...(e.text !== undefined ? { text: short(e.text) } : {}), ...(e.args !== undefined ? { args: this.shortArgs(e.args) } : {}) });
        if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
        if (e.type === 'step') run.steps = e.step;
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

    async execute(run) {
        const live = { sandbox: null, stopped: false, resolve: null };
        this.live.set(run.id, live);
        run.status = 'running';
        run.started = new Date().toISOString();
        this.save(run);
        let n = 0;
        try {
            live.sandbox = await LocalSandbox.create({ repo: run.repo, dir: path.join(this.dir, run.id, 'work'), branch: run.branch, base: run.base || 'HEAD' });
            const sandbox = live.sandbox;
            run.base = sandbox.base;
            this.event(run, { type: 'note', text: `Working on branch ${run.branch} from ${sandbox.base.slice(0, 10)}.` });
            const files = (await sandbox.git(['ls-files'])).split('\n').filter(Boolean);
            const context = `The workspace has ${files.length} tracked files. First ones:\n${files.slice(0, 150).join('\n')}${files.length > 150 ? '\n…' : ''}`;
            const tools = makeTools({
                sandbox,
                check: (kind, text) => this.guard(kind, text),
                approve: (info) => (live.stopped ? Promise.resolve(false) : this.waitForApproval(run, live, info)),
            });
            const outcome = await runAgent({
                run: { goal: run.goal, maxSteps: run.maxSteps, deadline: Date.now() + run.maxMinutes * 60000, stopped: () => live.stopped },
                tools, firstContext: context, emit: (e) => this.event(run, e),
                chat: (messages, defs) => this.chat(run, messages, defs, ++n),
            });
            const commit = await sandbox.commit(`harness run ${run.id}: ${run.goal.split('\n')[0].slice(0, 60)}`);
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
            this.pump();
        }
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
