// A place for an agent to work: a git worktree on a new branch of the user's
// repo, so the agent never touches the working copy and the result is a
// branch to inspect, test and push. Commands run here with a trimmed
// environment (no API keys). This is the "local" Sandbox; a cloud one (E2B,
// Daytona) would offer the same methods: create, resolve, readFile,
// writeFile, listDir, exec, stop, git, destroy.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 120000;
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

module.exports = { LocalSandbox, MAX_OUTPUT, trimOutput };
