// Branched workflows and human input stages: the file rules, the runs they make
// (branch yes/no, goto jumps, the visit limit, a person's answer, a default when
// nobody answers, stopping while waiting), and the answer route's refusals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-branch-')));
const wfDir = path.join(dir, 'workflows');
fs.mkdirSync(wfDir);
process.env.HARNESS_WORKFLOWS_DIR = wfDir; // read when utils/workflows loads, so set it first
const workflows = require('../utils/workflows');
const { RunManager } = require('../runner/runs');
const { scriptedGateway } = require('./helpers/stubs');
const M = require('../ui/workflowsModel.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = (id, role, over = {}) => ({ id, role, prompt: `Do the ${role} work.`, ...over });
const branch = (id, over) => ({ id, kind: 'branch', role: id[0].toUpperCase() + id.slice(1), ...over });
const human = (id, over) => ({ id, kind: 'human', role: 'Person', question: 'Go ahead?', ...over });

let wfCount = 0;
/** Writes a workflow file and returns its id. */
function writeWorkflow(stages, extra = {}) {
    const id = `wf-${++wfCount}`;
    fs.writeFileSync(path.join(wfDir, `${id}.json`), JSON.stringify({ id, name: id, stages, ...extra }));
    return id;
}

function makeRepo(name) {
    const repo = path.join(dir, 'repos', name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    return repo;
}

async function startGateway(gw) {
    await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${gw.server.address().port}`;
}

const managerFor = (harnessUrl, extra = {}) => new RunManager({ dir: path.join(dir, `runs-${Math.random().toString(36).slice(2)}`), roots: [path.join(dir, 'repos')], harnessUrl, retryDelayMs: 5, pollMs: 10, ...extra });

async function finished(manager, id, { until = ['done', 'failed', 'incomplete', 'stopped'] } = {}) {
    let run;
    for (let i = 0; i < 800; i++) { run = manager.get(id); if (until.includes(run.status)) break; await sleep(10); }
    return run;
}
const stageOrder = (run) => run.events.filter((e) => e.type === 'stage').map((e) => e.stage);

test('the file rules: kinds, goto outcomes, and what each kind needs', () => {
    assert.throws(() => workflows.clean({ id: 'x', stages: [branch('b', { ask: 'a?', contains: 'x' })] }, 'x.json'), /not both or neither/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [branch('b')] }, 'x.json'), /not both or neither/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [agent('a', 'A', { goto: { PASS: 'end' } })] }, 'x.json'), /can only choose where to go next/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [agent('a', 'A', { verdict: true, goto: { MAYBE: 'end' } })] }, 'x.json'), /no outcome MAYBE/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [branch('b', { contains: 'x', goto: { yes: 'nowhere' } })] }, 'x.json'), /names no stage/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [human('h', { options: ['Yes', 'No'], goto: { Maybe: 'end' } })] }, 'x.json'), /no outcome Maybe/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [human('h', { options: ['Yes'], defaultOption: 'Later' })] }, 'x.json'), /defaultOption must be one of/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [human('h', { timeoutMinutes: 0 })] }, 'x.json'), /timeoutMinutes/);
    assert.throws(() => workflows.clean({ id: 'x', stages: [{ id: 'a', kind: 'loop', role: 'A', prompt: 'p' }] }, 'x.json'), /kind must be/);
    // a person's answer with options defaults to the first option
    const h = workflows.clean({ id: 'x', stages: [human('h', { options: ['Ship', 'Stop'] })] }, 'x.json').stages[0];
    assert.equal(h.defaultOption, 'Ship');
    assert.equal(h.timeoutMinutes, 60);
});

test('a branched workflow saves and loads back the same, and linear stages keep their file form', () => {
    const stages = [
        agent('look', 'Looker', { tools: 'read' }),
        branch('gate', { ask: 'Did the tests fail?', goto: { yes: 'fix', no: 'end' } }),
        agent('fix', 'Fixer'),
        human('ok', { question: 'Ship it?', options: ['Ship', 'Stop'], defaultOption: 'Stop', timeoutMinutes: 15, goto: { Ship: 'end', Stop: 'end' } }),
    ];
    const clean = workflows.clean({ id: 'x', name: 'X', stages }, 'x.json');
    const file = workflows.toFile(clean);
    assert.deepEqual(file.stages[0], { id: 'look', role: 'Looker', tools: 'read', prompt: 'Do the Looker work.' });
    assert.deepEqual(file.stages[1], { id: 'gate', kind: 'branch', role: 'Gate', ask: 'Did the tests fail?', goto: { yes: 'fix', no: 'end' } });
    assert.deepEqual(file.stages[3], { id: 'ok', kind: 'human', role: 'Person', question: 'Ship it?', options: ['Ship', 'Stop'], defaultOption: 'Stop', timeoutMinutes: 15, goto: { Ship: 'end', Stop: 'end' } });
    assert.deepEqual(workflows.toFile(workflows.clean(file, 'x.json')), file);
});

test('a branch on contains sends the run down the yes stage, or ends it on no', async () => {
    const id = writeWorkflow([
        agent('look', 'Looker', { tools: 'read' }),
        branch('gate', { contains: 'NEEDS FIX', goto: { yes: 'fix', no: 'end' } }),
        agent('fix', 'Fixer'),
        agent('report', 'Reporter'),
    ]);
    const yes = scriptedGateway({ replies: [[['finish', { summary: 'Found it: NEEDS FIX in app.js' }]], [['finish', { summary: 'fixed' }]], [['finish', { summary: 'reported' }]]] });
    const harness = await startGateway(yes);
    const manager = managerFor(harness);
    const run = manager.create({ goal: 'look', repo: makeRepo('yes'), workflow: id });
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(stageOrder(done), ['look', 'gate', 'fix', 'report']);
    assert.match(done.events.find((e) => e.type === 'note' && /contains/.test(e.text)).text, /^Yes/);
    yes.server.close();

    const no = scriptedGateway({ replies: [[['finish', { summary: 'all clean' }]]] });
    const h2 = await startGateway(no);
    const m2 = managerFor(h2);
    const r2 = m2.create({ goal: 'look', repo: makeRepo('no'), workflow: id });
    const d2 = await finished(m2, r2.id);
    assert.equal(d2.status, 'done', d2.error);
    assert.deepEqual(stageOrder(d2), ['look', 'gate']);
    no.server.close();
});

test('a branch on Jev asks the question about the last summary, and continues when Jev cannot answer', async () => {
    const id = writeWorkflow([
        agent('look', 'Looker', { tools: 'read' }),
        branch('gate', { ask: 'Did the tests fail?', goto: { yes: 'fix', no: 'end' } }),
        agent('fix', 'Fixer'),
    ]);
    const gw = scriptedGateway({ replies: [[['finish', { summary: 'npm test: 3 failing' }]], [['finish', { summary: 'fixed' }]]], jev: (text) => /failing/.test(text) });
    const harness = await startGateway(gw);
    const manager = managerFor(harness);
    const run = manager.create({ goal: 'make the tests pass', repo: makeRepo('jev'), workflow: id });
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(stageOrder(done), ['look', 'gate', 'fix']);
    const asked = gw.calls.find((c) => c.url === '/v1/jev/ask');
    assert.equal(asked.body.question, 'Did the tests fail?');
    assert.match(asked.body.text, /3 failing/);
    gw.server.close();

    // Jev unreachable: the branch says so and the run goes to the next stage in order
    const down = scriptedGateway({ replies: [[['finish', { summary: 'ok' }]], [['finish', { summary: 'after' }]]], jev: () => { throw new Error('Router down'); } });
    const dh = await startGateway(down);
    const bid = writeWorkflow([agent('look', 'Looker', { tools: 'read' }), branch('gate', { ask: 'Failing?', goto: { yes: 'end' } }), agent('after', 'After')]);
    const bm = managerFor(dh);
    const br = bm.create({ goal: 'x', repo: makeRepo('jevdown'), workflow: bid });
    const bd = await finished(bm, br.id);
    assert.equal(bd.status, 'done', bd.error);
    assert.deepEqual(stageOrder(bd), ['look', 'gate', 'after']);
    assert.ok(bd.events.some((e) => e.type === 'note' && /Jev could not answer/.test(e.text)));
    down.server.close();
});

test('a goto back to an earlier stage loops until the visit limit stops it', async () => {
    const id = writeWorkflow([agent('check', 'Checker', { tools: 'read', verdict: true, goto: { FAIL: 'check' } })]);
    const replies = Array.from({ length: workflows.MAX_VISITS + 2 }, () => [['finish', { summary: 'FAIL: still wrong' }]]);
    const gw = scriptedGateway({ replies });
    const harness = await startGateway(gw);
    const manager = managerFor(harness);
    const run = manager.create({ goal: 'loop', repo: makeRepo('loop'), workflow: id });
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'incomplete');
    assert.equal(stageOrder(done).length, workflows.MAX_VISITS);
    assert.match(done.events.at(-1).text || done.events.filter((e) => e.type === 'note').at(-1).text, /run 12 times/);
    gw.server.close();
});

test('a verdict stage with a goto for PASS skips to the stage it names', async () => {
    const id = writeWorkflow([
        agent('check', 'Checker', { tools: 'read', verdict: true, goto: { PASS: 'done' } }),
        agent('fix', 'Fixer'),
        agent('done', 'Closer', { tools: 'read' }),
    ]);
    const gw = scriptedGateway({ replies: [[['finish', { summary: 'PASS: fine' }]], [['finish', { summary: 'closed' }]]] });
    const harness = await startGateway(gw);
    const manager = managerFor(harness);
    const run = manager.create({ goal: 'pass', repo: makeRepo('pass'), workflow: id });
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(stageOrder(done), ['check', 'done']);
    gw.server.close();
});

test('a person is asked, the run waits, and the answer picks the next stage and is handed on', async () => {
    const id = writeWorkflow([
        human('ask', { question: 'Ship it?', options: ['Ship', 'Stop'], defaultOption: 'Stop', goto: { Ship: 'deploy', Stop: 'end' } }),
        agent('deploy', 'Deployer', { tools: 'read' }),
    ]);
    const gw = scriptedGateway({ replies: [[['finish', { summary: 'deployed' }]]] });
    const harness = await startGateway(gw);
    const manager = managerFor(harness);
    const run = manager.create({ goal: 'ship', repo: makeRepo('human'), workflow: id });
    let waiting;
    for (let i = 0; i < 400; i++) { waiting = manager.get(run.id); if (waiting.status === 'waiting') break; await sleep(10); }
    assert.equal(waiting.status, 'waiting');
    assert.deepEqual([waiting.pending.kind, waiting.pending.text, waiting.pending.options], ['question', 'Ship it?', ['Ship', 'Stop']]);
    assert.throws(() => manager.answer(run.id, 'Maybe'), /answer with one of: Ship, Stop/);
    manager.answer(run.id, 'ship'); // any case
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(stageOrder(done), ['ask', 'deploy']);
    assert.equal(done.events.find((e) => e.type === 'answer').text, 'Ship');
    assert.match(gw.calls.find((c) => c.body?.messages).body.messages[1].content, /the person answered "Ship"/);
    assert.throws(() => manager.answer(run.id, 'Ship'), /nothing is waiting/);
    gw.server.close();
});

test('with no answer, the default is taken when the time runs out', async () => {
    const id = writeWorkflow([
        human('ask', { question: 'Ship it?', options: ['Ship', 'Stop'], defaultOption: 'Stop', timeoutMinutes: 1, goto: { Ship: 'deploy', Stop: 'end' } }),
        agent('deploy', 'Deployer', { tools: 'read' }),
    ]);
    const gw = scriptedGateway({ replies: [] });
    const harness = await startGateway(gw);
    const manager = managerFor(harness, { minuteMs: 15 });
    const run = manager.create({ goal: 'ship', repo: makeRepo('timeout'), workflow: id });
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(stageOrder(done), ['ask']);
    assert.match(done.events.find((e) => e.type === 'answer').why, /default was taken/);
    assert.equal(done.events.find((e) => e.type === 'answer').text, 'Stop');
    gw.server.close();
});

test('a free-text answer is handed to the next stage, and stopping a waiting run ends it', async () => {
    const id = writeWorkflow([
        human('ask', { question: 'What should the commit message say?' }),
        agent('write', 'Writer', { tools: 'read' }),
    ]);
    const gw = scriptedGateway({ replies: [[['finish', { summary: 'wrote it' }]]] });
    const harness = await startGateway(gw);
    const manager = managerFor(harness);
    const run = manager.create({ goal: 'commit', repo: makeRepo('text'), workflow: id });
    for (let i = 0; i < 400 && manager.get(run.id).status !== 'waiting'; i++) await sleep(10);
    manager.answer(run.id, '  Fix the login redirect  ');
    const done = await finished(manager, run.id);
    assert.equal(done.status, 'done', done.error);
    const prompt = gw.calls.find((c) => c.body?.messages).body.messages[1].content;
    assert.match(prompt, /the person answered "Fix the login redirect"/);

    // stop while waiting: the run ends as stopped, nothing else runs
    const id2 = writeWorkflow([human('ask', { question: 'Still there?' }), agent('after', 'After')]);
    const m2 = managerFor(harness);
    const r2 = m2.create({ goal: 'wait', repo: makeRepo('stopwait'), workflow: id2 });
    for (let i = 0; i < 400 && m2.get(r2.id).status !== 'waiting'; i++) await sleep(10);
    m2.stop(r2.id);
    const stopped = await finished(m2, r2.id);
    assert.equal(stopped.status, 'stopped');
    assert.deepEqual(stageOrder(stopped), ['ask']);
    gw.server.close();
});

// The editor's rules for the new kinds (ui/workflowsModel.js): the checks it shows, the plain-English lines,
// and how renaming or removing a stage moves the goto and retry lines that name it.
test('the editor checks the new kinds and keeps their references when a stage is renamed or removed', () => {
    const stages = [
        M.stage({ id: 'check', role: 'Checker', tools: 'check', verdict: true, prompt: 'Say PASS or FAIL.', goto: { PASS: 'end' }, retryTo: 'check' }),
        M.stage({ id: 'gate', role: 'Gate', kind: 'branch', ask: 'Failing?', goto: { yes: 'check', no: 'end' } }),
        M.stage({ id: 'ask', role: 'Person', kind: 'human', question: 'Ship?', options: ['Ship', 'Stop'], defaultOption: 'Stop', goto: { Ship: 'check', Stop: 'end' } }),
    ];
    assert.deepEqual(M.problems({ id: 'w', name: 'W', stages }), []);
    assert.deepEqual(M.outcomesFor(stages[0]), [{ key: 'PASS', label: 'PASS' }]);
    assert.deepEqual(M.outcomesFor(stages[1]).map((o) => o.key), ['yes', 'no']);
    assert.deepEqual(M.outcomesFor(stages[2]).map((o) => o.key), ['Ship', 'Stop']);

    const broken = [M.stage({ id: 'g', role: 'G', kind: 'branch', ask: 'a?', contains: 'b', goto: { maybe: 'nowhere' } }), M.stage({ id: 'h', role: 'H', kind: 'human', question: '', options: ['A'], defaultOption: 'Z' })];
    const msgs = M.problems({ id: 'w', name: 'W', stages: broken }).join('\n');
    assert.match(msgs, /G: a yes or no stage needs either a question for Jev or some text to look for, not both/);
    assert.match(msgs, /G: “maybe” is not an outcome/);
    assert.match(msgs, /H: write the question for the person/);
    assert.match(msgs, /H: the default answer must be one of its options/);

    assert.match(M.explain(stages, 1).join(' '), /Yes goes to Checker; no ends the run/);
    assert.match(M.explain(stages, 2).join(' '), /“Ship” goes to Checker/);
    assert.match(M.explain(stages, 2).join(' '), /If nobody answers in 60 minutes, “Stop” is taken/);

    const renamed = M.renameStage(stages, 0, 'review');
    assert.equal(renamed[0].id, 'review');
    assert.equal(renamed[0].retryTo, 'review');
    assert.equal(renamed[1].goto.yes, 'review');
    assert.equal(renamed[2].goto.Ship, 'review');
    assert.equal(renamed[1].goto.no, 'end', 'end is not a stage id and stays');

    const dropped = M.dropStage(stages, 0);
    assert.deepEqual(dropped.map((s) => s.id), ['gate', 'ask']);
    assert.deepEqual(dropped[0].goto, { no: 'end' }, 'a goto into the removed stage is cleared');
    assert.deepEqual(M.cleanGoto(stages[1], [stages[1], stages[2]]), { no: 'end' }, 'cleanGoto drops a target that is not in the run');
});

test('a new branch or person stage comes from a template with its own fields', () => {
    const branchT = M.STAGE_TEMPLATES.find((t) => t.key === 'branch');
    const personT = M.STAGE_TEMPLATES.find((t) => t.key === 'human');
    const made = M.fromTemplate(branchT, [M.stage({ id: 'check' })], 1);
    assert.equal(made.kind, 'branch');
    assert.equal(made.id, 'check-2');
    assert.equal(made.maxRetries, 0);
    const person = M.fromTemplate(personT, [], 0);
    assert.equal(person.kind, 'human');
    assert.deepEqual(person.options, ['Yes', 'No']);
    assert.deepEqual(M.problems({ id: 'w', name: 'W', stages: [made, person] }), []);
});
