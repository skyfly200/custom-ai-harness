const test = require('node:test');
const assert = require('node:assert/strict');
const { board, stateOf } = require('../ui/agentBoard');

const run = (o) => ({ id: 'r', goal: 'g', status: 'done', tokens: { in: 10, out: 5 }, ...o });

test('an agent that waits for a decision shows as waiting, a busy one as working', () => {
    assert.equal(stateOf({ active: 1, waiting: true, lastTask: { status: 'waiting' } }), 'waiting');
    assert.equal(stateOf({ active: 1, lastTask: { status: 'running' } }), 'working');
    assert.equal(stateOf({ active: 1, lastTask: { status: 'queued' } }), 'queued');
    assert.equal(stateOf({ active: 0, lastTask: { status: 'done' } }), 'idle');
});

test('approvals come from every run that is waiting, workers included', () => {
    const b = board([
        run({ id: 'a', status: 'waiting', pending: { text: 'rm x' }, agent: 'ag' }),
        run({ id: 'w', status: 'waiting', pending: { text: 'ls' }, parent: 's' }),
        run({ id: 'n', status: 'waiting', pending: null }),
    ], [{ id: 'ag', name: 'Docs' }]);
    assert.deepEqual(b.needs.map((r) => r.id), ['a', 'w']);
    assert.equal(b.needs[0].agentName, 'Docs');
});

test('tokens and outcomes are added up per agent, and swarm workers are not listed on their own', () => {
    const runs = [
        run({ id: '1', agent: 'ag' }),
        run({ id: '2', agent: 'ag', status: 'failed' }),
        run({ id: '3', agent: 'ag', status: 'running' }),
        run({ id: 'p', kind: 'swarm', status: 'running' }),
        run({ id: 'c', parent: 'p', status: 'running' }),
    ];
    const b = board(runs, [{ id: 'ag', name: 'A', active: 1, lastTask: runs[2] }]);
    assert.deepEqual([b.agents[0].tokens, b.agents[0].done, b.agents[0].failed, b.agents[0].state], [45, 1, 1, 'working']);
    assert.deepEqual(b.active.map((r) => r.id), ['3', 'p']);
    assert.deepEqual(b.recent.map((r) => r.id), ['1', '2']);
    assert.equal(b.totals.tokens, 75);
});

test('recent is capped', () => {
    const runs = Array.from({ length: 10 }, (_, i) => run({ id: String(i) }));
    assert.equal(board(runs, [], { recent: 4 }).recent.length, 4);
});
