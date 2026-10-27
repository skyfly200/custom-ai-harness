// The task runner: an agent works in a git worktree on its own branch, every
// command and write goes past the guard, and the Interceptor proxies the API.
// The model is a script that answers with tool calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runner-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { createApp } = require('../runner/server');
const { shrinkHistory } = require('../runner/agent');
const { LocalSandbox } = require('../runner/sandbox');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const reposDir = path.join(dir, 'repos');
const repo = path.join(reposDir, 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo() {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main'); // -b for init needs git 2.28; this works on older ones too
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = (a, b) => a - b; // add\n');
    fs.writeFileSync(path.join(repo, 'check.js'), "const add = require('./app'); if (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); } console.log('ok');\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
}

// A stand-in for the Interceptor: scripted model replies, and the real guard rules
let script = [];
let modelCalls = [];
const fakeHarness = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
        const body = JSON.parse(data || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(body, { jev: false })));
        modelCalls.push({ body, headers: req.headers });
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'script ran out' })); }
        if (typeof next === 'number') { res.statusCode = next; return res.end(JSON.stringify({ error: 'nope' })); }
        res.end(JSON.stringify({ model: 'fake-model', usage: { prompt_tokens: 100, completion_tokens: 20 },
            choices: [{ message: { role: 'assistant', content: next.say || '', tool_calls: next.calls.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager;
test.before(async () => {
    makeRepo();
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5 });
});
test.after(async () => {
    fakeHarness.close();
    await require('../utils/powershellSession').closeAll();
});

test('a local Windows run reuses PowerShell between commands', { skip: process.platform !== 'win32' }, async () => {
    const sandbox = await LocalSandbox.create({
        repo, dir: path.join(dir, 'shell-worktree'), branch: 'harness/shell-test',
    });
    try {
        assert.match((await sandbox.exec("$global:harnessSessionValue = 'kept'; Write-Output ready")).output, /ready/);
        assert.match((await sandbox.exec('Write-Output $global:harnessSessionValue')).output, /kept/);
    } finally {
        await sandbox.destroy();
    }
});

async function settle(id, states = ['done', 'failed', 'stopped', 'incomplete']) {
    for (let i = 0; i < 1200; i++) {
        const run = manager.get(id);
        if (states.includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error(`run stayed ${manager.get(id).status}`);
}
const start = (cfg = {}) => manager.create({ goal: 'Fix add so it adds', repo, ...cfg });

test('an agent fixes the code on its own branch and the working copy is untouched', async () => {
    script = [
        { calls: [['list_files', {}]] },
        { calls: [['read_file', { path: 'app.js' }]] },
        { calls: [['edit_file', { path: 'app.js', old: 'a - b', new: 'a + b' }]] },
        { calls: [['run_command', { command: 'node check.js' }]] },
        { calls: [['finish', { summary: 'Changed minus to plus; check.js passes.' }]] },
    ];
    modelCalls = [];
    const { id } = start({ test: 'node check.js', profile: 'auto', effort: 'high' });
    const run = await settle(id);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.result.summary, 'Changed minus to plus; check.js passes.');
    assert.equal(run.result.tests.passed, true);
    assert.match(run.result.diffStat, /app\.js/);
    assert.deepEqual([run.steps, run.tokens], [5, { in: 500, out: 100 }]);
    // the branch holds the fix; the checked-out files do not change
    assert.equal(git(repo, 'show', `${run.branch}:app.js`).trim(), 'module.exports = (a, b) => a + b; // add');
    assert.match(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), /a - b/);
    assert.equal(git(repo, 'status', '--porcelain').trim(), '');
    assert.match(await manager.diff(id), /\+module\.exports = \(a, b\) => a \+ b/);
    // the run's routing reached the model call; the model saw the tool results
    assert.equal(modelCalls[0].headers['x-harness-profile'], 'auto');
    assert.equal(modelCalls[0].headers['x-harness-effort'], 'high');
    assert.match(modelCalls[0].headers['x-harness-request-id'], new RegExp(`^run-${id}-1$`));
    const second = modelCalls[1].body.messages;
    assert.equal(second.at(-1).role, 'tool');
    assert.match(second.at(-1).content, /app\.js/);
    // removing the run drops the workspace but keeps the branch
    await manager.remove(id);
    assert.equal(fs.existsSync(path.join(dir, 'runs', id)), false);
    assert.match(git(repo, 'branch', '--list', run.branch), /harness\//);
});

test('the guard refuses dangerous commands and asks a person about risky ones', async () => {
    script = [
        { calls: [['run_command', { command: 'rm -rf /' }]] },
        { calls: [['run_command', { command: 'rm -rf build' }]] },
        { calls: [['run_command', { command: 'echo second' }]] },
        { calls: [['finish', { summary: 'done' }]] },
    ];
    const { id } = start();
    for (let i = 0; i < 200 && manager.get(id).status !== 'waiting'; i++) await sleep(25);
    const waiting = manager.get(id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.pending.text, 'rm -rf build');
    assert.match(waiting.pending.reason, /Recursive delete/);
    manager.approve(id, false);
    const run = await settle(id);
    const results = run.events.filter((e) => e.type === 'result').map((e) => e.text);
    assert.match(results[0], /Blocked by the command guard: Recursive delete of the root/);
    assert.match(results[1], /A person declined this/);
    assert.match(results[2], /exit code 0\nsecond/);
    assert.equal(run.events.find((e) => e.type === 'approval').allowed, false);
    assert.equal(run.status, 'done');
});

test('an approved command runs', async () => {
    // -r on its own (no -f): the command means the same thing in PowerShell as in a POSIX shell
    script = [{ calls: [['run_command', { command: 'mkdir -p nothing-here; rm -r nothing-here' }]] }, { calls: [['finish', { summary: 'ok' }]] }];
    const { id } = start();
    for (let i = 0; i < 200 && manager.get(id).status !== 'waiting'; i++) await sleep(25);
    manager.approve(id, true);
    const run = await settle(id);
    // -r on its own (no -f): the command means the same thing in PowerShell as in a POSIX shell
    assert.match(run.events.find((e) => e.type === 'result').text, /exit code 0/);
    assert.throws(() => manager.approve(id, true), /nothing is waiting/);
});

test('the agent cannot leave its workspace, read .git, or see the harness keys', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-secret-value';
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'private');
    script = [
        { calls: [['write_file', { path: '../escape.txt', content: 'x' }]] },
        { calls: [['read_file', { path: path.join(dir, 'outside.txt') }]] },
        { calls: [['read_file', { path: '.git/config' }]] },
        { calls: [['write_file', { path: '.env', content: 'KEY=1' }]] },
        { calls: [['run_command', { command: 'env' }]] },
        { calls: [['finish', { summary: 'x' }]] },
    ];
    const { id } = start();
    for (let i = 0; i < 200 && manager.get(id).status !== 'waiting'; i++) await sleep(25);
    assert.equal(manager.get(id).pending.text.endsWith('.env'), true, 'writing .env needs a person');
    manager.approve(id, false);
    const run = await settle(id);
    const results = run.events.filter((e) => e.type === 'result').map((e) => e.text);
    assert.match(results[0], /outside the workspace/);
    assert.match(results[1], /outside the workspace/);
    assert.match(results[2], /\.git folder is off limits/);
    assert.match(results[3], /A person declined/);
    assert.doesNotMatch(results[4], /sk-or-secret-value/);
    assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
    delete process.env.OPENROUTER_API_KEY;
});

test('a run can be stopped, even in the middle of a command', async () => {
    script = [{ calls: [['run_command', { command: 'sleep 30' }]] }];
    const { id } = start();
    for (let i = 0; i < 200 && !manager.get(id).events.some((e) => e.type === 'tool'); i++) await sleep(25);
    await sleep(100);
    manager.stop(id);
    const run = await settle(id);
    assert.equal(run.status, 'stopped');
    assert.throws(() => manager.stop(id), /not running/);
});

test('a run ends as incomplete when it uses all its steps, and retries a busy model', async () => {
    script = [429, { calls: [['list_files', {}]] }, { calls: [['list_files', {}]] }];
    const { id } = start({ maxSteps: 2 });
    const run = await settle(id);
    assert.equal(run.status, 'incomplete');
    assert.match(run.result.summary, /Used all 2 steps/);
    // running out of steps is not a failure, so it is continued rather than retried
    assert.throws(() => manager.retry(id), /use Continue/);
    script = [400];
    const bad = await settle(start().id);
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /HTTP 400/);
});

test('a run that ran out of steps is carried on in the same run and branch', async () => {
    // the first part commits a change and then uses its last step
    script = [
        { calls: [['edit_file', { path: 'app.js', old: 'a - b', new: 'a + b' }]] },
        { calls: [['run_command', { command: 'node check.js' }]] },
    ];
    const { id } = start({ maxSteps: 2 });
    const first = await settle(id);
    assert.equal(first.status, 'incomplete');
    assert.equal(first.outOfSteps, true);
    assert.equal(first.continues, 0);
    assert.match(first.result.commit, /^[0-9a-f]{40}$/);
    // the second part is told where the first got to, and works on in the same run
    script = [{ calls: [['finish', { summary: 'carried on and finished' }]] }];
    modelCalls = [];
    const leg = manager.continueRun(id);
    assert.equal(leg.id, id, 'a continue is not a new run');
    assert.equal(leg.branch, first.branch, 'nor a new branch');
    const done = await settle(id);
    assert.equal(done.status, 'done');
    assert.equal(done.id, id);
    assert.equal(done.continues, 1);
    assert.equal(done.legs, 1);
    assert.equal(done.carriesOn, null);
    assert.match(modelCalls[0].body.messages[1].content, /carried on from an earlier part of the same run/);
    assert.match(modelCalls[0].body.messages[1].content, /used all 2 of its steps/);
    const notes = done.events.filter((e) => e.type === 'note').map((e) => e.text);
    assert.ok(notes.some((t) => /Carrying the run on/.test(t)));
    // what the earlier part did is still on the branch, and it is one branch, not two
    assert.match(git(repo, 'show', `${done.branch}:app.js`), /a \+ b/);
    assert.equal(done.result.commit, (await manager.get(id)).result.commit);
    // a run only carried on while it has run out of steps or time, and one still going can't be
    script = [400];
    const broke = await settle(start().id);
    assert.throws(() => manager.continueRun(broke.id), /only a run that ran out of steps or time/);
    script = [{ calls: [['finish', { summary: 'ok' }]] }];
    const busy = start({ maxSteps: 20 }).id;
    assert.throws(() => manager.continueRun(busy), /stop the run first/);
    await settle(busy);
});

test('a run that failed can be retried, and a debug run is told what went wrong', async () => {
    script = [400];
    const bad = await settle(start().id);
    assert.equal(bad.status, 'failed');
    // a retry is the same task on a fresh branch from the same start, with no excuses handed to it
    script = [{ calls: [['finish', { summary: 'second try worked' }]] }];
    const again = await settle(manager.retry(bad.id).id);
    assert.equal(again.status, 'done');
    assert.equal(again.goal, bad.goal);
    assert.equal(again.workflow, bad.workflow);
    assert.notEqual(again.branch, bad.branch);
    assert.equal(again.debugOf, null);
    assert.equal(manager.get(bad.id).debugRun, again.id);
    // a debug run gets the error, the failed tests and the last things the run did
    script = [400];
    const broke = await settle(start({ test: 'node check.js' }).id);
    script = [{ calls: [['finish', { summary: 'fixed' }]] }];
    modelCalls = [];
    const debug = await settle(manager.retry(broke.id, { debug: true }).id);
    assert.equal(debug.debugOf, broke.id);
    assert.equal(debug.debugDepth, 1);
    const first = modelCalls[0].body.messages[1].content;
    assert.match(first, /another attempt at the task above/);
    assert.match(first, /HTTP 400/);
    // the stage after it gets the reason too, without the brief being repeated
    assert.equal(debug.events.filter((e) => e.type === 'note' && /Debugging r/.test(e.text)).length, 1);
    // a run that ran out of steps or time was not a failure: nothing to debug
    script = [{ calls: [['list_files', {}]] }];
    const ran = await settle(start({ maxSteps: 1 }).id);
    assert.equal(ran.status, 'incomplete');
    assert.throws(() => manager.retry(ran.id, { debug: true }), /use Continue/);
    // nothing to debug in a run that worked, and a run still going has to be stopped first
    assert.throws(() => manager.retry(debug.id, { debug: true }), /did not fail/);
    script = [{ calls: [['finish', { summary: 'done' }]] }];
    const busy = start({ maxSteps: 20 }).id;
    assert.throws(() => manager.retry(busy), /stop the run first/);
    await settle(busy);
});

test('auto debug follows a failure on its own, but only so far', async () => {
    const quiet = async () => {
        for (let i = 0; i < 1200; i++) {
            if (!manager.list().some((r) => ['queued', 'running', 'waiting'].includes(r.status))) return;
            await sleep(25);
        }
        throw new Error('runs kept going');
    };
    script = Array.from({ length: 10 }, () => 400);
    const first = await settle(start({ autoDebug: 1 }).id);
    await quiet();
    const chain = [];
    for (let r = manager.get(first.id); r; r = r.debugRun ? manager.get(r.debugRun) : null) chain.push(r);
    assert.deepEqual(chain.map((r) => r.debugDepth), [0, 1, 2], JSON.stringify(chain.map((r) => [r.id, r.status, r.autoDebug, r.debugRun, r.error])));
    assert.ok(chain.every((r) => r.status === 'failed'));
    assert.equal(chain.at(-1).debugRun, null);
    assert.match(chain.at(-1).events.find((e) => e.type === 'note' && /Auto debug has tried/.test(e.text)).text, /stopping here/);
    // off unless asked for
    script = [400];
    const plain = await settle(start().id);
    assert.equal(plain.debugRun, null);
});

test('run.json is written even when the rename is refused (a scanner holding it open)', () => {
    const id = 'rlocked';
    const run = { id, status: 'done', created: '2020-01-01', events: [], tokens: { in: 0, out: 0 } };
    manager.runs.set(id, run);
    const folder = path.join(dir, 'runs', id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'run.json');
    const eperm = () => { const err = new Error('EPERM: operation not permitted, rename'); err.code = 'EPERM'; return err; };
    const real = fs.renameSync;
    let calls = 0;
    fs.renameSync = (...args) => { if (++calls <= 2) throw eperm(); return real(...args); };
    try { manager.save(run); } finally { fs.renameSync = real; }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, id);
    assert.equal(calls, 3);
    fs.renameSync = () => { throw eperm(); };
    try { manager.save({ ...run, status: 'failed' }); } finally { fs.renameSync = real; }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'failed');
    assert.deepEqual(fs.readdirSync(folder), ['run.json']); // no .tmp left behind
    manager.runs.delete(id);
});

