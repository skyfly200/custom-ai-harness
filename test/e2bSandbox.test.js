// The E2B sandbox: a run can work in a cloud sandbox instead of a worktree here.
// No network: `e2b` is replaced by a stand-in whose "sandbox" is a folder on this
// machine, so the bundles, the branch it starts on and the branch it hands back
// are all real git.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2b-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// ---------------------------------------------------------------- the stand-in
// It behaves like e2b's Sandbox where the harness touches it: create, kill, the
// files module and commands.run. Commands are PowerShell here, since this is Windows.
class FakeTimeoutError extends Error { constructor(m) { super(m); this.name = 'TimeoutError'; } }
class FakeCommandExitError extends Error {
    constructor(code, out) { super('exit'); this.name = 'CommandExitError'; this.exitCode = code; this.stdout = out; this.stderr = ''; }
}
let created = 0;
const killed = [];
class FakeSandbox {
    constructor(id, dir) {
        this.sandboxId = id;
        this.dir = dir;
        this.handle = null;
        const self = this;
        this.files = {
            async write(p, data) {
                const file = self.abs(p);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, Buffer.from(data));
                return { name: path.basename(p), path: file };
            },
            async read(p, opts = {}) {
                const file = self.abs(p);
                return opts.format === 'bytes' ? new Uint8Array(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8');
            },
            async remove(p) { fs.rmSync(self.abs(p), { force: true }); },
            async makeDir() { return true; },
            async list(p) {
                const abs = self.abs(p);
                return fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, path: path.join(abs, e.name), type: e.isDirectory() ? 'dir' : 'file' }));
            },
        };
        this.commands = {
            // `git bundle` writes a file: the fake keeps "the sandbox's" files beside its tree and
            // hands the path through, so a bundle arrives in the tree it was asked to write to
            async run(cmd, opts = {}) {
                const r = self.runCmd(cmd, opts);
                if (opts.background) return r;
                return r.wait();
            },
        };
    }
    abs(p) {
        // the harness's POSIX paths (/tmp/x, /home/user/work/y) point into the fake's folder
        if (p === '/tmp' || p.startsWith('/tmp/')) return path.join(this.dir, 'files', path.relative('/tmp', p));
        const work = '/home/user/work';
        const rel = p === work ? '' : p.startsWith(`${work}/`) ? p.slice(work.length + 1) : p;
        return path.join(this.dir, 'work', rel);
    }
    runCmd(cmd, { cwd, timeoutMs = 120000, onStdout, onStderr } = {}) {
        const self = this;
        // translate the POSIX bits the harness relies on into this machine's shell
        let out = cmd.replace(/\/tmp\/([\w.-]+)/g, (m, name) => path.join(this.dir, 'files', name).replace(/\\/g, '/'))
            .replace('/home/user/work', path.join(this.dir, 'work').replace(/\\/g, '/'));
        let code = 0;
        let timedOut = false;
        const self2 = this;
        // cwd is the harness's POSIX path for the workspace too
        const realCwd = !cwd || cwd === '/home/user/work' ? self.abs('') : self.abs(cwd);
        return {
            pid: 1,
            async wait() {
                try {
                    const r = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', out], { cwd: realCwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
                    onStdout?.(String(r));
                    return { exitCode: 0, stdout: String(r), stderr: '' };
                } catch (err) {
                    if (err.killed || err.signal) throw new FakeTimeoutError('command timed out');
                    const text = `${err.stdout || ''}${err.stderr || ''}`;
                    onStderr?.(text);
                    throw new FakeCommandExitError(err.status ?? 1, text);
                }
            },
            async kill() { return true; },
        };
    }
    async kill() { killed.push(this.sandboxId); return true; }
    static async create(id) {
        const dir = path.join(root, 'sandboxes', id);
        fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
        created++;
        return new FakeSandbox(id, dir);
    }
    static async kill(id) { killed.push(id); return true; }
}
const fakePath = path.join(root, 'e2b.js');
fs.writeFileSync(fakePath, '');
const fake = { Sandbox: FakeSandbox, TimeoutError: FakeTimeoutError, CommandExitError: FakeCommandExitError };
require.cache[require.resolve('e2b')] = { id: require.resolve('e2b'), filename: require.resolve('e2b'), loaded: true, exports: fake };
process.env.E2B_API_KEY = 'test-key';

const { E2BSandbox, createSandbox, LocalSandbox } = require('../runner/sandbox');

