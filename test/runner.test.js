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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const reposDir = path.join(dir, 'repos');
const repo = path.join(reposDir, 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo() {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
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
test.after(() => fakeHarness.close());

async function settle(id, states = ['done', 'failed', 'stopped', 'incomplete']) {
    for (let i = 0; i < 400; i++) {
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
    script = [{ calls: [['run_command', { command: 'rm -rf nothing-here' }]] }, { calls: [['finish', { summary: 'ok' }]] }];
    const { id } = start();
    for (let i = 0; i < 200 && manager.get(id).status !== 'waiting'; i++) await sleep(25);
    manager.approve(id, true);
    const run = await settle(id);
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
    script = [400];
    const bad = await settle(start().id);
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /HTTP 400/);
});

test('only repos inside the allowed folders can be used, and the form is checked', () => {
    assert.throws(() => manager.create({ goal: 'x', repo: os.tmpdir() }), /not inside an allowed folder/);
    assert.throws(() => manager.create({ goal: 'x', repo: path.join(dir, 'missing') }), /does not exist/);
    assert.throws(() => manager.create({ goal: '  ', repo }), /goal is required/);
    assert.throws(() => manager.create({ goal: 'x', repo, effort: 'extreme' }), /effort must be/);
    assert.deepEqual(manager.repos(), [repo]);
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
    runnerServer.close();
    const down = await fetch(`${base}/ui/api/runs`);
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /task runner is not running/);
    harness.close();
});
