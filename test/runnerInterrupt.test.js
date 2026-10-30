// Runs that are cut off (the runner restarts or shuts down, a cloud sandbox ends) are "interrupted", not
// failed: Continue picks them up from their branch, and with auto-continue they start again by themselves,
// but never after a person's Stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-interrupt-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
process.env.E2B_API_KEY = 'test-key';     // so a run may name the e2b sandbox, which is faked below
process.env.RUNNER_CHECKPOINT_MIN = '0';

// The cloud sandbox is faked: the first one has ended under the run, the next one works
const sandboxPath = require.resolve('../runner/sandbox');
const realSandbox = require('../runner/sandbox');
let cloudBoxes = 0;
const fakeBox = (gone) => ({
    kind: 'e2b', id: `box${++cloudBoxes}`, base: 'a'.repeat(40), stopped: false,
    async git(args) {
        if (gone) throw new Error('The sandbox was not found: it timed out');
        return args[0] === 'ls-files' ? 'app.js\n' : args[0] === 'rev-parse' ? 'a'.repeat(40) : '';
    },
    async commit() { if (gone) throw new Error('The sandbox was not found'); return null; },
    async diffStat() { return ''; }, async exec() { return { code: 0, output: '', timedOut: false, ms: 1 }; },
    async readFile() { return ''; }, async writeFile() {}, async listDir() { return []; },
    async destroy() {}, stop() {}, async close() {},
});
let attached = 0;
require.cache[sandboxPath].exports = { ...realSandbox,
    createSandbox: async (o) => (o.kind === 'e2b' ? fakeBox(true) : realSandbox.createSandbox(o)),
    attachSandbox: async (o) => { if (o.kind === 'e2b') { attached++; return fakeBox(false); } return realSandbox.attachSandbox(o); },
};
const { RunManager } = require('../runner/runs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const reposDir = path.join(dir, 'repos');
const repo = path.join(reposDir, 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let script = [];
let modelCalls = [];
const fakeHarness = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
        const body = JSON.parse(data || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: { 'fake-model': { inputCost: 1e-5, outputCost: 3e-5 } } }));
        if (req.url === '/v1/guard') return res.end(JSON.stringify({ decision: 'allow' }));
        modelCalls.push(body);
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'script ran out' })); }
        if (next.delay) await sleep(next.delay);
        res.end(JSON.stringify({ model: 'fake-model', usage: { prompt_tokens: 100, completion_tokens: 20 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: next.calls.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager;
const make = (extra = {}) => new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5, autoResumeMs: 20, ...extra });
test.before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = (a, b) => a - b;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    manager = make();
});
test.after(async () => { fakeHarness.close(); await require('../utils/powershellSession').closeAll(); });

