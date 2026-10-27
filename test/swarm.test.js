// Swarm: a planner splits the goal, workers run on their own branches, the
// branches are merged into the swarm's branch and a reviewer checks it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-swarm-')));
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { parsePlan } = require('../runner/swarm');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the plan is read from the planner’s reply, with a safe fallback', () => {
    const ok = parsePlan('Here you go: {"parts":[{"title":"A","task":"do a","workflow":"fix-bug"},{"title":"B","task":"do b","workflow":"bogus"},{"task":" "}]}', 'whole');
    assert.deepEqual(ok.parts.map((p) => [p.title, p.workflow]), [['A', 'fix-bug'], ['B', 'general']]);
    assert.equal(parsePlan('{"parts":[1,2,3,4,5,6,7].map', 'g').parts.length, 1);
    for (const bad of ['no json', '{"parts":[]}', '{oops}']) {
        const r = parsePlan(bad, 'the goal');
        assert.deepEqual(r.parts.map((p) => p.task), ['the goal']);
        assert.ok(r.note);
    }
    const many = parsePlan(JSON.stringify({ parts: Array.from({ length: 9 }, (_, i) => ({ title: `p${i}`, task: `t${i}` })) }), 'g');
    assert.equal(many.parts.length, 5);
});

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
        modelCalls.push(body);
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end('{"error":"script ran out"}'); }
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: next.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
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
    fs.writeFileSync(path.join(repo, 'b.js'), 'exports.b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    // one worker at a time, so the scripted replies come in a fixed order
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, maxRuns: 1, retryDelayMs: 5, pollMs: 20 });
});
test.after(() => fakeHarness.close());

async function settle(id) {
    for (let i = 0; i < 600; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'stopped', 'incomplete'].includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error(`stayed ${manager.get(id).status}`);
}
const plan = (parts) => [['finish', { summary: JSON.stringify({ parts }) }]];

test('workers change different files and the swarm branch holds both', async () => {
    modelCalls = [];
    script = [
        plan([{ title: 'Bump a', task: 'Set a to 2 in a.js' }, { title: 'Bump b', task: 'Set b to 2 in b.js' }]),
        [['write_file', { path: 'a.js', content: 'exports.a = 2;\n' }]], [['finish', { summary: 'a is 2' }]],
        [['write_file', { path: 'b.js', content: 'exports.b = 2;\n' }]], [['finish', { summary: 'b is 2' }]],
        [['finish', { summary: 'PASS: both files updated.' }]],
    ];
    const { id, kind } = manager.create({ goal: 'Bump a and b', repo, workflow: 'swarm', test: 'node -e "const a=require(\'./a\'),b=require(\'./b\');process.exit(a.a===2&&b.b===2?0:1)"' });
    assert.equal(kind, 'swarm');
    const run = await settle(id);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.children.length, 2);
    assert.ok(run.children.every((c) => manager.get(c).parent === id && manager.get(c).status === 'done'));
    assert.equal(git(repo, 'show', `${run.branch}:a.js`).trim(), 'exports.a = 2;');
    assert.equal(git(repo, 'show', `${run.branch}:b.js`).trim(), 'exports.b = 2;');
    assert.match(run.result.summary, /Merged 2 of 2 parts/);
    assert.match(run.result.summary, /Reviewer: PASS/);
    assert.equal(run.result.tests.passed, true);
    assert.match(await manager.diff(id), /exports\.a = 2/);
    // the planner could only read; each worker was told its part and that it is one of several
    assert.deepEqual(modelCalls[0].tools.map((t) => t.function.name), ['list_files', 'read_file', 'finish']);
    assert.match(modelCalls[1].messages[1].content, /Set a to 2/);
    assert.match(modelCalls[1].messages[1].content, /one part of a larger task/);
    assert.match(modelCalls.at(-1).messages[1].content, /Bump a \(done\): a is 2/);
});

test('a part that conflicts with another is left out and the swarm is incomplete', async () => {
    script = [
        plan([{ title: 'First', task: 'edit a.js one way' }, { title: 'Second', task: 'edit a.js another way' }]),
        [['write_file', { path: 'a.js', content: 'exports.a = 10;\n' }]], [['finish', { summary: 'ten' }]],
        [['write_file', { path: 'a.js', content: 'exports.a = 20;\n' }]], [['finish', { summary: 'twenty' }]],
        [['finish', { summary: 'PASS: fine.' }]],
    ];
    const run = await settle(manager.create({ goal: 'Change a', repo, workflow: 'swarm' }).id);
    assert.equal(run.status, 'incomplete');
    assert.match(run.result.summary, /Merged 1 of 2 parts: First/);
    assert.match(run.result.summary, /Left out - Second: conflicts/);
    assert.equal(git(repo, 'show', `${run.branch}:a.js`).trim(), 'exports.a = 10;');
    assert.equal(git(path.join(dir, 'runs', run.id, 'work'), 'status', '--porcelain').trim(), '');
});

