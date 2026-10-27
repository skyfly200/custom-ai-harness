// The adversarial audit loop: a critic stage that says FAIL sends the work back,
// round after round, until it says PASS or the rounds run out; a stage can pin
// its own model so the critic differs from the refactorer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-audit-')));
const wfDir = path.join(dir, 'wf');
fs.mkdirSync(wfDir);
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'audit-refactor.json'), 'utf8'));
shipped.stages[1].model = 'critic-model';
fs.writeFileSync(path.join(wfDir, 'audit-refactor.json'), JSON.stringify(shipped));
fs.writeFileSync(path.join(wfDir, 'general.json'), JSON.stringify({ id: 'general', fallback: true, stages: [{ id: 'a', prompt: 'p' }] }));
process.env.HARNESS_WORKFLOWS_DIR = wfDir;
const workflows = require('../utils/workflows');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = path.join(dir, 'repos', 'demo');

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
        calls.push({ body, headers: req.headers });
        const summary = script.shift() ?? 'PASS';
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 1, completion_tokens: 1 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `c${calls.length}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary }) } }] } }] }));
    });
});
let manager;
test.before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fake.address().port}`, retryDelayMs: 1 });
});
test.after(() => fake.close());

async function settle(id) {
    for (let i = 0; i < 600; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'incomplete'].includes(run.status)) return run;
        await sleep(20);
    }
    throw new Error('run did not settle');
}

test('the shipped audit workflow loads, with up to 3 retries and a critic stage', () => {
    const real = workflows.load(path.join(__dirname, '..', 'workflows')).list.find((w) => w.id === 'audit-refactor');
    assert.equal(real.stages[1].verdict, true);
    assert.equal(real.stages[1].retryTo, 'refactor');
    assert.equal(real.stages[1].maxRetries, 3);
    assert.equal(workflows.clean({ id: 'x', stages: [{ id: 'a', prompt: 'p', maxRetries: 9, retryTo: 'a' }] }, 'f').stages[0].maxRetries, 5);
    assert.throws(() => workflows.clean({ id: 'x', stages: [{ id: 'a', prompt: 'p', model: 'bad model' }] }, 'f'), /model must be a model name/);
});

test('the critic sends the work back until it passes, and only the critic uses its own model', async () => {
    script = ['Refactored.', 'FAIL: 1. a.js lost a caller', 'Fixed the caller.', 'FAIL: 1. test weakened', 'Restored the test.', 'PASS: nothing real left'];
    calls = [];
    const run = await settle(manager.create({ goal: 'refactor a.js', repo, workflow: 'audit-refactor' }).id);
    assert.equal(run.status, 'done', run.error);
    assert.deepEqual(run.events.filter((e) => e.type === 'stage').map((e) => e.stage), ['refactor', 'audit', 'refactor', 'audit', 'refactor', 'audit']);
    assert.deepEqual(calls.map((c) => c.headers['x-harness-model'] || null), [null, 'critic-model', null, 'critic-model', null, 'critic-model']);
    assert.ok(run.events.some((e) => /going back to refactor \(round 2 of 4\)/.test(e.text || '')));
    // the refactorer is told what the critic found
    assert.match(calls[2].body.messages[1].content, /FAIL: 1\. a\.js lost a caller/);
});

test('a critic that never passes ends the run for a person, after the round limit', async () => {
    script = Array.from({ length: 8 }, (_, i) => (i % 2 ? `FAIL: round ${(i + 1) / 2}` : 'Did something.'));
    calls = [];
    const run = await settle(manager.create({ goal: 'refactor a.js', repo, workflow: 'audit-refactor' }).id);
    assert.equal(run.status, 'incomplete');
    assert.equal(run.events.filter((e) => e.type === 'stage' && e.stage === 'audit').length, 4);
    assert.ok(run.events.some((e) => /still says FAIL after 4 rounds/.test(e.text || '')));
});

test('a run that pins a model keeps it for every stage', async () => {
    script = ['Done.', 'PASS'];
    calls = [];
    await settle(manager.create({ goal: 'x', repo, workflow: 'audit-refactor', model: 'mine' }).id);
    assert.deepEqual(calls.map((c) => c.headers['x-harness-model']), ['mine', 'mine']);
});