test('only repos inside the allowed folders can be used, and the form is checked', () => {
    assert.throws(() => manager.create({ goal: 'x', repo: os.tmpdir() }), /not inside an allowed folder/);
    assert.throws(() => manager.create({ goal: 'x', repo: path.join(dir, 'missing') }), /does not exist/);
    assert.throws(() => manager.create({ goal: '  ', repo }), /goal is required/);
    assert.throws(() => manager.create({ goal: 'x', repo, effort: 'extreme' }), /effort must be/);
    assert.deepEqual(manager.repos(), [repo]);
});

test('the folder picker lists only folders inside the allowed roots and marks git repos', () => {
    fs.mkdirSync(path.join(reposDir, 'plain', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(reposDir, '.hidden'), { recursive: true });
    const top = manager.browse('');
    assert.equal(top.path, fs.realpathSync(reposDir)); // a single allowed folder is opened for you
    assert.equal(top.parent, null);
    const root = manager.browse(reposDir);
    assert.deepEqual(root.entries.map((e) => [e.name, e.git]), [['demo', true], ['plain', false]]);
    assert.equal(manager.browse(repo).git, true);
    const inner = manager.browse(path.join(reposDir, 'plain', 'inner'));
    assert.equal(inner.parent, fs.realpathSync(path.join(reposDir, 'plain')));
    assert.throws(() => manager.browse(os.tmpdir()), /not inside an allowed folder/);
    assert.throws(() => manager.browse(path.join(reposDir, '..')), /not inside an allowed folder/);
    assert.throws(() => manager.browse(path.join(dir, 'missing')), /does not exist/);
    assert.throws(() => manager.browse(path.join(repo, 'app.js')), /not a folder/);
});

test('old tool output is cut from the history sent to the model', () => {
    const messages = [{ role: 'system', content: 's' }, ...Array.from({ length: 30 }, (_, i) => ({ role: 'tool', content: `${i}`.padEnd(2000, 'x') }))];
    const out = shrinkHistory(messages);
    assert.ok(out[1].content.length < 500);
    assert.equal(out.at(-1).content.length, 2000);
});

test('a run that was running when the runner stopped is marked failed on restart', async () => {
    const id = 'rdead';
    fs.mkdirSync(path.join(dir, 'runs', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', id, 'run.json'), JSON.stringify({ id, status: 'running', created: '2020-01-01', events: [], tokens: { in: 0, out: 0 } }));
    const again = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir] });
    assert.equal(again.get(id).status, 'failed');
    assert.match(again.get(id).error, /restarted/);
});