// ------------------------------------------------------------------ a repo here
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q');
git(repo, 'checkout', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
fs.writeFileSync(path.join(repo, 'a.js'), 'exports.a = 1;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'start');
const base = git(repo, 'rev-parse', 'HEAD').trim();
git(repo, 'checkout', '-q', '-b', 'old');
fs.writeFileSync(path.join(repo, 'b.js'), 'exports.b = 1;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'old');
git(repo, 'checkout', '-q', 'main');
git(repo, 'branch', '-D', 'old', '-q');

test('an E2B sandbox starts on the base commit of a branch of its own', async () => {
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b1', base });
    assert.equal(box.kind, 'e2b');
    assert.equal(box.base, base);
    assert.match(await box.git(['rev-parse', 'HEAD']), new RegExp(base));
    assert.match(await box.git(['rev-parse', '--abbrev-ref', 'HEAD']), /harness\/e2b1/);
    assert.equal((await box.readFile('a.js')).trim(), 'exports.a = 1;');
    assert.deepEqual(await box.listDir('.'), ['a.js']);
    await box.destroy();
});

test('what it changes is committed and handed back as a branch of the repo here', async () => {
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b2', base });
    await box.writeFile('a.js', 'exports.a = 2;\n');
    await box.writeFile('sub/c.js', 'exports.c = 3;\n');
    const commit = await box.commit('harness run: change a');
    assert.match(commit, /^[0-9a-f]{40}$/);
    // the branch is in the repo on this machine, so the run page's diff and the person's push work
    assert.equal(git(repo, 'show', 'harness/e2b2:a.js').trim(), 'exports.a = 2;');
    assert.equal(git(repo, 'show', 'harness/e2b2:sub/c.js').trim(), 'exports.c = 3;');
    assert.equal(git(repo, 'rev-parse', `harness/e2b2`).trim(), commit);
    assert.match(await box.diffStat(), /2 files changed/);
    assert.match(await box.diff(), /exports\.c = 3;/);
    await box.destroy();
    assert.ok(killed.length > 0);
});

test('a run that changes nothing makes no commit and leaves no branch', async () => {
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b3', base });
    assert.equal(await box.commit('harness run: nothing'), null);
    assert.equal(git(repo, 'branch', '--list', 'harness/e2b3').trim(), '');
    await box.destroy();
});

test('a command reports its exit code, its output and a timeout like a local one', async () => {
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b4', base });
    const ok = await box.exec('Write-Output hello');
    assert.equal(ok.code, 0);
    assert.match(ok.output, /hello/);
    assert.equal(ok.timedOut, false);
    assert.ok(ok.ms >= 0);
    const bad = await box.exec('exit 3');
    assert.equal(bad.code, 3);
    assert.equal(bad.timedOut, false);
    await box.destroy();
});

test('the agent can no more leave the workspace than in a local one', async () => {
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b5', base });
    assert.throws(() => box.resolve('../outside'), /outside the workspace/);
    assert.throws(() => box.resolve('/etc/passwd'), /outside the workspace/);
    assert.throws(() => box.resolve('.git/config'), /off limits/);
    assert.equal(box.resolve('a.js'), '/home/user/work/a.js');
    await box.destroy();
});

test('a swarm hands the workers’ branches over before it merges them', async () => {
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b6', base });
    // two branches made here, as workers make them, from the same base and touching other files
    for (const [branch, file] of [['harness/w1', 'w1.js'], ['harness/w2', 'w2.js']]) {
        git(repo, 'checkout', '-q', '-b', branch, base);
        fs.writeFileSync(path.join(repo, file), `exports.x = '${file}';\n`);
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', branch);
    }
    git(repo, 'checkout', '-q', 'main');
    await box.importBranches(['harness/w1', 'harness/w2']);
    await box.git(['merge', '--no-ff', '-q', '-m', 'Merge w1', 'harness/w1']);
    await box.git(['merge', '--no-ff', '-q', '-m', 'Merge w2', 'harness/w2']);
    // a swarm merges, so commit() makes no commit of its own but still hands the branch back
    assert.equal(await box.commit('harness run: swarm'), null);
    assert.equal(git(repo, 'show', 'harness/e2b6:w1.js').trim(), "exports.x = 'w1.js';");
    assert.equal(git(repo, 'show', 'harness/e2b6:w2.js').trim(), "exports.x = 'w2.js';");
    await box.destroy();
});

test('createSandbox picks the cloud only when it is asked for, and says what is missing', async () => {
    assert.ok((await createSandbox({ kind: 'local', repo, dir: path.join(root, 'work'), branch: 'harness/l1', base })) instanceof LocalSandbox);
    assert.ok((await createSandbox({ kind: 'e2b', repo, branch: 'harness/e2b7', base })) instanceof E2BSandbox);
    const key = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    await assert.rejects(createSandbox({ kind: 'e2b', repo, branch: 'harness/e2b8', base }), /E2B_API_KEY/);
    process.env.E2B_API_KEY = key;
    await assert.rejects(createSandbox({ kind: 'firecracker', repo, branch: 'b', base }), /unknown sandbox/);
});

test('a base that is not a branch tip is still sent whole', async () => {
    // packRepo's throwaway ref is what makes this work: a plain `git bundle create <sha>` on a
    // commit with nothing newer refuses to make an empty bundle
    const old = git(repo, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'z.js'), 'exports.z = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'after');
    const box = await E2BSandbox.create({ repo, branch: 'harness/e2b9', base: old });
    assert.equal((await box.git(['rev-parse', 'HEAD'])).trim(), old);
    assert.equal(await box.listDir('.').then((f) => f.includes('z.js')), false);
    await box.destroy();
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
});