test('an unreadable plan runs the whole task as one worker, and a failing worker means nothing to merge', async () => {
    script = [
        [['finish', { summary: 'I would split it up somehow' }]],
        [['finish', { summary: 'nothing to do' }]],
    ];
    const run = await settle(manager.create({ goal: 'Do something', repo, workflow: 'swarm' }).id);
    assert.equal(run.children.length, 1);
    assert.equal(run.status, 'incomplete');
    assert.match(run.result?.summary || run.error || '', /Merged 0 of 1 parts|Left out - Whole task: changed nothing/);
    assert.ok(run.events.some((e) => /not return a plan/.test(e.text || '')));
});

test('stopping a swarm stops its workers', async () => {
    script = [plan([{ title: 'Slow', task: 'wait' }]), [['run_command', { command: 'sleep 30' }]]];
    const { id } = manager.create({ goal: 'Wait', repo, workflow: 'swarm' });
    for (let i = 0; i < 200 && !(manager.get(id).children.length && manager.get(manager.get(id).children[0]).steps >= 1); i++) await sleep(25);
    manager.stop(id);
    const run = await settle(id);
    assert.equal(run.status, 'stopped');
    assert.equal((await settle(run.children[0])).status, 'stopped');
});

const { parseTickets } = require('../runner/tickets');

test('a ticket draft becomes build tickets in waves, with the rest listed', () => {
    const draft = { tickets: [
        { id: 'why', kind: 'decision', title: 'Pick a format' },
        { id: 'a', kind: 'build', title: 'A', description: 'do a', acceptance_criteria: ['a is 2'], depends_on: ['why'] },
        { id: 'b', kind: 'build', title: 'B', description: 'do b', depends_on: ['a'] },
        { id: 'c', kind: 'build', title: 'C', description: 'do c' },
    ] };
    const r = parseTickets(JSON.stringify(draft));
    assert.deepEqual(r.waves, [['a', 'c'], ['b']]);
    assert.deepEqual(r.other.map((t) => t.id), ['why']);
    assert.match(r.tickets[0].task, /- a is 2/);
    assert.deepEqual(r.tickets.find((t) => t.id === 'a').needs, [], 'a decision is not waited for');
    assert.throws(() => parseTickets('nope'), /not valid JSON/);
    assert.throws(() => parseTickets({ tickets: [{ id: 'x', depends_on: ['y'] }] }), /not in the draft/);
    assert.throws(() => parseTickets({ tickets: [{ id: 'x', depends_on: ['y'] }, { id: 'y', depends_on: ['x'] }] }), /loop/);
    assert.throws(() => parseTickets({ tickets: [{ id: 'x', kind: 'research' }] }), /no build tickets/);
    assert.throws(() => manager.create({ goal: 'g', repo, tickets: '{"tickets":[{"id":"a"}]}' }), /needs the Swarm/);
});

test('a ticket that depends on another starts from the swarm branch after it', async () => {
    modelCalls = [];
    script = [
        // wave 1: a; wave 2: b, which can see a's change
        [['write_file', { path: 'a.js', content: 'exports.a = 2;\n' }]], [['finish', { summary: 'a is 2' }]],
        [['read_file', { path: 'a.js' }]], [['write_file', { path: 'b.js', content: 'exports.b = require("./a").a + 1;\n' }]], [['finish', { summary: 'b follows a' }]],
        [['finish', { summary: 'PASS: both.' }]],
    ];
    const tickets = { tickets: [
        { id: 'b', kind: 'build', title: 'B', description: 'make b one more than a', depends_on: ['a'] },
        { id: 'a', kind: 'build', title: 'A', description: 'set a to 2' },
    ] };
    const { id } = manager.create({ goal: 'a then b', repo, workflow: 'swarm', tickets: JSON.stringify(tickets) });
    const run = await settle(id);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.children.length, 2);
    assert.match(run.result.summary, /Merged 2 of 2 parts/);
    assert.equal(git(repo, 'show', `${run.branch}:b.js`).trim(), 'exports.b = require("./a").a + 1;');
    // the second worker was started from the swarm branch, so a's change was already there
    const second = manager.get(run.children[0]);
    assert.notEqual(second.base, run.base);
    assert.equal(git(repo, 'show', `${second.base}:a.js`).trim(), 'exports.a = 2;');
    assert.equal(modelCalls.some((c) => /Planner/i.test(JSON.stringify(c.messages[0]))), false, 'no planner ran');
});

