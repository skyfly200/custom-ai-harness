// A place for an agent to work: a git worktree on a new branch of the user's
// repo, so the agent never touches the working copy and the result is a
// branch to inspect, test and push. Commands run here with a trimmed
// environment (no API keys).
//
// Three sandboxes offer the same methods (create, attach, resolve, readFile,
// writeFile, listDir, exec, stop, git, commit, diffStat, diff, destroy), so the
// tools and the runs never know which one they got. create starts a run's branch
// from a base commit; attach takes the branch as it stands, for carrying a run on
// after it hit its step or time limit:
//   LocalSandbox - a git worktree on this machine (the default).
//   E2BSandbox   - a cloud sandbox from E2B (kind e2b, needs E2B_API_KEY).
//   SpritesSandbox - a Fly Sprite (kind sprites, needs SPRITES_TOKEN).
// The two cloud ones share CloudSandbox. They have no copy of your repo to branch
// off, so the branch is made by handing them a git bundle of the base commit, and
// the branch they end on is handed back the same way before the run ends. A
// driver only says how to open one, how to tell a timeout from a failed command
// and how to delete one by id. Pick one per run (the run's `sandbox`), or set
// RUNNER_SANDBOX for the default; DRIVERS lists what exists.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const posix = path.posix;
const { spawn, execFile } = require('child_process');
const { PowerShellSession } = require('../utils/powershellSession');

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 120000;
// The ref a throwaway bundle is packed from, so a base that is not a branch tip can be sent whole
const PACK_REF = 'refs/harness-pack/base';
// Only these reach a command the agent runs: it must not be able to print the harness's API keys
const ENV_ALLOW = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'SHELL', 'TERM', 'CI'];

function git(cwd, args, { input } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).trim()));
            resolve(stdout);
        });
        if (input !== undefined) child.stdin.end(input);
    });
}

function trimOutput(text) {
    if (text.length <= MAX_OUTPUT) return text;
    const head = Math.floor(MAX_OUTPUT * 0.4), tail = MAX_OUTPUT - head;
    return `${text.slice(0, head)}\n[... ${text.length - MAX_OUTPUT} characters cut ...]\n${text.slice(-tail)}`;
}