test('a leg of a continued run keeps its own record, and a restart carries it on', async () => {
    // the run that ran out of steps, and a leg that is working when the runner stops
    script = [{ calls: [['list_files', {}]] }];
    const { id } = start({ maxSteps: 1 });
    const root = await settle(id);
    manager.continueRun(id);
    // look at once: a leg with nothing left to say folds itself back within milliseconds
    const leg = manager.get(id);
    assert.notEqual(leg, manager.runs.get(id), 'the leg and the run are separate records');
    assert.equal(manager.runs.get(id).goal, root.goal, 'the run keeps its own record while it is carried on');
    manager.stop(id);
    await settle(id);
    // the leg handed its record to the run, and its own file is cleared away
    assert.equal(fs.existsSync(path.join(dir, 'runs', id, `leg-${leg.continues}.json`)), false);
    assert.equal(manager.get(id).legs, 1);
    // a runner that stops while a leg is working finds both records and folds the leg into the run
    const folder = path.join(dir, 'runs', 'rhalf');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ id: 'rhalf', goal: 'the goal', branch: 'harness/rhalf', status: 'incomplete', continues: 0, legs: 0, events: [], tokens: { in: 0, out: 0 } }));
    fs.writeFileSync(path.join(folder, 'leg-1.json'), JSON.stringify({ id: 'rhalf', goal: 'the goal', branch: 'harness/rhalf', status: 'running', continues: 1, carriesOn: 'rhalf', steps: 4, events: [{ t: '2020-01-01', type: 'note', text: 'from the leg' }], tokens: { in: 0, out: 0 } }));
    const again = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir] });
    const back = again.get('rhalf');
    assert.equal(back.status, 'failed');
    assert.match(back.error, /restarted/);
    assert.equal(back.legs, 1);
    assert.equal(back.continues, 1);
    assert.equal(back.steps, 4);
    assert.equal(back.goal, 'the goal');
    assert.equal(back.branch, 'harness/rhalf');
    assert.ok(back.events.some((e) => e.text === 'from the leg'));
    assert.equal(fs.existsSync(path.join(folder, 'leg-1.json')), false, 'the leg was folded into the run');
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8')).legs, 1);
    fs.rmSync(folder, { recursive: true, force: true });
});

