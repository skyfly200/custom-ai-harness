// Exporting a run for debugging, the pull request brief, and the soft step budget.
// The model is a script; "GitHub" is a local bare repo reached through git's insteadOf.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-export-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { createApp } = require('../runner/server');
const { redact, toMarkdown } = require('../runner/runExport');
const { findPulls } = require('../runner/prBrief');
const { definitions } = require('../runner/tools');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bare = path.join(dir, 'origin.git');
const repo = path.join(dir, 'repos', 'custom-ai-harness');
const GITHUB = 'https://github.com/skyfly200/custom-ai-harness';

function makeRepos() {
    const seed = path.join(dir, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'config', 'user.email', 't@example.com'); git(seed, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(seed, 'app.js'), "const name = 'start';\n");
    git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'start');
    git(dir, 'clone', '-q', '--bare', seed, bare);
    // the pull request: changes line 1 one way; main then changes it another way
    git(seed, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(seed, 'app.js'), "const name = 'from the pr';\n");
    git(seed, 'commit', '-q', '-am', 'pr change');
    git(seed, 'push', '-q', bare, 'feature:refs/pull/195/head');
    git(seed, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(seed, 'app.js'), "const name = 'from main';\n");
    git(seed, 'commit', '-q', '-am', 'main change');
    git(seed, 'push', '-q', bare, 'main');
    // the working repo thinks its origin is on GitHub, which git redirects to the local bare repo
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    git(dir, 'clone', '-q', bare, repo);
    git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
    git(repo, 'remote', 'set-url', 'origin', `${GITHUB}.git`);
    git(repo, 'config', `url.${bare}.insteadOf`, `${GITHUB}.git`);
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

