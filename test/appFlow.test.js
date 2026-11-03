// The Wayfinder app flow: the planner grills and drafts, the orchestrator dispatches
// Haiku workers, merges them, asks the person decisions and falls back to the advisor.
// Runs against a fake manager and sandbox, so no model, git worktree or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../runner/appFlow');
const { MODELS, EFFORTS, readDraft, planApp, traverse, MAX_WORKERS } = app;

function fakeWorld({ script = [], answers = [] } = {}) {
    const calls = [];          // every model call: { model, effort, tools }
    const events = [];
    const children = [];       // worker runs the flow created
    const merges = [];
    const human = [];          // questions the flow asked
    const left = script.slice();
    let k = 0;
    let released = false;
    const manager = {
        pollMs: 0,
        dir: '/tmp/unused',
        sandboxKind: 'local',
        async chat(run, messages, tools, n, effort, model) {
            calls.push({ model, effort, tools: (tools || []).map((t) => t.function.name), messages });
            const step = left.shift();
            if (!step) throw new Error(`no scripted reply for ${model}`);
            if (step.before) step.before();
            const tool_calls = (step.calls || []).map((c) => ({ id: `call${++k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
            return { message: { content: step.text || '', ...(tool_calls.length ? { tool_calls } : {}) }, usage: { prompt_tokens: 1, completion_tokens: 1 }, model };
        },
        event(run, e) { events.push(e); },
        save() {},
        create(cfg) {
            const id = `w${children.length + 1}`;
            const advised = /advisor said/.test(cfg.goal);
            const failing = /FAIL always/.test(cfg.goal) || (/FAIL/.test(cfg.goal) && !advised);
            const child = {
                id, cfg, branch: `harness/${id}`,
                status: /HOLD/.test(cfg.goal) && !released ? 'running' : failing ? 'failed' : 'done',
                error: failing ? 'the tests failed' : null,
                result: { commit: /NOCOMMIT/.test(cfg.goal) ? null : `c${id}`, summary: `worker ${id} says so` },
            };
            children.push(child);
            return { id };
        },
        get(id) { return children.find((c) => c.id === id); },
        stop() {},
        async runHumanStage({ stage }) {
            human.push(stage.question);
            if (!answers.length) return { status: 'stopped', summary: 'Stopped by a person.' };
            return { status: 'finished', answer: answers.shift() };
        },
    };
    const sandbox = {
        base: 'base0', kind: 'local',
        async git(args) {
            if (args.includes('merge') && !args.includes('--abort')) {
                const branch = args.at(-1);
                merges.push(branch);
                const goal = children.find((c) => c.branch === branch)?.cfg.goal || '';
                if (/CONFLICT/.test(goal) && !/advisor said/.test(goal)) throw new Error('CONFLICT');
            }
            return '';
        },
    };
    const run = { id: 'r1', goal: 'a notes app', owner: null, repo: '/repo', branch: 'harness/r1', base: 'base0', sandbox: 'local', maxMinutes: 30, maxCost: 0, events, children: [] };
    const live = { stopped: false };
    const ctx = { manager, run, live, sandbox, cloud: false, n: 0, advice: 0, deadline: Date.now() + 60000 };
    const release = () => { released = true; children.forEach((c) => { if (c.status === 'running') c.status = 'done'; }); };
    return { manager, ctx, run, live, calls, events, children, merges, human, left, release };
}

const draftOf = (tickets) => JSON.stringify({ goal: 'a notes app', tickets });

test('a draft is read into tickets, and a bad one says why', () => {
    const ok = readDraft(`Here: ${draftOf([
        { id: 'db', kind: 'decision', title: 'Which database', description: 'pick one' },
        { id: 'api', title: 'API', description: 'the api', acceptance_criteria: ['GET /notes works'], depends_on: ['db'] },
        { id: 'look', kind: 'research', title: 'Look at auth', description: 'how does login work' },
    ])}`);
    assert.deepEqual(ok.tickets.map((t) => [t.id, t.kind, t.status]), [['db', 'decision', 'todo'], ['api', 'build', 'todo'], ['look', 'research', 'todo']]);
    assert.deepEqual(ok.tickets[1].acceptance, ['GET /notes works']);
    const cases = [
        [[{ id: 'a' }, { id: 'a' }], 'used twice'],
        [[{ id: 'a', depends_on: ['nope'] }], 'which is not in the draft'],
        [[{ id: 'a', depends_on: ['a'] }], 'depends on itself'],
        [[{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }], 'loop'],
        [[{ id: 'a', kind: 'task' }], 'kind must be'],
        [[{ title: 'no id' }], 'needs an id'],
        [Array.from({ length: 21 }, (_, i) => ({ id: `t${i}` })), 'at most'],
    ];
    for (const [tickets, why] of cases) assert.throws(() => readDraft(draftOf(tickets)), new RegExp(why));
    assert.throws(() => readDraft('no json here'), /not a JSON object/);
    assert.throws(() => readDraft({ tickets: [] }), /no tickets/);
});

test('the planner grills the person, then finishes once its draft is usable', async () => {
    const world = fakeWorld({
        answers: ['Yes, accounts'],
        script: [
            { calls: [{ name: 'ask_person', args: { question: 'Do users sign in?', options: ['Yes', 'No'] } }] },
            { calls: [{ name: 'finish', args: { draft: draftOf([{ id: 'a', id2: 1 }, { id: 'a' }]) } }] },
            { calls: [{ name: 'finish', args: { draft: draftOf([{ id: 'build', title: 'Notes page', description: 'list notes', acceptance_criteria: ['shows notes'] }]) } }] },
        ],
    });
    const out = await planApp(world.ctx, ['server.js', 'README.md']);
    assert.equal(out.status, 'finished');
    assert.deepEqual(out.draft.tickets.map((t) => t.id), ['build']);
    assert.deepEqual(world.human, ['Do users sign in?']);
    const [first, second, third] = world.calls;
    assert.equal(first.model, MODELS.planner);
    assert.equal(first.effort, EFFORTS.planner);
    assert.ok(first.tools.includes('ask_person') && first.tools.includes('ask_advisor'));
    // the planner was told the answer, and the bad draft came back as a tool result it could fix
    assert.ok(second.messages.some((m) => m.role === 'tool' && /The person answered: Yes, accounts/.test(m.content)));
    assert.ok(third.messages.some((m) => m.role === 'tool' && /not usable: ticket id “a” is used twice/.test(m.content)));
});

test('the planner can ask the advisor, on Opus', async () => {
    const world = fakeWorld({
        script: [
            { calls: [{ name: 'ask_advisor', args: { question: 'Sqlite or Postgres for ten users?' } }] },
            { text: 'Sqlite; it is enough for ten users.' },
            { calls: [{ name: 'finish', args: { draft: draftOf([{ id: 'x', title: 'X', description: 'x' }]) } }] },
        ],
    });
    const out = await planApp(world.ctx, []);
    assert.equal(out.status, 'finished');
    assert.equal(world.calls[1].model, MODELS.advisor);
    assert.equal(world.calls[1].effort, EFFORTS.advisor);
    assert.deepEqual(world.calls[1].tools, []);
    assert.ok(world.calls[2].messages.some((m) => m.role === 'tool' && /Sqlite; it is enough/.test(m.content)));
});

test('the orchestrator starts Haiku workers, asks the decision in between, and merges in order', async () => {
    const draft = readDraft(draftOf([
        { id: 'db', kind: 'decision', title: 'Which database', description: 'pick one' },
        { id: 'first', title: 'Scaffold', description: 'make the project', acceptance_criteria: ['npm test passes'] },
        { id: 'api', title: 'API', description: 'the notes api', depends_on: ['db', 'first'] },
        { id: 'look', kind: 'research', title: 'Look at auth', description: 'how does login work' },
    ]));
    const world = fakeWorld({
        answers: ['Postgres'],
        script: [
            { calls: [{ name: 'dispatch', args: { ticket_id: 'first' } }] },
            { calls: [{ name: 'ask_person', args: { question: 'Which database?', ticket_id: 'db', options: ['Postgres', 'SQLite'] } }] },
            { calls: [{ name: 'dispatch', args: { ticket_id: 'look' } }] },
            { calls: [{ name: 'dispatch', args: { ticket_id: 'api' } }] },
            { calls: [{ name: 'finish', args: { summary: 'All done.' } }] },
        ],
    });
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'finished', out.summary);
    assert.match(out.summary, /Built 2 of 2 build tickets/);
    assert.deepEqual(world.human, ['Which database?']);
    // the workers: Haiku with minimal reasoning; the research one uses its own workflow
    assert.deepEqual(world.children.map((c) => [c.cfg.workflow, c.cfg.model, c.cfg.effort]), [
        ['general', MODELS.worker, EFFORTS.worker], ['research', MODELS.worker, EFFORTS.worker], ['general', MODELS.worker, EFFORTS.worker],
    ]);
    // the api worker was told the decision, and it was started only after the scaffold merged
    assert.match(world.children[2].cfg.goal, /Postgres/);
    assert.deepEqual(world.merges, ['harness/w1', 'harness/w3']);
    assert.equal(world.children[0].cfg.parent, 'r1');
    // the board on the run: every ticket with its state, and the files its merged worker changed
    const board = Object.fromEntries(world.run.appTickets.map((t) => [t.id, t]));
    assert.deepEqual(world.run.appTickets.map((t) => [t.id, t.status]), [['db', 'done'], ['first', 'done'], ['api', 'done'], ['look', 'done']]);
    assert.equal(board.db.decision, 'Postgres');
    assert.equal(board.api.child, 'w3');
    assert.equal(board.first.diffStat, '');   // the fake worker reports no diff stat
    assert.equal(world.calls[0].model, MODELS.orchestrator);
    assert.equal(world.calls[0].effort, EFFORTS.orchestrator);
});

test('a failed worker waits for the advisor, then is tried again with its advice', async () => {
    const draft = readDraft(draftOf([{ id: 'page', title: 'Page', description: 'FAIL the first time', acceptance_criteria: ['renders'] }]));
    const world = fakeWorld({
        script: [
            { calls: [{ name: 'dispatch', args: { ticket_id: 'page' } }] },
            { calls: [{ name: 'dispatch', args: { ticket_id: 'page' } }] },   // refused: it failed, advice first
            { calls: [{ name: 'ask_advisor', args: { question: 'Why did it fail?', ticket_id: 'page' } }] },
            { text: 'Escape the title before rendering it.' },
            { calls: [{ name: 'dispatch', args: { ticket_id: 'page' } }] },
            { calls: [{ name: 'finish', args: { summary: 'Done.' } }] },
        ],
    });
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'finished', out.summary);
    assert.equal(world.children.length, 2);
    assert.match(world.children[1].cfg.goal, /Escape the title/);
    assert.equal(world.calls[2].model, MODELS.orchestrator);
    assert.equal(world.calls[3].model, MODELS.advisor);
    assert.ok(world.calls[2].messages.some((m) => m.role === 'tool' && /Call ask_advisor with ticket_id "page" first/.test(m.content)));
});

test('a ticket that fails three times is given up, and what waits on it is left out', async () => {
    const draft = readDraft(draftOf([
        { id: 'auth', title: 'Auth', description: 'FAIL always' },
        { id: 'pages', title: 'Pages', description: 'needs auth', depends_on: ['auth'] },
    ]));
    const advise = (id) => [{ calls: [{ name: 'ask_advisor', args: { question: 'again?', ticket_id: id } }] }, { text: 'Try harder.' }];
    const world = fakeWorld({
        script: [
            { calls: [{ name: 'dispatch', args: { ticket_id: 'auth' } }] }, ...advise('auth'),
            { calls: [{ name: 'dispatch', args: { ticket_id: 'auth' } }] }, ...advise('auth'),
            { calls: [{ name: 'dispatch', args: { ticket_id: 'auth' } }] },
            { calls: [{ name: 'finish', args: { summary: 'Stuck.' } }] },
        ],
    });
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'incomplete');
    assert.equal(world.children.length, 3);
    assert.match(out.summary, /auth \[build, failed\]/);
    assert.match(out.summary, /pages \[build, skipped\]: Pages \(needs “auth”/);
});

test('no more than three workers run at once, and finish waits for every ticket', async () => {
    const tickets = Array.from({ length: MAX_WORKERS + 1 }, (_, i) => ({ id: `t${i}`, title: `Part ${i}`, description: `HOLD part ${i}` }));
    const draft = readDraft(draftOf(tickets));
    const world = fakeWorld({
        script: [
            ...tickets.slice(0, MAX_WORKERS).map((t) => ({ calls: [{ name: 'dispatch', args: { ticket_id: t.id } }] })),
            { calls: [{ name: 'dispatch', args: { ticket_id: 't3' } }] },
            { calls: [{ name: 'finish', args: { summary: 'early' } }] },
            { before: () => world.release(), calls: [{ name: 'dispatch', args: { ticket_id: 't3' } }] },
            { calls: [{ name: 'finish', args: { summary: 'Built all four.' } }] },
        ],
    });
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'finished', out.summary);
    const toolResults = (i) => world.calls[i].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    // each refusal is in the next call's messages
    assert.ok(toolResults(4).some((c) => /3 workers are already running/.test(c)));
    assert.ok(toolResults(5).some((c) => /Not finished yet/.test(c)));
    assert.equal(world.merges.length, 4);
});

test('a worker that changed nothing settles its ticket, and a merge conflict fails it', async () => {
    const draft = readDraft(draftOf([
        { id: 'noop', title: 'Noop', description: 'NOCOMMIT already there' },
        { id: 'clash', title: 'Clash', description: 'CONFLICT with the others' },
    ]));
    const world = fakeWorld({
        script: [
            { calls: [{ name: 'dispatch', args: { ticket_id: 'noop' } }, { name: 'dispatch', args: { ticket_id: 'clash' } }] },
            { calls: [{ name: 'status', args: {} }] },
            { calls: [{ name: 'ask_advisor', args: { question: 'merge clash?', ticket_id: 'clash' } }] },
            { text: 'Rebase onto the merged work first.' },
            { calls: [{ name: 'dispatch', args: { ticket_id: 'clash' } }] },
            { calls: [{ name: 'finish', args: { summary: 'x' } }] },
        ],
    });
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'finished', out.summary);
    assert.match(out.summary, /noop \[build, done\]: Noop \(changed nothing\)/);
    assert.match(out.summary, /clash \[build, done\]: Clash \(merged\)/);
    // the first try's merge clashed and was aborted; the advised retry merged
    assert.deepEqual(world.merges, ['harness/w2', 'harness/w3']);
});

test('on a cloud sandbox a ticket that builds on merged work is left out, as the swarm does', async () => {
    const draft = readDraft(draftOf([
        { id: 'one', title: 'One', description: 'first' },
        { id: 'two', title: 'Two', description: 'second', depends_on: ['one'] },
    ]));
    const world = fakeWorld({
        script: [
            { calls: [{ name: 'dispatch', args: { ticket_id: 'one' } }] },
            { calls: [{ name: 'dispatch', args: { ticket_id: 'two' } }] },
            { calls: [{ name: 'finish', args: { summary: 'x' } }] },
        ],
    });
    world.ctx.cloud = true;
    world.ctx.run.base = 'base0';
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'incomplete');
    assert.match(out.summary, /two \[build, skipped\]/);
    assert.match(out.summary, /needs the local sandbox/);
    assert.equal(world.children[0].cfg.base, 'base0');
});

test('a stop ends the flow at once', async () => {
    const draft = readDraft(draftOf([{ id: 'a', title: 'A', description: 'a' }]));
    const world = fakeWorld({ script: [] });
    world.live.stopped = true;
    const out = await app.traverse(world.ctx, draft);
    assert.equal(out.status, 'stopped');
    assert.equal(world.calls.length, 0);
});