// The runner's own HTTP face, and the Interceptor's proxy to it
let runnerServer, runnerPort, harness, base;
test('the runner only answers loopback hosts, with its token, and JSON for changes', async () => {
    runnerServer = http.createServer(createApp(manager, { token: 'tok', port: 0 }));
    await new Promise((r) => runnerServer.listen(0, '127.0.0.1', r));
    runnerPort = runnerServer.address().port;
    // the app was built for port 0; allow the real one through the env list
    runnerServer.close();
    process.env.RUNNER_ALLOWED_HOSTS = `127.0.0.1:${runnerPort}`;
    runnerServer = http.createServer(createApp(manager, { token: 'tok', port: runnerPort }));
    await new Promise((r) => runnerServer.listen(runnerPort, '127.0.0.1', r));
    const url = `http://127.0.0.1:${runnerPort}/runs`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-runner-token': 'tok' } })).status, 200);
    // fetch won't let a script set Host, so ask the way a rebinding page's browser would: with another name
    const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: runnerPort, path: '/runs', headers: { host: 'evil.example', 'x-runner-token': 'tok' } }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert.equal(status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-runner-token': 'tok', 'content-type': 'text/plain' }, body: 'x' })).status, 415);
});

test('the Interceptor proxies the runner behind its own checks', async () => {
    process.env.RUNNER_URL = `http://127.0.0.1:${runnerPort}`;
    process.env.RUNNER_TOKEN = 'tok';
    process.env.GATEWAY_URL = 'http://127.0.0.1:9';
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
    script = [{ calls: [['finish', { summary: 'nothing to do' }]] }];
    const made = await fetch(`${base}/ui/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'Say hi', repo }) });
    assert.equal(made.status, 201);
    const { id } = await made.json();
    await settle(id);
    const list = await (await fetch(`${base}/ui/api/runs`)).json();
    assert.ok(list.runs.some((r) => r.id === id));
    const one = await (await fetch(`${base}/ui/api/runs/${id}`)).json();
    assert.equal(one.status, 'done');
    assert.equal((await fetch(`${base}/ui/api/runs/${id}/diff`)).status, 200);
    assert.equal((await fetch(`${base}/ui/api/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
    const bad = await fetch(`${base}/ui/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x', repo: '/etc' }) });
    assert.equal(bad.status, 400);
    // a run that ran out of steps is continued through the same face, as the same run
    script = [{ calls: [['list_files', {}]] }];
    const short = await (await fetch(`${base}/ui/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'Look around', repo, maxSteps: 1 }) })).json();
    await settle(short.id);
    script = [{ calls: [['finish', { summary: 'carried on' }]] }];
    const cont = await fetch(`${base}/ui/api/runs/${short.id}/continue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cont.status, 201);
    assert.equal((await cont.json()).id, short.id);
    await settle(short.id);
    assert.equal((await (await fetch(`${base}/ui/api/runs/${short.id}`)).json()).status, 'done');
    const browsed = await (await fetch(`${base}/ui/api/runs/browse?path=${encodeURIComponent(reposDir)}`)).json();
    assert.ok(browsed.entries.some((e) => e.name === 'demo' && e.git));
    assert.equal((await fetch(`${base}/ui/api/runs/browse?path=${encodeURIComponent(os.tmpdir())}`)).status, 400);
    runnerServer.close();
    const down = await fetch(`${base}/ui/api/runs`);
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /task runner is not running/);
    harness.close();
});
