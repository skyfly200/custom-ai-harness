// Plan mode: the agent reads the repo and answers with a plan, and nothing in the
// workspace is touched. The fake harness plays the agent; the sandbox is a real
// git worktree, so a write would land in it if the tools let one through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-')));
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let script = [];
let calls = [];
const fake = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
        const body = JSON.parse(data || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: {} }));
        if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(body, { jev: false })));
        calls.push(body);
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end('{"error":"script ran out"}'); }
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: next.map(([name, args], i) => ({ id: `c${calls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager, repo;
test.before(async () => {
    repo = path.join(dir, 'repos', 'demo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.js'), 'exports.a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fake.address().port}`, maxRuns: 1, retryDelayMs: 5, pollMs: 20 });
});
test.after(() => fake.close());

async function settle(id) {
    for (let i = 0; i < 600; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'stopped', 'incomplete'].includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error(`stayed ${manager.get(id).status}`);
}

test('a plan run is offered only reading tools, and may not write', async () => {
    script = [];
    calls = [];
    // The agent tries to write, then tries a shell command. Neither is offered;
    // both calls come back as unknown tools, so the workspace cannot be changed.
    script = [
        [['read_file', { path: 'a.js' }]],
        [['write_file', { path: 'a.js', content: 'exports.a = 99;\n' }]],
        [['run_command', { command: 'echo changed > a.js' }]],
        [['finish', { summary: 'Plan: change a to 2 in a.js, then run the tests.' }]],
    ];
    const { id } = manager.create({ goal: 'Change a', repo, plan: '1' });
    const run = await settle(id);
    assert.equal(run.plan, true);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.result.commit, null, 'a plan makes no commit');
    assert.equal(run.result.diffStat, '', 'and has no diff');
    assert.match(run.result.summary, /Plan: change a to 2/);

    // the tools the model was offered: reading only, no shell or file writes
    const offered = calls[0].tools.map((t) => t.function.name);
    assert.deepEqual(offered.sort(), ['finish', 'list_files', 'read_file'].sort());
    assert.ok(!offered.includes('write_file'));
    assert.ok(!offered.includes('edit_file'));
    assert.ok(!offered.includes('run_command'));

    // the file on disk is untouched, and the branch (the worktree's, made by git)
    // has no commit of its own: it still points at where the run started
    assert.equal(git(repo, 'show', 'HEAD:a.js').trim(), 'exports.a = 1;');
    assert.equal(git(repo, 'status', '--porcelain').trim(), '');
    assert.equal(git(repo, 'rev-parse', `harness/${id}`).trim(), git(repo, 'rev-parse', 'HEAD').trim(), 'no commit of its own');
});

test('a normal run still gets the writing tools and commits its change', async () => {
    script = [
        [['write_file', { path: 'a.js', content: 'exports.a = 2;\n' }]],
        [['finish', { summary: 'a is 2' }]],
    ];
    calls = [];
    const { id } = manager.create({ goal: 'Change a', repo });
    const run = await settle(id);
    assert.equal(run.plan, false);
    assert.equal(run.status, 'done', run.error);
    assert.ok(run.result.commit, 'an ordinary run commits what it changed');
    assert.equal(git(repo, 'show', `${run.branch}:a.js`).trim(), 'exports.a = 2;');
    const offered = calls[0].tools.map((t) => t.function.name);
    assert.ok(offered.includes('write_file') && offered.includes('edit_file'));
});

test('the plan rules tell the agent to answer with the plan and change nothing', () => {
    const { systemFor, PLAN_RULES } = require('../runner/agent');
    const stage = { role: 'Engineer', prompt: 'Do the task.' };
    assert.match(systemFor(stage, { plan: true }), /planning, not changing anything/);
    assert.match(systemFor(stage, { plan: true }), /cannot write, edit or run commands/);
    assert.doesNotMatch(systemFor(stage, { plan: false }), /planning, not changing anything/);
    assert.match(PLAN_RULES, /call finish with your plan/);
});