let script = [];
let modelCalls = [];
const fakeHarness = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
        const body = JSON.parse(data || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: { 'fake-model': { inputCost: 1e-5, outputCost: 3e-5 } } }));
        if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(body, { jev: false })));
        modelCalls.push({ body, headers: req.headers });
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'script ran out' })); }
        res.setHeader('x-harness-model', 'fake-model');
        res.setHeader('x-harness-route', 'win rate 0.4 vs threshold 0.5');
        res.setHeader('x-harness-tier', 'strong');
        res.end(JSON.stringify({ model: 'fake-model', usage: { prompt_tokens: 100 + modelCalls.length * 50, completion_tokens: 20 },
            choices: [{ message: { role: 'assistant', content: next.say || '', tool_calls: next.calls.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager, server, base;
test.before(async () => {
    makeRepos();
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.dirname(repo)], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5 });
    const probe = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => probe.on('listening', r));
    const port = probe.address().port;
    probe.close();
    process.env.RUNNER_ALLOWED_HOSTS = `127.0.0.1:${port}`;
    server = http.createServer(createApp(manager, { port })).listen(port, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
    fakeHarness.close(); server.close();
    await require('../utils/powershellSession').closeAll();
});

async function settle(id) {
    for (let i = 0; i < 1200; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'stopped', 'incomplete'].includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error('run did not end');
}
const get = (url) => fetch(`${base}${url}`);

test('findPulls reads pull request URLs out of a task', () => {
    assert.deepEqual(findPulls('update the pr to fix the merge conflict\nhttps://github.com/skyfly200/custom-ai-harness/pull/195').map((p) => p.number), [195]);
    assert.deepEqual(findPulls('see https://github.com/a/b/pull/1/files and https://github.com/a/b/pull/1 and https://github.com/a/b/pull/2'), [{ owner: 'a', name: 'b', number: 1 }, { owner: 'a', name: 'b', number: 2 }]);
    assert.deepEqual(findPulls('no link here'), []);
});

test('secrets are blanked in the export, and nothing else is', () => {
    const text = redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx and Authorization: Bearer abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz1234 at https://user:pw@example.com/x and plain words');
    assert.doesNotMatch(text, /sk-abc|abcdefghijklmnop1234|ghp_abc|user:pw/);
    assert.match(text, /plain words/);
    assert.deepEqual(redact({ a: ['token=abcdef123456', 3] }), { a: ['token=abcdef123456', 3] }); // lower case names are not guessed at
});

test('every tool but finish asks for a reason, which the agent loop strips before running it', () => {
    for (const d of definitions) {
        const has = d.function.parameters.properties.why;
        assert.equal(Boolean(has), d.function.name !== 'finish', d.function.name);
    }
});

test('a task naming a pull request starts on the PR, and the export holds the whole run', async () => {
    script = [
        { say: 'Plan: merge main, resolve app.js, test, commit.', calls: [['run_command', { why: 'Bring in main to see the conflict', command: 'git merge origin/main' }]] },
        { calls: [['run_command', { why: 'Check for leftover secrets in env', command: 'echo OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx' }]] },
        { calls: [['write_file', { why: 'Keep both sides', path: 'app.js', content: "const name = 'from main and the pr';\n" }]] },
        { calls: [['run_command', { why: 'Commit the merge', command: 'git add -A && git commit --no-edit -q' }]] },
        { calls: [['finish', { summary: 'Resolved app.js by keeping both.' }]] },
    ];
    modelCalls = [];
    const { id } = manager.create({ goal: `update the pr to fix the merge conflict\n${GITHUB}/pull/195`, repo, profile: 'auto' });
    const run = await settle(id);
    assert.equal(run.status, 'done', run.error);
    // the agent was told where the PR is before its first call, and the branch started on the PR's commit
    const first = modelCalls[0].body.messages[1].content;
    assert.match(first, /pull request skyfly200\/custom-ai-harness#195/);
    assert.match(first, /git merge origin\/main/);
    assert.equal(run.base, git(repo, 'rev-parse', 'refs/remotes/pr/195').trim());
    // the run's diff is the resolution on top of the PR, not the whole PR
    assert.match(await manager.diff(id), /-const name = 'from the pr'/);
    assert.match(git(repo, 'show', `${run.branch}:app.js`), /from main and the pr/);

    // the export, through the API
    const res = await get(`/runs/${id}/export?download=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), new RegExp(`run-${id}\\.json`));
    const x = await res.json();
    assert.equal(x.format, 'harness-run-export');
    assert.equal(x.run.goal, run.goal);
    assert.equal(x.run.settings.profile, 'auto');
    assert.equal(x.environment.node, process.version);
    const stepNums = x.steps.filter((s) => s.step).map((s) => s.step);
    assert.deepEqual(stepNums, [1, 2, 3, 4, 5]);
    const s1 = x.steps.find((s) => s.step === 1);
    assert.equal(s1.model.text, 'Plan: merge main, resolve app.js, test, commit.');
    assert.deepEqual([s1.model.route.model, s1.model.route.tier, s1.model.route.reason], ['fake-model', 'strong', 'win rate 0.4 vs threshold 0.5']);
    assert.ok(s1.model.cost > 0 && s1.model.ms >= 0 && s1.model.usage.prompt_tokens > 0);
    assert.equal(s1.tools[0].why, 'Bring in main to see the conflict');
    assert.equal(s1.tools[0].args.why, undefined); // the reason is its own field
    assert.match(s1.tools[0].result.text, /CONFLICT/);
    assert.equal(s1.tools[0].result.error, true); // a conflicted merge exits 1
    assert.ok(s1.tools[0].result.size > 0 && s1.tools[0].result.ms >= 0);
    // a secret the agent printed is blanked everywhere in the file
    const raw = JSON.stringify(x);
    assert.doesNotMatch(raw, /sk-abcdefghijklmnopqrstuvwx/);
    assert.match(raw, /OPENAI_API_KEY=\[redacted\]/);
    assert.match(x.result.diff, /from main and the pr/);
    assert.equal(x.result.commits.length > 0, true);
    assert.equal(x.insights.toolCalls, 5);
    assert.equal(x.insights.callsWithoutWhy, 0);
    assert.equal(x.insights.promptTokens.first < x.insights.promptTokens.last, true);

    // the readable version
    const md = await (await get(`/runs/${id}/export?format=md`)).text();
    assert.match(md, new RegExp(`^# Run ${id}`));
    assert.match(md, /### Step 1 .* fake-model/);
    assert.match(md, /Routing: win rate 0\.4 vs threshold 0\.5/);
    assert.match(md, /Bring in main to see the conflict/);
    assert.match(md, /## Result/);
    assert.doesNotMatch(md, /sk-abcdefghijklmnopqrstuvwx/);
    assert.equal((await get('/runs/nope/export')).status, 404);
});

test('a pull request in another repository is named as unreachable, not searched for', async () => {
    script = [{ calls: [['finish', { summary: 'cannot reach it' }]] }];
    modelCalls = [];
    const { id } = manager.create({ goal: 'fix https://github.com/someone/else/pull/7', repo });
    await settle(id);
    assert.match(modelCalls[0].body.messages[1].content, /different repository/);
});

test('past the soft step budget the run goes on, with a warning on the run and a nudge to the model', async () => {
    script = [
        ...[1, 2, 3, 4].map((n) => ({ calls: [['list_files', { why: `look ${n}`, path: '.' }]] })),
        { calls: [['finish', { summary: 'done' }]] },
    ];
    modelCalls = [];
    const { id } = manager.create({ goal: 'look around', repo, softSteps: 2 });
    const run = await settle(id);
    assert.equal(run.status, 'done');
    const warnings = run.events.filter((e) => e.type === 'warning');
    assert.deepEqual(warnings.map((w) => w.step), [2, 4]);
    assert.equal(run.warning.step, 4);
    assert.match(modelCalls[2].body.messages.at(-1).content, /2 steps used so far/);
    assert.match(require('../ui/runview').summarize(run), /Warning: 4 steps used/);
});

test('the run page says what the agent said it is doing', () => {
    const { quickLine } = require('../ui/runview');
    const events = [{ type: 'tool', name: 'read_file', args: { path: 'a.js' }, why: 'See how the merge was set up' }];
    assert.equal(quickLine({ status: 'running', events }), 'See how the merge was set up');
    assert.equal(quickLine({ status: 'running', events: [{ type: 'tool', name: 'read_file', args: { path: 'a.js' } }] }), 'Reading a.js');
});

test('a markdown export of an empty run still renders', () => {
    const x = { run: { id: 'r1', goal: 'g', status: 'queued', repo: '/r', branch: 'harness/r1', settings: {}, totals: {} }, insights: { toolCalls: 0, callsByTool: {}, failedCalls: 0, callsWithoutWhy: 0, repeatedCalls: [], promptTokens: {}, costliestSteps: [] }, steps: [], result: null };
    assert.match(toMarkdown(x), /# Run r1: g/);
});
