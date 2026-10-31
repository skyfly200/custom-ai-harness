// Persistent agents: a named agent keeps its repo, workflow and instructions; its tasks
// are runs that start from what the last task committed and are told what it did.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { createApp } = require('../runner/server');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const reposDir = path.join(dir, 'repos');
const repo = path.join(reposDir, 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        if (!next) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'script ran out' })); }
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: next.calls.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager, server, base;
const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
    return { status: res.status, body: await res.json() };
};
async function settle(id) {
    for (let i = 0; i < 1200; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'stopped', 'incomplete'].includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error('stuck');
}
const writes = (file, text) => ({ calls: [['write_file', { path: file, content: text }]] });

test.before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'start\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5 });
    server = createApp(manager, { port: 0 }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
    fakeHarness.close();
    server.close();
    await require('../utils/powershellSession').closeAll();
});

// the runner only answers loopback host names it was started on; the test app was given port 0
test('an agent is created, edited, linked to a chat project and listed', async () => {
    // the host check uses the port given to createApp, so rebuild the app on the real port
    server.close();
    const port = 40000 + Math.floor(Math.random() * 20000);
    server = createApp(manager, { port }).listen(port, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${port}`;

    assert.equal((await call('POST', '/agents', { name: '', repo })).status, 400);
    assert.match((await call('POST', '/agents', { name: 'x', repo: '/nowhere' })).body.error, /does not exist|not inside/);
    assert.match((await call('POST', '/agents', { name: 'x', repo, workflow: 'swarm' })).body.error, /no workflow named swarm/);
    const made = await call('POST', '/agents', { name: 'Docs keeper', repo, instructions: 'Keep notes short.', project: { id: 'p1', name: 'Docs' } });
    assert.equal(made.status, 201);
    assert.deepEqual([made.body.workflow, made.body.project, made.body.taskCount, made.body.head], ['general', { id: 'p1', name: 'Docs' }, 0, null]);
    const id = made.body.id;
    assert.match(id, /^a/);
    const patched = await call('PATCH', `/agents/${id}`, { name: 'Notes keeper', project: null, effort: 'high' });
    assert.deepEqual([patched.body.name, patched.body.project, patched.body.effort, patched.body.instructions], ['Notes keeper', null, 'high', 'Keep notes short.']);
    assert.equal((await call('PATCH', `/agents/${id}`, { effort: 'huge' })).status, 400);
    // a cost limit in dollars: set, cleared with blank or 0, refused when not a number
    assert.equal((await call('PATCH', `/agents/${id}`, { maxCost: '1.5' })).body.maxCost, 1.5);
    assert.equal((await call('PATCH', `/agents/${id}`, { maxCost: 0 })).body.maxCost, null);
    assert.equal((await call('PATCH', `/agents/${id}`, { maxCost: 'lots' })).status, 400);
    assert.equal((await call('PATCH', `/agents/${id}`, { iconSeed: ' k3x9 ' })).body.iconSeed, 'k3x9');
    assert.equal((await call('PATCH', `/agents/${id}`, { iconSeed: '' })).body.iconSeed, null);
    assert.equal((await call('PATCH', `/agents/${id}`, { iconText: ' 🙂abcdef ' })).body.iconText, '🙂abc');
    const pic = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    assert.equal((await call('PATCH', `/agents/${id}`, { iconImage: pic })).body.iconImage, pic);
    assert.equal((await call('PATCH', `/agents/${id}`, { iconImage: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400);
    assert.equal((await call('PATCH', `/agents/${id}`, { iconImage: 'javascript:alert(1)' })).status, 400);
    assert.equal((await call('PATCH', `/agents/${id}`, { iconImage: null, iconText: '' })).body.iconImage, null);
    assert.equal((await call('GET', '/agents')).body.agents.length, 1);
    // it survives a restart of the runner
    const again = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], harnessUrl: 'http://127.0.0.1:1' });
    assert.equal(again.listAgents()[0].name, 'Notes keeper');
});

test('tasks build on each other and each is told what the earlier ones did', async () => {
    const agent = manager.listAgents()[0];
    script = [writes('one.txt', '1\n'), { calls: [['finish', { summary: 'Wrote one.txt.' }]] }];
    modelCalls = [];
    const t1 = (await call('POST', `/agents/${agent.id}/tasks`, { goal: 'Add one.txt', source: { chat: { id: 'c1', title: 'A chat' } } })).body;
    const r1 = await settle(t1.id);
    assert.equal(r1.status, 'done', r1.error);
    assert.equal(r1.agent, agent.id);
    assert.deepEqual(r1.source, { chat: { id: 'c1', title: 'A chat' } });
    assert.match(modelCalls[0].messages.map((m) => m.content).join('\n'), /You are Notes keeper[\s\S]*Keep notes short\./);
    assert.equal(manager.agents.get(agent.id).head, r1.result.commit);

    // the second task starts on the first task's commit, so its branch holds both files
    script = [writes('two.txt', '2\n'), { calls: [['finish', { summary: 'Wrote two.txt.' }]] }];
    modelCalls = [];
    const t2 = (await call('POST', `/agents/${agent.id}/tasks`, { goal: 'Add two.txt' })).body;
    const r2 = await settle(t2.id);
    assert.equal(r2.status, 'done', r2.error);
    assert.equal(r2.base, r1.result.commit);
    assert.equal(git(repo, 'show', `${r2.branch}:one.txt`), '1\n');
    assert.equal(git(repo, 'show', `${r2.branch}:two.txt`), '2\n');
    const told = modelCalls[0].messages.map((m) => m.content).join('\n');
    assert.match(told, /Your earlier tasks[\s\S]*Add one\.txt[\s\S]*Wrote one\.txt\./);
    assert.equal(git(repo, 'status', '--porcelain').trim(), '');

    const view = (await call('GET', `/agents/${agent.id}`)).body;
    assert.deepEqual([view.taskCount, view.tasks.map((t) => t.goal)], [2, ['Add two.txt', 'Add one.txt']]);
});

test('an agent works one task at a time, in the order given', async () => {
    const agent = manager.listAgents()[0];
    const order = [];
    script = [writes('a1.txt', 'x'), { calls: [['finish', { summary: 'first' }]] }, writes('a2.txt', 'x'), { calls: [['finish', { summary: 'second' }]] }];
    const a = manager.assign(agent.id, { goal: 'first task' });
    const b = manager.assign(agent.id, { goal: 'second task' });
    assert.equal(manager.get(b.id).status, 'queued');
    const rb = await settle(b.id);
    const ra = manager.get(a.id);
    assert.ok(ra.ended <= rb.started, `first ended ${ra.ended}, second started ${rb.started}`);
    assert.equal(rb.base, ra.result.commit);
    order.push(ra.result.summary, rb.result.summary);
    assert.deepEqual(order, ['first', 'second']);
});

test('a task can pick another workflow than its agent; Swarm and ChatDev are refused', async () => {
    const agent = manager.listAgents()[0];
    script = [{ calls: [['finish', { summary: 'Answered.' }]] }];
    const picked = manager.assign(agent.id, { goal: 'just answer', workflow: 'one-shot' });
    assert.equal(picked.workflow, 'one-shot');
    assert.equal((await settle(picked.id)).workflow, 'one-shot');
    assert.equal(manager.assign(agent.id, { goal: 'keeps its own', workflow: 'agent' }).workflow, agent.workflow);
    assert.throws(() => manager.assign(agent.id, { goal: 'x', workflow: 'swarm' }), /one workflow/);
    assert.throws(() => manager.assign(agent.id, { goal: 'x', workflow: 'nope' }), /no workflow named nope/);
});

test('work the repo has already taken in is not carried again, and a plan task leaves the head alone', async () => {
    const agent = manager.listAgents()[0];
    const head = manager.agents.get(agent.id).head;
    script = [{ calls: [['finish', { summary: 'A plan.' }]] }];
    const plan = await settle(manager.assign(agent.id, { goal: 'plan something', plan: true }).id);
    assert.equal(plan.plan, true);
    assert.equal(manager.agents.get(agent.id).head, head);
    // merge the agent's branch into the repo: the next task starts from the repo's own commit
    git(repo, 'merge', '-q', '--ff-only', manager.agents.get(agent.id).branch);
    script = [{ calls: [['finish', { summary: 'Nothing to do.' }]] }];
    const next = await settle(manager.assign(agent.id, { goal: 'check things' }).id);
    assert.equal(next.base, git(repo, 'rev-parse', 'HEAD').trim());
    assert.ok(next.events.some((e) => /already in the repo/.test(e.text || '')));
});

test('deleting an agent keeps its tasks as ordinary runs', async () => {
    const agent = manager.listAgents()[0];
    assert.equal((await call('DELETE', `/agents/${agent.id}`)).status, 200);
    assert.equal((await call('GET', `/agents/${agent.id}`)).status, 404);
    assert.ok(manager.list().length >= 4);
    assert.ok(manager.list().every((r) => r.agent === null));
    assert.equal((await call('POST', `/agents/${agent.id}/tasks`, { goal: 'x' })).status, 404);
});

test('an agent can name other repos beside its own; the first is the one it works in', async () => {
    const made = await call('POST', '/agents', { name: 'Two repos', repo, moreRepos: ['skyfly200/docs', 'skyfly200/docs', ' ', '/home/me/other'] });
    assert.equal(made.status, 201);
    assert.deepEqual(made.body.moreRepos, ['skyfly200/docs', '/home/me/other']);
    assert.deepEqual(made.body.repos, [repo, 'skyfly200/docs', '/home/me/other']);
    assert.equal((await call('PATCH', `/agents/${made.body.id}`, { moreRepos: 'nope' })).status, 400);
    // an agent made before this existed has none
    assert.deepEqual((await call('POST', '/agents', { name: 'One repo', repo })).body.repos, [repo]);

    script = [{ calls: [['finish', { summary: 'Looked.' }]] }];
    modelCalls = [];
    const task = (await call('POST', `/agents/${made.body.id}/tasks`, { goal: 'Check the docs link' })).body;
    assert.deepEqual(task.moreRepos, ['skyfly200/docs', '/home/me/other']);
    const done = await settle(task.id);
    assert.equal(done.status, 'done', done.error);
    // the agent is told about them, and that only the first is checked out
    const told = modelCalls[0].messages.map((m) => m.content).join('\n');
    assert.match(told, /Other repositories the user has connected: skyfly200\/docs, \/home\/me\/other\. They are not checked out/);
    assert.equal(done.repo, repo);

    const cleared = await call('PATCH', `/agents/${made.body.id}`, { moreRepos: [] });
    assert.deepEqual(cleared.body.repos, [repo]);
    // a one-off run can name them too
    script = [{ calls: [['finish', { summary: 'ok' }]] }];
    modelCalls = [];
    const run = (await call('POST', '/runs', { goal: 'Look', repo, moreRepos: ['a/b'] })).body;
    await settle(run.id);
    assert.match(modelCalls[0].messages.map((m) => m.content).join('\n'), /connected: a\/b\./);
});

test('a task can set its own routing; one model directly replaces the agent\'s routing', async () => {
    const agent = manager.listAgents()[0];
    manager.agents.update(agent.id, { profile: 'cheap', effort: 'low', maxTier: 'Mid' });
    script = [{ calls: [['finish', { summary: 'a' }]] }, { calls: [['finish', { summary: 'b' }]] }, { calls: [['finish', { summary: 'c' }]] }];
    const plain = manager.get(manager.assign(agent.id, { goal: 'plain', plan: true }).id);
    assert.deepEqual([plain.profile, plain.model, plain.effort, plain.maxTier], ['cheap', null, 'low', 'Mid']);
    const pinned = manager.get(manager.assign(agent.id, { goal: 'pinned', plan: true, model: 'gpt-x', effort: 'high' }).id);
    assert.deepEqual([pinned.profile, pinned.model, pinned.effort, pinned.maxTier], [null, 'gpt-x', 'high', 'Mid']);
    const routed = manager.get(manager.assign(agent.id, { goal: 'routed', plan: true, profile: 'strong' }).id);
    assert.deepEqual([routed.profile, routed.model], ['strong', null]);
    for (const r of [plain, pinned, routed]) await settle(r.id);
    manager.agents.update(agent.id, { model: 'agent-model' });
    assert.equal(manager.agents.get(agent.id).model, 'agent-model');
    manager.agents.update(agent.id, { model: '', profile: null, effort: null, maxTier: null });
});
