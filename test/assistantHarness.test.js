// The assistant's harness tools: routing, agents and apps. Reads run at once; changes wait for /yes.
const test = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../utils/assistant');
const { createHarnessTools, combine } = require('../utils/assistantHarness');
const skillStore = require('../utils/skillStore');

// A stand-in for utils/profiles.js: the same list/replace shape, kept in memory.
function fakeProfiles(initial = []) {
    let list = initial.map((p) => ({ ...p }));
    return {
        list: () => list.map((p) => ({ ...p })),
        replace(next) {
            if (next.some((p) => !p.name)) throw new Error('Every strategy needs a name');
            list = next.map((p) => ({ ...p, id: p.id || p.name.toLowerCase().replace(/\W+/g, '-') }));
            return { profiles: list };
        },
    };
}

function fakeRunner(routes) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const path = url.replace('http://runner.test', '');
        calls.push({ method: opts.method || 'GET', path, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
        const handler = routes[`${opts.method || 'GET'} ${path}`];
        if (!handler) return new Response('nope', { status: 404 });
        const { status = 200, body = {} } = handler;
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
}

test('reads list routing strategies and agents without asking', async () => {
    const profiles = fakeProfiles([{ id: 'fast', name: 'Fast', description: 'Quick answers', threshold: 0.4 }]);
    const { calls, fetchImpl } = fakeRunner({ 'GET /agents': { body: { agents: [{ id: 'a1', name: 'Docs', repo: 'me/docs', instructions: 'x', owner: 'Skyler', head: 'abc' }] } } });
    const tools = createHarnessTools({ profiles, runnerUrl: () => 'http://runner.test', runnerToken: () => 'tok', fetchImpl });
    assert.equal(tools.needsApproval('list_routing_strategies'), false);
    const routing = JSON.parse((await tools.call('list_routing_strategies', {})).text);
    assert.deepEqual(routing, [{ id: 'fast', name: 'Fast', description: 'Quick answers', threshold: 0.4 }]);
    const agents = JSON.parse((await tools.call('list_agents', {}, { owner: 'Skyler' })).text);
    assert.deepEqual(agents, [{ id: 'a1', name: 'Docs', repo: 'me/docs', instructions: 'x' }]);
    assert.equal(calls[0].headers['x-runner-token'], 'tok');
    assert.equal(calls[0].headers['x-runner-owner'], 'Skyler');
});

test('every change needs approval, and a change without it is refused', async () => {
    const tools = createHarnessTools({ profiles: fakeProfiles(), fetchImpl: fakeRunner({}).fetchImpl });
    for (const name of ['save_routing_strategy', 'create_agent', 'update_agent', 'create_app', 'update_app', 'save_skill']) {
        assert.equal(tools.needsApproval(name), true, name);
        await assert.rejects(tools.call(name, { name: 'x', repo: 'a/b', id: 'x' }), /needs the person's approval/);
    }
    assert.equal(tools.needsApproval('list_skills'), false);
});

test('a routing strategy can be created, then changed by id', async () => {
    const profiles = fakeProfiles([{ id: 'fast', name: 'Fast', description: 'Quick', threshold: 0.4 }]);
    const tools = createHarnessTools({ profiles, fetchImpl: fakeRunner({}).fetchImpl });
    const created = JSON.parse((await tools.call('save_routing_strategy', { name: 'Careful code', description: 'Code reviews' }, { confirmed: true })).text);
    assert.equal(created.saved.name, 'Careful code');
    assert.equal(profiles.list().length, 2);
    await tools.call('save_routing_strategy', { id: 'fast', name: 'Fast', threshold: 0.7 }, { confirmed: true });
    assert.equal(profiles.list().find((p) => p.id === 'fast').threshold, 0.7);
    assert.equal(profiles.list().find((p) => p.id === 'fast').description, 'Quick');
    await assert.rejects(tools.call('save_routing_strategy', { id: 'nope', name: 'Nope' }, { confirmed: true }), /no strategy with id nope/);
});

test('creating an agent posts to the runner with the owner', async () => {
    const { calls, fetchImpl } = fakeRunner({ 'POST /agents': { status: 201, body: { id: 'a9', name: 'Docs' } } });
    const tools = createHarnessTools({ profiles: fakeProfiles(), runnerUrl: () => 'http://runner.test', fetchImpl });
    const out = JSON.parse((await tools.call('create_agent', { name: 'Docs', repo: 'me/docs', instructions: 'Keep the README current', evil: 1 }, { confirmed: true, owner: 'Skyler' })).text);
    assert.equal(out.id, 'a9');
    assert.deepEqual(calls[0].body, { name: 'Docs', repo: 'me/docs', instructions: 'Keep the README current' });
    assert.equal(calls[0].headers['x-runner-owner'], 'Skyler');
});

test('an app change goes to the runner as a PATCH, and a missing runner is explained', async () => {
    const { calls, fetchImpl } = fakeRunner({ 'PATCH /apps/p1': { body: { id: 'p1', editablePaths: ['ui/**'] } } });
    const tools = createHarnessTools({ profiles: fakeProfiles(), runnerUrl: () => 'http://runner.test', fetchImpl });
    await tools.call('update_app', { id: 'p1', editablePaths: ['ui/**'] }, { confirmed: true, owner: 'Skyler' });
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, { editablePaths: ['ui/**'] });

    const down = createHarnessTools({ profiles: fakeProfiles(), runnerUrl: () => 'http://127.0.0.1:1', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
    await assert.rejects(down.call('list_apps', {}), /not answering \(ECONNREFUSED\)/);
});

test('a skill is saved on the server after approval, and changed by name', async () => {
    const skills = skillStore.createSkillStore({ store: skillStore.memoryStore() });
    const tools = createHarnessTools({ profiles: fakeProfiles(), skills, fetchImpl: fakeRunner({}).fetchImpl });
    assert.equal(tools.needsApproval('save_skill'), true);
    await assert.rejects(tools.call('save_skill', { name: 'review-pr', instructions: 'x' }), /needs the person's approval/);
    const made = JSON.parse((await tools.call('save_skill', { name: 'review-pr', description: 'Review a PR', instructions: 'Check tests.' }, { confirmed: true })).text);
    assert.equal(made.updated, 'created');
    const again = JSON.parse((await tools.call('save_skill', { name: 'review-pr', instructions: 'Check tests and docs.' }, { confirmed: true })).text);
    assert.equal(again.updated, 'changed');
    assert.equal(skills.list().length, 1);
    assert.equal(skills.list()[0].body, 'Check tests and docs.');
    const listed = JSON.parse((await tools.call('list_skills', {})).text);
    assert.deepEqual(listed, [{ id: made.id, name: 'review-pr', description: 'Review a PR' }]);
});

test('the assistant asks before a harness change and applies it on /yes', async () => {
    const profiles = fakeProfiles();
    const harness = createHarnessTools({ profiles, fetchImpl: fakeRunner({}).fetchImpl });
    const manager = combine(null, harness);
    let step = 0;
    const ask = async () => {
        step += 1;
        if (step === 1) return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'save_routing_strategy', arguments: JSON.stringify({ name: 'Cheap drafts' }) } }] };
        return 'Done: I added the Cheap drafts strategy.';
    };
    const a = assistant.createAssistant({ store: assistant.memoryStore(), ask, owner: 'Skyler', tools: manager });
    const asked = await a.handle('web:Skyler', 'Make a cheap routing');
    assert.match(asked, /I need your approval to run save_routing_strategy/);
    assert.equal(profiles.list().length, 0, 'nothing changed before /yes');
    assert.equal(await a.handle('web:Skyler', '/yes'), 'Done: I added the Cheap drafts strategy.');
    assert.equal(profiles.list()[0].name, 'Cheap drafts');
});

test('combine sends MCP names to the MCP manager and reports its approvals', async () => {
    const mcp = { start: async () => {}, definitions: () => [{ type: 'function', function: { name: 'gmail_send' } }], needsApproval: (n) => n === 'gmail_send', call: async (n) => ({ text: `ran ${n}` }) };
    const manager = combine(mcp, createHarnessTools({ profiles: fakeProfiles(), fetchImpl: fakeRunner({}).fetchImpl }));
    assert.ok(manager.definitions().some((d) => d.function.name === 'list_apps'));
    assert.ok(manager.definitions().some((d) => d.function.name === 'gmail_send'));
    assert.equal(manager.needsApproval('gmail_send'), true);
    assert.equal(manager.needsApproval('list_apps'), false);
    assert.deepEqual(await manager.call('gmail_send', {}, { confirmed: true }), { text: 'ran gmail_send' });
});
