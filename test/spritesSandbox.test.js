// The Sprites sandbox: a run can work in a Fly Sprite instead of a worktree here.
// No network: @fly/sprites is replaced by a stand-in whose "sprite" is a folder on
// this machine, so the bundles, the branch it starts on and the branch it hands
// back are real git. Also covers picking a driver per run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, execFileSync } = require('node:child_process');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sprites-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// ---------------------------------------------------------------- the stand-in
const deleted = [];
const made = [];
class FakeSprite {
    constructor(name) {
        this.name = name;
        this.dir = path.join(root, 'sprites', name);
        fs.mkdirSync(path.join(this.dir, 'work'), { recursive: true });
        fs.mkdirSync(path.join(this.dir, 'files'), { recursive: true });
    }
    abs(p) {
        if (p === '/tmp' || p.startsWith('/tmp/')) return path.join(this.dir, 'files', path.relative('/tmp', p));
        const work = '/home/sprite/work';
        const rel = p === work ? '' : p.startsWith(`${work}/`) ? p.slice(work.length + 1) : p;
        return path.join(this.dir, 'work', rel);
    }
    filesystem() {
        const self = this;
        return {
            async mkdir(p) { fs.mkdirSync(self.abs(p), { recursive: true }); },
            async writeFile(p, data) { fs.writeFileSync(self.abs(p), data); },
            async readFile(p, enc) { const b = fs.readFileSync(self.abs(p)); return enc === 'utf8' ? b.toString('utf8') : b; },
            async rm(p) { fs.rmSync(self.abs(p), { recursive: true, force: true }); },
            async readdir(p) { return fs.readdirSync(self.abs(p), { withFileTypes: true }); },
        };
    }
    spawn(bin, args, { cwd } = {}) {
        const cmd = args[1].replace(/\/tmp\/([\w.-]+)/g, (m, n) => path.join(this.dir, 'files', n).replace(/\\/g, '/'))
            .replace(/\/home\/sprite\/work/g, path.join(this.dir, 'work').replace(/\\/g, '/'));
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const proc = spawn(...(process.platform === 'win32' ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]] : ['sh', ['-c', cmd]]), { cwd: this.abs(cwd || '/home/sprite/work') });
        proc.stdout.pipe(child.stdout);
        proc.stderr.pipe(child.stderr);
        const exit = new Promise((resolve) => proc.on('close', (code, signal) => resolve(signal ? 137 : code ?? 1)));
        child.wait = () => exit;
        child.kill = () => proc.kill('SIGKILL');
        child.close = () => {};
        return child;
    }
}
class FakeClient {
    constructor(token) { this.token = token; }
    async createSprite(name) { made.push(name); return new FakeSprite(name); }
    async deleteSprite(name) { deleted.push(name); }
}
process.env.SPRITES_TOKEN = 'test-token';
process.env.E2B_API_KEY = 'test-key';
require('../runner/sprites').useSdk({ SpritesClient: FakeClient });

const { SpritesSandbox, createSandbox, attachSandbox, normalizeKind, isCloud, listDrivers, driverFor, destroySandboxById } = require('../runner/sandbox');

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

test('a Sprite starts on the base commit of a branch of its own', async () => {
    const box = await createSandbox({ kind: 'sprites', repo, branch: 'harness/sp1', base });
    assert.equal(box.kind, 'sprites');
    assert.match(box.id, /^harness-/);
    assert.equal(box.base, base);
    assert.match(await box.git(['rev-parse', '--abbrev-ref', 'HEAD']), /harness\/sp1/);
    assert.equal((await box.readFile('a.js')).trim(), 'exports.a = 1;');
    assert.deepEqual(await box.listDir('.'), ['a.js']);
    await box.destroy();
    assert.ok(deleted.includes(box.id), 'the Sprite is deleted so it stops billing');
});

test('what it changes is committed and handed back as a branch of the repo here', async () => {
    const box = await createSandbox({ kind: 'sprites', repo, branch: 'harness/sp2', base });
    await box.writeFile('a.js', 'exports.a = 2;\n');
    await box.writeFile('sub/c.js', 'exports.c = 3;\n');
    const commit = await box.commit('harness run: change a');
    assert.match(commit, /^[0-9a-f]{40}$/);
    assert.equal(git(repo, 'show', 'harness/sp2:a.js').trim(), 'exports.a = 2;');
    assert.equal(git(repo, 'show', 'harness/sp2:sub/c.js').trim(), 'exports.c = 3;');
    assert.match(await box.diffStat(), /2 files changed/);
    await box.destroy();
});