const ENDED = ['done', 'failed', 'stopped', 'incomplete', 'interrupted'];
async function settle(m, id, states = ENDED) {
    for (let i = 0; i < 800; i++) {
        const run = m.get(id);
        if (states.includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error(`run stayed ${m.get(id).status}`);
}
const start = (m, cfg = {}) => m.create({ goal: 'Fix add so it adds', repo, ...cfg });

test('Continue picks up an interrupted run from its branch and says what was interrupted', async () => {
    // a run that committed some work, then the runner was killed while it was still going
    script = [{ calls: [['edit_file', { path: 'app.js', old: 'a - b', new: 'a + b' }]] }];
    const { id } = start(manager, { maxSteps: 1 });
    const first = await settle(manager, id);
    assert.equal(first.status, 'incomplete');
    const commit = first.result.commit;
    const file = path.join(dir, 'runs', id, 'run.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'running' }));
    const again = make();
    const run = again.get(id);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.interrupted.reason, 'restart');
    assert.equal(run.autoContinue, false);
    assert.equal(again.resumeInterrupted({ delayMs: 5, staggerMs: 5 }), 0, 'not set to auto-continue, so it waits for a person');
    assert.throws(() => again.retry(id), /cut off, not failed: use Continue/);
    script = [{ calls: [['finish', { summary: 'done after the restart' }]] }];
    modelCalls = [];
    again.continueRun(id);
    const done = await settle(again, id);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.id, id);
    assert.equal(done.branch, first.branch);
    assert.equal(git(repo, 'rev-parse', first.branch).trim(), done.result.commit, 'the branch still holds the commit the first part saved');
    assert.ok(git(repo, 'merge-base', '--is-ancestor', commit, first.branch) === '');
    const brief = modelCalls[0].messages[1].content;
    assert.match(brief, /was interrupted \(the runner restarted\)/);
    assert.match(brief, /committed on the branch/);
    assert.ok(done.events.some((e) => /Carrying the run on after it was interrupted/.test(e.text || '')));
    assert.equal(done.resumedAuto, null);
});

test('a stopped run can be continued, but never resumes by itself', async () => {
    script = [{ delay: 400, calls: [['list_files', {}]] }, { calls: [['finish', { summary: 'x' }]] }];
    const { id } = start(manager, { autoContinue: true });
    await sleep(100);
    manager.stop(id);
    const stopped = await settle(manager, id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(manager.resumeInterrupted({ delayMs: 5, staggerMs: 5 }), 0);
    assert.equal(manager.autoContinueCheck(stopped).ok, false);
    script = [{ calls: [['finish', { summary: 'picked up' }]] }];
    manager.continueRun(id);
    assert.equal((await settle(manager, id)).status, 'done');
});

test('at start-up an interrupted run set to auto-continue resumes itself, up to its attempts', async () => {
    script = [{ calls: [['edit_file', { path: 'app.js', old: 'a - b', new: 'a + b' }]] }];
    const { id } = start(manager, { maxSteps: 1, autoContinue: true, autoContinueMax: 2 });
    await settle(manager, id);
    const file = path.join(dir, 'runs', id, 'run.json');
    const cut = (m) => { const r = JSON.parse(fs.readFileSync(file, 'utf8')); fs.writeFileSync(file, JSON.stringify({ ...r, status: 'running' })); return make(); };
    // first restart: resumed automatically, attempt 1 of 2, and a cut-off again
    let m = cut(manager);
    script = [{ delay: 3000, calls: [['list_files', {}]] }];
    assert.equal(m.resumeInterrupted({ delayMs: 5, staggerMs: 5 }), 1);
    await sleep(150);
    assert.equal(m.get(id).status, 'running');
    assert.deepEqual([m.get(id).resumedAuto.attempt, m.get(id).resumedAuto.of], [1, 2]);
    assert.ok(m.get(id).events.some((e) => /Resumed automatically \(attempt 1 of 2\)/.test(e.text)));
    // the runner dies again with the leg working: its leg file is folded in on the next start
    m = make();
    const back = m.get(id);
    assert.equal(back.status, 'interrupted');
    assert.equal(back.autoAttempts, 1);
    script = [{ delay: 3000, calls: [['list_files', {}]] }];
    assert.equal(m.resumeInterrupted({ delayMs: 5, staggerMs: 5 }), 1);
    await sleep(150);
    assert.equal(m.get(id).resumedAuto.attempt, 2);
    m = make();
    assert.equal(m.get(id).autoAttempts, 2);
    assert.equal(m.resumeInterrupted({ delayMs: 5, staggerMs: 5 }), 0, 'two attempts used, so it waits for a person');
    assert.ok(m.get(id).events.some((e) => /Not resuming automatically: it has already resumed itself 2 times/.test(e.text)));
    // a person's Continue starts the count again
    script = [{ calls: [['finish', { summary: 'finished by hand' }]] }];
    m.continueRun(id);
    assert.equal((await settle(m, id)).status, 'done');
    assert.equal(m.get(id).autoAttempts, 0);
});

test('automatic resumes may spend at most one more cost limit', async () => {
    const m = make();
    const run = { id: 'x', status: 'interrupted', kind: 'run', autoContinue: true, autoMax: 3, autoAttempts: 1, maxCost: 1, cost: 4, autoCostFrom: 3.5 };
    assert.equal(m.autoContinueCheck(run).ok, true);
    assert.equal(m.autoContinueCheck({ ...run, cost: 4.5 }).ok, false);
    assert.match(m.autoContinueCheck({ ...run, cost: 4.5 }).why, /cost limit of \$1\.00/);
    assert.equal(m.autoContinueCheck({ ...run, autoContinue: false }).why, null);
    assert.equal(m.autoContinueCheck({ ...run, parent: 'p' }).ok, false, 'a swarm worker is not resumed on its own');
});

test('shutdown saves the work, marks the run interrupted, and the next start resumes it', async () => {
    script = [{ calls: [['edit_file', { path: 'app.js', old: 'a - b', new: 'a + b' }]] }, { delay: 300, calls: [['list_files', {}]] }];
    const { id } = start(manager, { autoContinue: true });
    for (let i = 0; i < 100 && manager.get(id).steps < 2; i++) await sleep(20);
    assert.equal(await manager.shutdown({ timeoutMs: 5000 }), 1);
    const run = manager.get(id);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.interrupted.reason, 'shutdown');
    assert.match(run.result.commit, /^[0-9a-f]{40}$/, 'the edit was committed before the runner went');
    assert.match(git(repo, 'show', `${run.branch}:app.js`), /a \+ b/);
    const next = make();
    assert.equal(next.get(id).status, 'interrupted');
    script = [{ calls: [['finish', { summary: 'back again' }]] }];
    next.resumeInterrupted({ delayMs: 5, staggerMs: 5 });
    const done = await settle(next, id, ['done', 'failed', 'stopped', 'incomplete']);
    assert.equal(done.status, 'done', done.error);
    assert.ok(done.events.some((e) => /Resumed automatically \(attempt 1 of 3\)/.test(e.text)));
});

test('a cloud sandbox that ends under a run interrupts it, and auto-continue starts a new sandbox from the branch', async () => {
    script = [{ calls: [['finish', { summary: 'finished in the new sandbox' }]] }];
    const { id } = start(manager, { sandbox: 'e2b', autoContinue: true });
    const done = await settle(manager, id, ['done', 'failed', 'stopped', 'incomplete']);
    assert.equal(done.status, 'done', done.error);
    assert.equal(attached, 1, 'the second part got a new sandbox made from the branch');
    assert.equal(done.resumedAuto.after, 'sandbox');
    assert.ok(done.events.some((e) => /cloud sandbox ended/.test(e.text || '')));
    assert.ok(done.events.some((e) => /Resumed automatically \(attempt 1 of 3\) after it was interrupted \(its cloud sandbox ended\)/.test(e.text || '')));
});

test('a cloud run without auto-continue waits as interrupted', async () => {
    const { id } = start(manager, { sandbox: 'e2b' });
    const run = await settle(manager, id);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.interrupted.reason, 'sandbox');
    await sleep(120);
    assert.equal(manager.get(id).status, 'interrupted');
});

test('an agent carries auto-continue to its tasks, and a task can set its own', async () => {
    const agent = manager.agents.create({ name: 'Keeper', repo, autoContinue: true, autoContinueMax: 5 }, repo);
    assert.equal(agent.autoContinue, true);
    script = [{ calls: [['finish', { summary: 'a' }]] }];
    const task = manager.assign(agent.id, { goal: 'one' });
    assert.equal(manager.get(task.id).autoContinue, true);
    assert.equal(manager.get(task.id).autoMax, 5);
    await settle(manager, task.id);
    script = [{ calls: [['finish', { summary: 'b' }]] }];
    const off = manager.assign(agent.id, { goal: 'two', autoContinue: false });
    assert.equal(manager.get(off.id).autoContinue, false);
    await settle(manager, off.id);
    const edited = manager.agents.update(agent.id, { autoContinue: false, autoContinueMax: 99 }, null);
    assert.deepEqual([edited.autoContinue, edited.autoContinueMax], [false, 10]);
});