test('tickets in the shape of Matt Pocock’s wayfinder are read, and a draft can be exported to it', () => {
    const { toWayfinderMap } = require('../runner/tickets');
    const issues = [
        { number: 5, title: 'Pick a store', body: '## Question\n\nSQLite or files?', labels: [{ name: 'wayfinder:grilling' }] },
        { number: 6, title: 'Build the store', body: 'Blocked by: #5\n\nwrite it', labels: [{ name: 'wayfinder:task' }, { name: 'build' }] },
        { number: 7, title: 'The map', body: '## Destination', labels: [{ name: 'wayfinder:map' }] },
    ];
    const r = parseTickets(JSON.stringify(issues));
    assert.deepEqual(r.tickets.map((t) => t.id), ['6'], 'only the build-labelled issue is code to write; the map is not a ticket');
    assert.deepEqual(r.other.map((t) => t.id), ['5']);
    assert.deepEqual(r.tickets[0].needs, [], 'a decision it was blocked by is not waited for');
    assert.equal(r.tickets[0].task, 'write it');

    const out = toWayfinderMap({ goal: 'Ship it', destinations: [{ outcome: 'It ships' }], fog_of_war: [{ question: 'Which host?', impact: 'deploy' }],
        tickets: [{ id: 'a', kind: 'decision', title: 'A', description: 'Which?' }, { id: 'b', kind: 'build', title: 'B', description: 'Do', depends_on: ['a'], acceptance_criteria: ['works'] }] });
    assert.deepEqual(out.map.labels, ['wayfinder:map']);
    for (const h of ['## Destination', '## Notes', '## Decisions so far', '## Not yet specified', '## Out of scope']) assert.match(out.map.body, new RegExp(h));
    assert.match(out.map.body, /Which host\?/);
    assert.deepEqual(out.tickets[0].labels, ['wayfinder:grilling']);
    assert.deepEqual(out.tickets[1].labels, ['wayfinder:task', 'build']);
    assert.match(out.tickets[1].body, /^## Question/);
    assert.deepEqual(out.tickets[1].blocked_by, ['a']);
    // and what we export reads back in
    assert.deepEqual(parseTickets(JSON.stringify(out.tickets)).tickets.map((t) => t.id), ['b']);
});

test('with audit each part, a ticket worker is checked by an Auditor and sent back once', async () => {
    modelCalls = [];
    script = [
        [['write_file', { path: 'a.js', content: 'exports.a = 5;\n' }]], [['finish', { summary: 'a is 5' }]],
        [['finish', { summary: 'FAIL: 1. a.js should be 2, not 5' }]],
        [['write_file', { path: 'a.js', content: 'exports.a = 2;\n' }]], [['finish', { summary: 'a is 2' }]],
        [['finish', { summary: 'PASS' }]],
        [['finish', { summary: 'PASS: whole.' }]],
    ];
    const tickets = { tickets: [{ id: 'a', kind: 'build', title: 'A', description: 'set a to 2' }] };
    const { id } = manager.create({ goal: 'a', repo, workflow: 'swarm', tickets: JSON.stringify(tickets), auditParts: '1' });
    const run = await settle(id);
    assert.equal(run.status, 'done', run.error);
    assert.equal(manager.get(run.children[0]).workflow, 'build-audit');
    assert.equal(git(repo, 'show', `${run.branch}:a.js`).trim(), 'exports.a = 2;');
    assert.ok(modelCalls.some((c) => /a\.js should be 2/.test(JSON.stringify(c.messages))), 'the worker was told what the Auditor found');
    // and without the option the worker keeps the plain workflow
    script = [[['finish', { summary: 'nothing to do' }]], [['finish', { summary: 'PASS' }]]];
    const plain = await settle(manager.create({ goal: 'a', repo, workflow: 'swarm', tickets: JSON.stringify(tickets) }).id);
    assert.equal(manager.get(plain.children[0]).workflow, 'general');
});
