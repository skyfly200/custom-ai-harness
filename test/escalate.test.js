// Escalation: a failed or empty model call, or a Verifier saying FAIL, raises the
// run's effort one rung (so the harness picks a stronger tier), never past the
// run's maxTier header, at most twice, and not at all when the run opts out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-escalate-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { effortAfter, canClimb } = require('../runner/escalate');

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
        const next = script.shift();
        if (typeof next === 'number') { res.statusCode = next; return res.end('{"error":"busy"}'); }
        const list = next || [];
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: list.map(([name, args], i) => ({ id: `c${calls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager;
test.before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fake.address().port}`, retryDelayMs: 1 });
});
test.after(() => fake.close());

async function settle(id) {
    for (let i = 0; i < 600; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'incomplete', 'stopped'].includes(run.status)) return run;
        await sleep(20);
    }
    throw new Error('run did not settle');
}

test('effort climbs one rung per bump and stops at max or after two', () => {
    assert.equal(effortAfter(null, 1), 'high');
    assert.equal(effortAfter('low', 1), 'medium');
    assert.equal(effortAfter('high', 5), 'max');
    assert.equal(canClimb({ bumps: 0 }), true);
    assert.equal(canClimb({ bumps: 2 }), false);
    assert.equal(canClimb({ bumps: 0, escalate: false }), false);
    assert.equal(canClimb({ bumps: 0, effort: 'max' }), false);
});

test('an empty reply is asked again with more effort, under the same max tier', async () => {
    script = [[], [['finish', { summary: 'done' }]]];
    calls = [];
    const run = await settle(manager.create({ goal: 'x', repo, workflow: 'quick-answer', effort: 'low', maxTier: 'Strong' }).id);
    assert.equal(run.status, 'done', run.error);
    assert.deepEqual(calls.map((c) => c.headers['x-harness-effort']), ['low', 'medium']);
    assert.ok(calls.every((c) => c.headers['x-harness-max-tier'] === 'Strong'));
    assert.equal(run.bumps, 1);
    assert.ok(run.events.some((e) => e.type === 'note' && /stronger model.*empty reply/.test(e.text)));
});

test('a busy harness after the usual retries escalates once more, then gives up', async () => {
    script = [503, 503, 503, [['finish', { summary: 'ok' }]]];
    calls = [];
    let run = await settle(manager.create({ goal: 'x', repo, workflow: 'quick-answer' }).id);
    assert.equal(run.status, 'done', run.error);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map((c) => c.headers['x-harness-effort']), ['low', 'low', 'low', 'medium']); // quick-answer's own effort is low
    // always failing: three rounds of three calls (two bumps), then the error stands
    script = Array(20).fill(503);
    calls = [];
    run = await settle(manager.create({ goal: 'x', repo, workflow: 'quick-answer' }).id);
    assert.equal(run.status, 'failed');
    assert.equal(calls.length, 9);
    assert.equal(run.bumps, 2);
});

test('a request the harness refuses outright, or a run that opted out, does not escalate', async () => {
    script = [400];
    calls = [];
    let run = await settle(manager.create({ goal: 'x', repo, workflow: 'quick-answer' }).id);
    assert.equal(run.status, 'failed');
    assert.equal(run.bumps, 0);
    script = [[], [['finish', { summary: 'late' }]]];
    calls = [];
    run = await settle(manager.create({ goal: 'x', repo, workflow: 'quick-answer', escalate: false }).id);
    assert.equal(run.status, 'failed');
    assert.equal(run.bumps, 0);
    assert.equal(calls.length, 1);
});

test('a Verifier FAIL sends the retry stage back at a higher effort', async () => {
    script = [
        [['finish', { summary: 'Cause found.' }]],                                         // investigate
        [['write_file', { path: 'app.js', content: 'module.exports = 2;\n' }]],           // fix
        [['finish', { summary: 'changed' }]],
        [['finish', { summary: 'FAIL: still wrong.' }]],                                   // verify
        [['finish', { summary: 'changed again' }]],                                        // fix again
        [['finish', { summary: 'PASS' }]],                                                 // verify
    ];
    calls = [];
    const run = await settle(manager.create({ goal: 'x', repo, workflow: 'fix-bug' }).id);
    assert.equal(run.status, 'done', run.error);
    const efforts = calls.map((c) => c.headers['x-harness-effort'] || '');
    // the stage efforts before FAIL differ per stage; after FAIL every call is one rung higher
    assert.equal(run.bumps, 1);
    assert.ok(run.events.some((e) => /Verifier said FAIL/.test(e.text) && /stronger model/.test(e.text)));
    assert.notDeepEqual(efforts.slice(0, 3), efforts.slice(3).slice(0, 3));
});
