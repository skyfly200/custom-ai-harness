// A place for an agent to work: a git worktree on a new branch of the user's
// repo, so the agent never touches the working copy and the result is a
// branch to inspect, test and push. Commands run here with a trimmed
// environment (no API keys).
//
// Two sandboxes offer the same methods (create, resolve, readFile, writeFile,
// listDir, exec, stop, git, commit, diffStat, diff, destroy), so the tools and
// the runs never know which one they got:
//   LocalSandbox - a git worktree on this machine (the default).
//   E2BSandbox   - a cloud sandbox from E2B (RUNNER_SANDBOX=e2b). It has no
//                  copy of your repo to branch off, so the branch is made by
//                  handing it a git bundle of the base commit, and the branch
//                  it ends on is handed back the same way before the run ends.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const posix = path.posix;
const { spawn, execFile } = require('child_process');

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
        return new Promise((resolve) => {
            const started = Date.now();
            const win = process.platform === 'win32';
            const env = Object.fromEntries(ENV_ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
            const [bin, args] = win ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['bash', ['-c', command]];
            let output = '';
            let timedOut = false;
            let child;
            try {
                child = spawn(bin, args, { cwd: this.dir, env, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (!child?.pid) return;
        try {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            else process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
    }

    stop() { this.kill(); }

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
        this.kill();
        await git(this.repo, ['worktree', 'remove', '--force', this.dir]).catch(() => fs.rmSync(this.dir, { recursive: true, force: true }));
        await git(this.repo, ['worktree', 'prune']).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// E2B: the same workspace, in a sandbox in the cloud
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.E2B_WORKDIR || '/home/user/work';
const SANDBOX_LIFETIME_MS = 60 * 60 * 1000; // E2B kills it after this; a run ends long before
const HOST_TMP = (name) => path.join(os.tmpdir(), `harness-${process.pid}-${Date.now()}-${name}`);

/** Pack `commit` and everything it needs into a bundle, for a sandbox that has no repo yet. */
async function packRepo(repo, commit) {
    const file = HOST_TMP('base.bundle');
    try {
        // a ref of its own, so a commit that is not a branch tip still packs with its full history
        await git(repo, ['update-ref', PACK_REF, commit]);
        await git(repo, ['bundle', 'create', '-q', file, PACK_REF]);
        const bytes = fs.readFileSync(file);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } finally {
        await git(repo, ['update-ref', '-d', PACK_REF]).catch(() => {});
        fs.rmSync(file, { force: true });
    }
}

class E2BSandbox {
    constructor({ sandbox, repo, branch, base }) {
        this.sandbox = sandbox;
        this.dir = WORK_DIR;
        this.repo = repo;
        this.branch = branch;
        this.base = base;
        this.handle = null;
        this.kind = 'e2b';
        this.id = sandbox.sandboxId;
    }

    /** A fresh E2B sandbox with `branch` checked out at `base` (a commit in `repo` on this machine). */
    static async create({ repo, branch, base = 'HEAD', template = process.env.E2B_TEMPLATE || 'base', lifetimeMs = SANDBOX_LIFETIME_MS }) {
        let top, commit;
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
        const { Sandbox } = require('e2b');
        const sandbox = await Sandbox.create(template, { timeoutMs: lifetimeMs });
        const box = new E2BSandbox({ sandbox, repo: top, branch, base: commit });
        try {
            const remote = `/tmp/harness-base-${sandbox.sandboxId}.bundle`;
            await sandbox.files.makeDir(WORK_DIR);
            await box.exec('command -v git >/dev/null 2>&1 || (command -v apt-get >/dev/null 2>&1 && sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git)', { timeoutMs: 300000 });
            await sandbox.files.write(remote, await packRepo(top, commit));
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
        const { TimeoutError, CommandExitError } = require('e2b');
        const started = Date.now();
        let output = '';
        const add = (d) => { if (output.length < MAX_OUTPUT * 4) output += d; };
        try {
            const handle = await this.sandbox.commands.run(command, { cwd: this.dir, background: true, onStdout: add, onStderr: add });
            this.handle = handle;
            const r = await handle.wait();
            this.handle = null;
            return { code: r.exitCode ?? 0, output: trimOutput(output || `${r.stdout || ''}${r.stderr || ''}`), timedOut: false, ms: Date.now() - started };
        } catch (err) {
            this.handle = null;
            if (err instanceof TimeoutError) return { code: -1, output: trimOutput(`${output}\n${err.message}`), timedOut: true, ms: Date.now() - started };
            if (err instanceof CommandExitError) return { code: err.exitCode, output: trimOutput(output || `${err.stdout || ''}${err.stderr || ''}`), timedOut: false, ms: Date.now() - started };
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
     * Fetch the branches named, so they can be merged here. The sandbox's own
     * repo has no copy of them, so each one arrives as a bundle in a file.
     * A branch that cannot be packed is skipped: its merge then fails and is
     * reported, which is what a swarm does with a part that conflicts.
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

    /** Kill a sandbox by id, for a run whose sandbox outlived its process. */
    static async destroyById(id) {
        const { Sandbox } = require('e2b');
        await Sandbox.kill(id).catch(() => {});
    }
}

/**
 * The sandbox a run gets. local (default) is a worktree on this machine; e2b is a
 * cloud sandbox from E2B (needs E2B_API_KEY, which the e2b package reads itself).
 */
async function createSandbox({ kind = process.env.RUNNER_SANDBOX || 'local', ...opts } = {}) {
    const cloud = String(kind).toLowerCase();
    if (cloud === 'e2b' || cloud === 'cloud') {
        if (!process.env.E2B_API_KEY) throw new Error('RUNNER_SANDBOX=e2b needs E2B_API_KEY in .env');
        return E2BSandbox.create(opts);
    }
    if (cloud !== 'local') throw new Error(`unknown sandbox ${kind}; use local or e2b`);
    return LocalSandbox.create(opts);
}

module.exports = { LocalSandbox, E2BSandbox, createSandbox, MAX_OUTPUT, trimOutput };