test('commands report exit code, output and a timeout; the workspace is fenced', async () => {
    const box = await createSandbox({ kind: 'sprites', repo, branch: 'harness/sp3', base });
    const ok = await box.exec(process.platform === 'win32' ? 'Write-Output hello' : 'echo hello');
    assert.equal(ok.code, 0);
    assert.match(ok.output, /hello/);
    const bad = await box.exec('exit 3');
    assert.equal(bad.code, 3);
    assert.equal(bad.timedOut, false);
    if (process.platform !== 'win32') {
        const slow = await box.exec('sleep 5', { timeoutMs: 200 });
        assert.equal(slow.timedOut, true);
    }
    assert.throws(() => box.resolve('../outside'), /outside the workspace/);
    assert.throws(() => box.resolve('.git/config'), /off limits/);
    assert.equal(box.resolve('a.js'), '/home/sprite/work/a.js');
    await box.destroy();
});

test('a run carried on gets a new Sprite holding its branch as it stands', async () => {
    const first = await createSandbox({ kind: 'sprites', repo, branch: 'harness/sp4', base });
    await first.writeFile('b.js', 'exports.b = 1;\n');
    await first.commit('part one');
    await first.destroy();
    const second = await attachSandbox({ kind: 'sprites', repo, branch: 'harness/sp4', base });
    assert.equal((await second.readFile('b.js')).trim(), 'exports.b = 1;');
    await second.destroy();
});

test('a driver is picked by name; unknown or unconfigured ones are refused', async () => {
    assert.equal(normalizeKind('Sprite'), 'sprites');
    assert.equal(normalizeKind('cloud'), 'e2b');
    assert.equal(normalizeKind('nope'), null);
    assert.equal(isCloud('sprites'), true);
    assert.equal(isCloud('local'), false);
    assert.deepEqual(listDrivers().map((d) => d.id), ['local', 'e2b', 'sprites']);
    assert.throws(() => driverFor('nope'), /unknown sandbox/);
    const token = process.env.SPRITES_TOKEN;
    delete process.env.SPRITES_TOKEN;
    assert.throws(() => driverFor('sprites'), /SPRITES_TOKEN/);
    process.env.SPRITES_TOKEN = token;
    assert.ok(driverFor('local'));
});

test('a Sprite left behind by a restart can be deleted by its id', async () => {
    await destroySandboxById('sprites', 'harness-left');
    assert.ok(deleted.includes('harness-left'));
    assert.ok(SpritesSandbox.kind === 'sprites');
});

test('commands on a Sprite still go past the command guard first', async () => {
    const { makeTools } = require('../runner/tools');
    const box = await createSandbox({ kind: 'sprites', repo, branch: 'harness/sp5', base });
    const asked = [];
    const tools = makeTools({
        sandbox: box,
        check: async (kind, text) => { asked.push([kind, text]); return text.includes('rm -rf') ? { decision: 'deny', reason: 'destructive' } : { decision: 'allow' }; },
        approve: async () => true,
    });
    const blocked = await tools.call('run_command', { command: 'rm -rf /' });
    assert.match(blocked.text, /Blocked by the command guard/);
    const ran = await tools.call('run_command', { command: 'echo hi' });
    assert.match(ran.text, /exit code 0/);
    assert.deepEqual(asked.map((a) => a[0]), ['bash', 'bash']);
    await box.destroy();
});

test('a run picks its sandbox; an agent can have a default', async () => {
    const { RunManager } = require('../runner/runs');
    const dir = path.join(root, 'mgr');
    const manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [root], sandbox: 'local' });
    manager.pump = () => {}; // do not start anything
    const make = (cfg) => manager.create({ goal: 'x', repo, ...cfg });
    assert.equal(make({}).sandbox, 'local');
    assert.equal(make({ sandbox: 'sprites' }).sandbox, 'sprites');
    assert.equal(make({ sandbox: 'cloud' }).sandbox, 'e2b');
    assert.throws(() => make({ sandbox: 'nope' }), /unknown sandbox/);
    const agent = manager.createAgent({ name: 'Cloud agent', repo, sandbox: 'sprites' });
    assert.equal(agent.sandbox, 'sprites');
    assert.equal(manager.assign(agent.id, { goal: 'do it' }).sandbox, 'sprites');
    assert.throws(() => manager.createAgent({ name: 'Bad', repo, sandbox: 'nope' }), /no sandbox named/);
    assert.equal(manager.updateAgent(agent.id, { sandbox: '' }).sandbox, null);
});
