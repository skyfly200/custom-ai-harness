// Workflows: the recipe files, Jev's pick, and a multi-stage run with a
// failing check that sends the work back once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-workflows-')));
const workflows = require('../utils/workflows');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { makeTools } = require('../runner/tools');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the shipped recipes all load, and exactly one is the fallback', () => {
    const { list, problems } = workflows.load();
    assert.deepEqual(problems, []);
    assert.deepEqual(list.map((w) => w.id).sort(), ['audit-refactor', 'build-audit', 'build-feature', 'change-app', 'fix-bug', 'general', 'one-shot', 'quick-answer', 'refactor', 'research', 'review']);
    assert.deepEqual(list.filter((w) => w.fallback).map((w) => w.id), ['general']);
    for (const w of list.filter((x) => !x.fallback)) assert.ok(w.when, `${w.id} needs a "when" line for Jev`);
});

test('broken recipes are reported and skipped', () => {
    const d = fs.mkdtempSync(path.join(dir, 'wf-'));
    fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify({ id: 'ok', stages: [{ id: 'a', prompt: 'p' }] }));
    fs.writeFileSync(path.join(d, 'bad-tools.json'), JSON.stringify({ id: 'bad', stages: [{ id: 'a', prompt: 'p', tools: 'root' }] }));
    fs.writeFileSync(path.join(d, 'bad-retry.json'), JSON.stringify({ id: 'bad2', stages: [{ id: 'a', prompt: 'p', retryTo: 'zz' }] }));
    fs.writeFileSync(path.join(d, 'junk.json'), '{nope');
    const { list, problems } = workflows.load(d);
    assert.deepEqual(list.map((w) => w.id), ['ok']);
    assert.equal(problems.length, 3);
});

test('Jev picks the best workflow above the threshold, else the fallback', async () => {
    let asked;
    const ask = (p) => async (text, qs) => { asked = { text, qs }; return Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, /bug report/.test(q) ? p : 0.1])); };
    const hit = await workflows.pick('Login fails with a TypeError', { ask: ask(0.8) });
    assert.deepEqual([hit.id, hit.by], ['fix-bug', 'jev']);
    assert.ok(Object.values(asked.qs).every((q) => q.startsWith('Is this task ')));
    assert.ok(!Object.values(asked.qs).some((q) => /any other task/.test(q)), 'the fallback is not a question');
    const miss = await workflows.pick('hello', { ask: ask(0.3) });
    assert.deepEqual([miss.id, miss.by], ['general', 'default']);
    const down = await workflows.pick('x y z', { ask: async () => { throw new Error('Router answered HTTP 502'); } });
    assert.deepEqual([down.id, down.by], ['general', 'default']);
    assert.match(down.note, /502/);
    assert.equal((await workflows.pick('', { ask: ask(1) })).id, 'general');
});

test('tool sets limit what a stage can call', async () => {
    const calls = [];
    const sandbox = { listDir: () => ['a'], readFile: () => 'x', resolve: (p) => p, writeFile: () => calls.push('write'), exec: async () => ({ code: 0, output: '', ms: 1 }) };
    const make = (toolset) => makeTools({ sandbox, toolset, check: async () => ({ decision: 'allow' }), approve: async () => true });
    const read = make('read');
    assert.deepEqual(read.definitions.map((d) => d.function.name), ['list_files', 'read_file', 'finish']);
    assert.match((await read.call('write_file', { path: 'a', content: 'b' })).text, /Unknown tool write_file/);
    assert.match((await read.call('run_command', { command: 'ls' })).text, /Unknown tool/);
    assert.equal(calls.length, 0);
    assert.ok(make('check').definitions.some((d) => d.function.name === 'run_command'));
    assert.equal(make('all').definitions.length, 6);
});

// A run through fix-bug: investigate (read-only), fix, verify says FAIL once, fix again, verify PASS
let script = [];
let modelCalls = [];
const fakeHarness = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
        const body = JSON.parse(data || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: {} }));
        if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(body, { jev: false })));
        modelCalls.push({ body, headers: req.headers });
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end('{"error":"script ran out"}'); }
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: next.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

test('a multi-stage run hands summaries on and retries after a failed check', async () => {
    const repo = path.join(dir, 'repos', 'demo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = (a, b) => a - b;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    const manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5 });
    script = [
        [['finish', { summary: 'Cause: app.js subtracts.' }]],                                       // investigate
        [['write_file', { path: 'app.js', content: 'module.exports = (a, b) => a * b;\n' }]],        // fix (wrong)
        [['finish', { summary: 'Changed to multiply.' }]],
        [['finish', { summary: 'FAIL: 2 * 3 is not 5.' }]],                                          // verify
        [['write_file', { path: 'app.js', content: 'module.exports = (a, b) => a + b;\n' }]],        // fix again
        [['finish', { summary: 'Changed to add.' }]],
        [['finish', { summary: 'PASS: add(2,3) is 5.' }]],                                           // verify
    ];
    const { id, workflow } = manager.create({ goal: 'add is wrong', repo, workflow: 'fix-bug' });
    assert.equal(workflow, 'fix-bug');
    let run;
    for (let i = 0; i < 400; i++) { run = manager.get(id); if (['done', 'failed', 'incomplete'].includes(run.status)) break; await sleep(25); }
    assert.equal(run.status, 'done', run.error);
    assert.deepEqual(run.events.filter((e) => e.type === 'stage').map((e) => e.stage), ['investigate', 'fix', 'verify', 'fix', 'verify']);
    // the investigator could only read; the fixer got the investigator's finding
    assert.deepEqual(modelCalls[0].body.tools.map((t) => t.function.name), ['list_files', 'read_file', 'run_command', 'finish']);
    assert.ok(modelCalls[1].body.tools.some((t) => t.function.name === 'write_file'));
    assert.match(modelCalls[1].body.messages[1].content, /Cause: app\.js subtracts/);
    assert.match(modelCalls[1].body.messages[0].content, /Your role in this run: Implementer/);
    // the retried fixer is told what the verifier found
    assert.match(modelCalls[4].body.messages[1].content, /FAIL: 2 \* 3 is not 5/);
    assert.equal(git(repo, 'show', `${run.branch}:app.js`).trim(), 'module.exports = (a, b) => a + b;');
    assert.match(run.result.summary, /Investigator: Cause/);
    assert.match(run.result.summary, /Verifier: PASS/);
    assert.equal(run.steps, 7);
    fakeHarness.close();
});

test('an unknown workflow is refused when the run is created', () => {
    const manager = new RunManager({ dir: path.join(dir, 'runs2'), roots: [dir], harnessUrl: 'http://127.0.0.1:9' });
    assert.throws(() => manager.create({ goal: 'x', repo: dir, workflow: 'nope' }), /no workflow named nope|does not exist|git/);
});

test('the shipped workflows set no step limit on any stage', () => {
    const { list } = workflows.load();
    assert.ok(list.length);
    for (const w of list) for (const s of w.stages) assert.equal(s.maxSteps, 0, `${w.id}/${s.id}`);
});