const inside = (file, root) => {
    const rel = path.relative(root, file);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

class LocalSandbox {
    constructor({ dir, repo, branch, base }) {
        this.dir = dir;
        this.repo = repo;
        this.branch = branch;
        this.base = base;
        this.child = null;
        this.kind = 'local';
        this.id = null;
        this.powershell = null;
        // set by stop(): a worktree that is stopped starts no more commands, so a stop that
        // lands between two steps of a run can't be undone by the next command it asks for
        this.stopped = false;
    }

    /** A worktree of `repo` at `dir` on new branch `branch`, starting from `base` (default: the repo's current commit). */
    static async create({ repo, dir, branch, base = 'HEAD' }) {
        let top;
        try {
            top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
        } catch {
            throw new Error(`${repo} is not a git repository`);
        }
        const commit = (await git(top, ['rev-parse', '--verify', `${base}^{commit}`]).catch(() => { throw new Error(`${base} is not a commit in ${top}`); })).trim();
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await git(top, ['worktree', 'add', '-q', '-b', branch, dir, commit]);
        return new LocalSandbox({ dir: fs.realpathSync(dir), repo: top, branch, base: commit });
    }

    /**
     * The worktree a run already has, for carrying it on: the same folder when it
     * is still a worktree on the branch, or one made again from the branch (so the
     * commits the earlier part made are there). `base` is where the run started,
     * which the diff is measured from.
     */
    static async attach({ repo, dir, branch, base = 'HEAD' }) {
        let top;
        try {
            top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
        } catch {
            throw new Error(`${repo} is not a git repository`);
        }
        const start = (await git(top, ['rev-parse', '--verify', `${base}^{commit}`]).catch(() => { throw new Error(`${base} is not a commit in ${top}`); })).trim();
        // a part that ended before it committed anything has no branch yet: start it again
        if (!(await git(top, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).then((s) => s.trim()).catch(() => ''))) {
            await git(top, ['worktree', 'prune']).catch(() => {});
            return LocalSandbox.create({ repo: top, dir, branch, base: start });
        }
        const here = fs.existsSync(dir) ? fs.realpathSync(dir) : null;
        const on = here ? (await git(here, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() : '';
        if (on === branch) return new LocalSandbox({ dir: here, repo: top, branch, base: start });
        // the folder is gone, or is a worktree of something else: make it again on the branch
        if (here) await git(top, ['worktree', 'remove', '--force', dir]).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
        await git(top, ['worktree', 'prune']).catch(() => {});
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await git(top, ['worktree', 'add', '-q', dir, branch]);
        return new LocalSandbox({ dir: fs.realpathSync(dir), repo: top, branch, base: start });
    }

    /** The absolute path of `rel` inside the workspace, or an Error if it leads outside (links included). */
    resolve(rel) {
        const target = path.resolve(this.dir, String(rel ?? '.'));
        if (!inside(target, this.dir)) throw new Error(`${rel} is outside the workspace`);
        let probe = target;
        while (!fs.existsSync(probe)) probe = path.dirname(probe);
        if (!inside(fs.realpathSync(probe), this.dir)) throw new Error(`${rel} leads outside the workspace`);
        if (target.split(path.sep).includes('.git') && inside(target, this.dir)) throw new Error('the .git folder is off limits');
        return target;
    }

    readFile(rel) { return fs.readFileSync(this.resolve(rel), 'utf8'); }

    writeFile(rel, content) {
        const file = this.resolve(rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }

    listDir(rel) {
        return fs.readdirSync(this.resolve(rel), { withFileTypes: true })
            .filter((e) => e.name !== '.git')
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    }

    /** Run a shell command in the workspace. Resolves { code, output, timedOut, ms }; never rejects. */
    exec(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        if (this.stopped) return Promise.resolve({ code: -1, output: 'the workspace was stopped, so the command did not run', timedOut: false, ms: 0 });
        if (process.platform === 'win32') {
            if (!this.powershell) {
                const env = Object.fromEntries(ENV_ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
                this.powershell = new PowerShellSession(this.dir, env);
            }
            return this.powershell.run(command, timeoutMs).then((result) => ({ ...result, output: trimOutput(result.output) }));
        }
        return new Promise((resolve) => {
            const started = Date.now();
            const env = Object.fromEntries(ENV_ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
            const [bin, args] = ['bash', ['-c', command]];
            let output = '';
            let timedOut = false;
            let child;
            try {
                child = spawn(bin, args, { cwd: this.dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err) {
                return resolve({ code: -1, output: `could not start ${bin}: ${err.message}`, timedOut: false, ms: 0 });
            }
            this.child = child;
            const add = (d) => { if (output.length < MAX_OUTPUT * 4) output += d; };
            child.stdout.on('data', add);
            child.stderr.on('data', add);
            const timer = setTimeout(() => { timedOut = true; this.kill(child); }, timeoutMs);
            const finish = (code) => {
                clearTimeout(timer);
                if (this.child === child) this.child = null;
                resolve({ code, output: trimOutput(output), timedOut, ms: Date.now() - started });
            };
            child.on('error', (err) => { output += `\n${err.message}`; finish(-1); });
            child.on('close', (code) => finish(code ?? -1));
        });
    }

    kill(child = this.child) {
        this.stopped = true;
        this.close();
        if (!child?.pid) return;
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
    }

    close() {
        const session = this.powershell;
        this.powershell = null;
        return session?.close() || Promise.resolve();
    }

    stop() { this.stopped = true; this.kill(); }

    git(args) { return git(this.dir, args); }

    /** Commit everything the agent changed. Returns the new commit, or null if nothing changed. */
    async commit(message) {
        await git(this.dir, ['add', '-A']);
        if (!(await git(this.dir, ['status', '--porcelain'])).trim()) return null;
        await git(this.dir, ['-c', 'user.name=Bright Chat runner', '-c', 'user.email=runner@localhost', 'commit', '-q', '-m', message]);
        return (await git(this.dir, ['rev-parse', 'HEAD'])).trim();
    }

    async diffStat() { return (await git(this.dir, ['diff', '--stat', `${this.base}..HEAD`])).trim(); }

    async diff(limit = 200000) {
        const text = await git(this.dir, ['diff', `${this.base}..HEAD`]);
        return text.length > limit ? `${text.slice(0, limit)}\n[... diff cut at ${limit} characters ...]` : text;
    }

    /** Remove the worktree; the branch stays in the repo. */
    async destroy() {
        this.stopped = true;
        await this.close();
        if (this.child?.pid) this.kill(this.child);
        await git(this.repo, ['worktree', 'remove', '--force', this.dir]).catch(() => fs.rmSync(this.dir, { recursive: true, force: true }));
        await git(this.repo, ['worktree', 'prune']).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Cloud: the same workspace, in a sandbox in the cloud
// ---------------------------------------------------------------------------

// The provider kills the sandbox after this. A run's own limit (240 minutes at most) plus an
// hour, so a run that is carried on after it ran out of time still has a sandbox.
const SANDBOX_LIFETIME_MS = 5 * 60 * 60 * 1000;
const HOST_TMP = (name) => path.join(os.tmpdir(), `harness-${process.pid}-${Date.now()}-${name}`);

/**
 * Pack `commit` and everything it needs into a bundle, for a sandbox that has no
 * repo yet. `until` is the commit the sandbox already has, if any: what is packed
 * then is only what came after it.
 */
async function packRepo(repo, commit, until = null) {
    const file = HOST_TMP('base.bundle');
    try {
        // a ref of its own, so a commit that is not a branch tip still packs with its full history
        await git(repo, ['update-ref', PACK_REF, commit]);
        await git(repo, ['bundle', 'create', '-q', file, PACK_REF, ...(until ? ['--not', until] : [])]);
        const bytes = fs.readFileSync(file);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } finally {
        await git(repo, ['update-ref', '-d', PACK_REF]).catch(() => {});
        fs.rmSync(file, { force: true });
    }
}

class CloudSandbox {
    // what a driver sets
    static kind = 'cloud';
    static get workDir() { return '/home/user/work'; }
    /** Open an empty sandbox: resolves an object shaped like e2b's Sandbox (sandboxId, files, commands, kill). */
    static async open() { throw new Error('not implemented'); }
    /** { timedOut } or { exitCode, output } for an error a command run raised; null for any other error. */
    static classify() { return null; }
    static async destroyById() {}

    constructor({ sandbox, repo, branch, base }) {
        this.sandbox = sandbox;
        this.dir = this.constructor.workDir;
        this.repo = repo;
        this.branch = branch;
        this.base = base;
        this.handle = null;
        this.kind = this.constructor.kind;
        this.id = sandbox.sandboxId;
    }

    /**
     * A fresh cloud sandbox with `branch` checked out.
     *
     * adapt is null for a new run's branch, which is made from `base` (a commit in
     * `repo` on this machine) with its whole history. For a run carried on, adapt is
     * set and says
     * whether the branch already has commits from earlier: if it has any, the
     * sandbox is given the branch as it stands (so a part that ran out of time
     * keeps the work it committed); if it has none, the branch starts at `base`
     * as it did the first time.
     */
    static async create({ repo, branch, base = 'HEAD', adapt = null, template = null, lifetimeMs = SANDBOX_LIFETIME_MS }) {
        let top, commit, start = null;
        try {
            top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
        } catch {
            throw new Error(`${repo} is not a git repository`);
        }
        try {
            commit = (await git(top, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
        } catch {
            throw new Error(`${base} is not a commit in ${top}`);
        }
        if (adapt) start = (await git(top, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).then((s) => s.trim()).catch(() => '')) || null;
        // a branch that is where it started has nothing of its own to send: send it all
        if (start === commit) start = null;
        const from = start || commit;
        const sandbox = await this.open({ template, lifetimeMs });
        const box = new this({ sandbox, repo: top, branch, base: commit });
        try {
            const remote = `/tmp/harness-base-${sandbox.sandboxId}.bundle`;
            await sandbox.files.makeDir(box.dir);
            await box.exec('command -v git >/dev/null 2>&1 || (command -v apt-get >/dev/null 2>&1 && sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git)', { timeoutMs: 300000 });
            // a carried-on branch is sent whole: the new sandbox has nothing, not even the base, to build on
            await sandbox.files.write(remote, await packRepo(top, from));
            await box.git(['init', '-q', '.']);
            await box.git(['fetch', '-q', remote, `${PACK_REF}:refs/heads/${branch}`]);
            await box.git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
            await box.git(['reset', '-q', '--hard', 'HEAD']);
            await sandbox.files.remove(remote).catch(() => {});
            return box;
        } catch (err) {
            await sandbox.kill().catch(() => {});
            throw err;
        }
    }

    /** The absolute path of `rel` inside the workspace, or an Error if it leads outside. */
    resolve(rel) {
        const target = posix.resolve(this.dir, String(rel ?? '.'));
        const back = posix.relative(this.dir, target);
        if (back.startsWith('..') || posix.isAbsolute(back)) throw new Error(`${rel} is outside the workspace`);
        if (target.split('/').includes('.git')) throw new Error('the .git folder is off limits');
        return target;
    }

    async readFile(rel) { return this.sandbox.files.read(this.resolve(rel)); }

    async writeFile(rel, content) { await this.sandbox.files.write(this.resolve(rel), String(content)); }

    async listDir(rel) {
        const entries = await this.sandbox.files.list(this.resolve(rel));
        return entries.filter((e) => e.name !== '.git')
            .map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).sort();
    }

    /** Run a shell command in the workspace. Resolves { code, output, timedOut, ms }; never rejects. */
    async exec(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        const started = Date.now();
        let output = '';
        const add = (d) => { if (output.length < MAX_OUTPUT * 4) output += d; };
        try {
            const handle = await this.sandbox.commands.run(command, { cwd: this.dir, background: true, timeoutMs, onStdout: add, onStderr: add });
            this.handle = handle;
            const r = await handle.wait();
            this.handle = null;
            return { code: r.exitCode ?? 0, output: trimOutput(output || `${r.stdout || ''}${r.stderr || ''}`), timedOut: false, ms: Date.now() - started };
        } catch (err) {
            this.handle = null;
            const known = this.constructor.classify(err);
            if (known?.timedOut) return { code: -1, output: trimOutput(`${output}\n${err.message}`), timedOut: true, ms: Date.now() - started };
            if (known) return { code: known.exitCode, output: trimOutput(output || known.output || ''), timedOut: false, ms: Date.now() - started };
            return { code: -1, output: trimOutput(`${output}\n${err.message}`), timedOut: false, ms: Date.now() - started };
        }
    }

    /** Stop the command that is running, if one is. The sandbox itself stays. */
    stop() { this.handle?.kill?.().catch(() => {}); }

    async git(args) {
        const r = await this.exec(['git', ...args].map((a) => (/^[\w@%+=:,./^-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' '));
        if (r.code !== 0) throw new Error(r.output.trim() || `git ${args[0]} failed`);
        return r.output;
    }

    /**
     * Fetch the branches named from the repo on this machine, so they can be checked
     * out or merged here. The sandbox's own repo has no copy of them, so each one
     * arrives as a bundle in a file. A branch that cannot be packed is skipped: its
     * merge then fails and is reported, which is what a swarm does with a part that
     * conflicts.
     */
    async importBranches(branches) {
        for (const [i, branch] of branches.entries()) {
            const file = HOST_TMP('in.bundle');
            const remote = `/tmp/harness-in-${this.sandbox.sandboxId}-${i}.bundle`;
            try {
                await git(this.repo, ['bundle', 'create', '-q', file, `refs/heads/${branch}`, '--not', this.base]);
                const bytes = fs.readFileSync(file);
                await this.sandbox.files.write(remote, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
                await this.git(['fetch', '-q', remote, `+refs/heads/${branch}:refs/heads/${branch}`]);
            } catch { /* the merge reports it */ } finally {
                await this.sandbox.files.remove(remote).catch(() => {});
                fs.rmSync(file, { force: true });
            }
        }
    }

    /**
     * Hand the branch to the repo on this machine, so the run page can diff it and
     * you can inspect, test and push it like a local run's branch.
     */
    async sync() {
        const head = (await this.git(['rev-parse', 'HEAD'])).trim();
        if (head === this.base) return;
        const remote = `/tmp/harness-out-${this.sandbox.sandboxId}.bundle`;
        const file = HOST_TMP('out.bundle');
        try {
            await this.git(['bundle', 'create', '-q', remote, `refs/heads/${this.branch}`, '--not', this.base]);
            fs.writeFileSync(file, await this.sandbox.files.read(remote, { format: 'bytes' }));
            await git(this.repo, ['fetch', '-q', '--no-tags', file, `+refs/heads/${this.branch}:refs/heads/${this.branch}`]);
        } finally {
            await this.sandbox.files.remove(remote).catch(() => {});
            fs.rmSync(file, { force: true });
        }
    }

    /** Commit everything the agent changed (and hand the branch back). Returns the new commit, or null if nothing changed. */
    async commit(message) {
        await this.git(['add', '-A']);
        let commit = null;
        if ((await this.git(['status', '--porcelain'])).trim()) {
            await this.git(['-c', 'user.name=Bright Chat runner', '-c', 'user.email=runner@localhost', 'commit', '-q', '-m', message]);
            commit = (await this.git(['rev-parse', 'HEAD'])).trim();
        }
        // a swarm's work arrives as merges, so hand the branch back even when this made no commit
        await this.sync();
        return commit;
    }

    async diffStat() { return (await this.git(['diff', '--stat', `${this.base}..HEAD`])).trim(); }

    async diff(limit = 200000) {
        const text = await this.git(['diff', `${this.base}..HEAD`]);
        return text.length > limit ? `${text.slice(0, limit)}\n[... diff cut at ${limit} characters ...]` : text;
    }

    /** Kill the sandbox; the branch stays in the repo on this machine. */
    async destroy() {
        this.handle?.kill?.().catch(() => {});
        await this.sandbox.kill().catch(() => {});
    }
}

class E2BSandbox extends CloudSandbox {
    static kind = 'e2b';
    static get workDir() { return process.env.E2B_WORKDIR || '/home/user/work'; }

    static async open({ template, lifetimeMs }) {
        const { Sandbox } = require('e2b');
        return Sandbox.create(template || process.env.E2B_TEMPLATE || 'base', { timeoutMs: this.lifetime(lifetimeMs) });
    }

    /**
     * E2B refuses a sandbox lifetime above the plan's cap (1 hour on the free tier, 24 on
     * Pro), so it is clamped to E2B_MAX_TIMEOUT_MIN (default 60). A longer run then ends
     * when the sandbox does, with the provider's own message.
     */
    static lifetime(wantedMs) {
        const capMin = Number(process.env.E2B_MAX_TIMEOUT_MIN);
        const capMs = (capMin > 0 ? capMin : 60) * 60 * 1000;
        return Math.min(wantedMs, capMs);
    }

    static classify(err) {
        const { TimeoutError, CommandExitError } = require('e2b');
        if (err instanceof TimeoutError) return { timedOut: true };
        if (err instanceof CommandExitError) return { exitCode: err.exitCode, output: `${err.stdout || ''}${err.stderr || ''}` };
        return null;
    }

    /** Kill a sandbox by id, for a run whose sandbox outlived its process. */
    static async destroyById(id) {
        const { Sandbox } = require('e2b');
        await Sandbox.kill(id).catch(() => {});
    }
}

class SpritesSandbox extends CloudSandbox {
    static kind = 'sprites';
    static get workDir() { return process.env.SPRITES_WORKDIR || '/home/sprite/work'; }

    static async open() { return require('./sprites').createSprite(); }

    static classify(err) {
        if (err?.name === 'TimeoutError') return { timedOut: true };
        if (err?.name === 'CommandExitError') return { exitCode: err.exitCode, output: `${err.stdout || ''}${err.stderr || ''}` };
        return null;
    }

    static async destroyById(id) { await require('./sprites').deleteSprite(id).catch(() => {}); }
}

// ---------------------------------------------------------------------------
// The drivers a run can pick from
// ---------------------------------------------------------------------------

const DRIVERS = {
    local: { id: 'local', name: 'This machine (git worktree)', cloud: false, class: LocalSandbox, configured: () => true, needs: null },
    e2b: { id: 'e2b', name: 'E2B cloud sandbox', cloud: true, class: E2BSandbox, configured: () => !!process.env.E2B_API_KEY, needs: 'E2B_API_KEY' },
    sprites: { id: 'sprites', name: 'Fly Sprite', cloud: true, class: SpritesSandbox, configured: () => !!process.env.SPRITES_TOKEN, needs: 'SPRITES_TOKEN' },
};
const ALIASES = { cloud: 'e2b', sprite: 'sprites', fly: 'sprites' };

/** The driver id for what a person typed ('', 'cloud', 'Sprite' ...), or null when there is no such driver. */
function normalizeKind(kind) {
    const k = String(kind ?? '').trim().toLowerCase();
    if (!k) return null;
    const id = ALIASES[k] || k;
    return DRIVERS[id] ? id : null;
}

const isCloud = (kind) => !!DRIVERS[normalizeKind(kind)]?.cloud;

function driverFor(kind) {
    const id = normalizeKind(kind);
    if (!id) throw new Error(`unknown sandbox ${kind}; use ${Object.keys(DRIVERS).join(', ')}`);
    const driver = DRIVERS[id];
    if (!driver.configured()) throw new Error(`the ${id} sandbox needs ${driver.needs} in .env`);
    return driver;
}

/** What the run form offers: every driver, and whether its key is set. */
function listDrivers() {
    return Object.values(DRIVERS).map(({ id, name, cloud, needs, configured }) => ({ id, name, cloud, needs, configured: configured() }));
}

/**
 * The sandbox a run gets: `kind` is a driver id (local, e2b, sprites). local (default
 * RUNNER_SANDBOX) is a worktree on this machine; the others are cloud sandboxes.
 */
async function createSandbox({ kind = process.env.RUNNER_SANDBOX || 'local', ...opts } = {}) {
    const driver = driverFor(kind);
    return driver.cloud ? driver.class.create(opts) : LocalSandbox.create(opts);
}

/**
 * The workspace a run carried on from an earlier part gets: the same branch, with
 * the commits that part made. A cloud sandbox is always a new one (the earlier one
 * was killed when its part ended); the branch is handed to it as it stands.
 */
async function attachSandbox({ kind = process.env.RUNNER_SANDBOX || 'local', ...opts } = {}) {
    const driver = driverFor(kind);
    return driver.cloud ? driver.class.create({ ...opts, adapt: true }) : LocalSandbox.attach(opts);
}

/** Delete a cloud sandbox by id, for a run whose sandbox outlived its process. */
async function destroySandboxById(kind, id) {
    const id2 = normalizeKind(kind);
    if (id2 && DRIVERS[id2].cloud && id) await DRIVERS[id2].class.destroyById(id);
}

module.exports = { LocalSandbox, CloudSandbox, E2BSandbox, SpritesSandbox, DRIVERS, driverFor, normalizeKind, isCloud, listDrivers, destroySandboxById, createSandbox, attachSandbox, MAX_OUTPUT, trimOutput };
