const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../utils/efficiency');
const { runAgent } = require('../runner/agent');

const sig = (name, args = '{}') => `${name}:${args}`;

test('a repeated identical result is not progress; a new or changed one is', () => {
    const w = E.createWatch();
    E.observeCall(w, sig('read_file', '{"path":"a"}'), 'hello');
    assert.equal(w.progress, true);
    w.progress = false;
    E.observeCall(w, sig('read_file', '{"path":"a"}'), 'hello');
    assert.equal(w.progress, false, 'same call, same result');
    E.observeCall(w, sig('run_command', '{"command":"npm test"}'), 'Error: 2 failing');
    assert.equal(w.progress, false, 'an error is not progress');
    E.observeCall(w, sig('run_command', '{"command":"npm test"}'), 'all 12 passing');
    assert.equal(w.progress, true, 'a re-run that now differs is progress');
});

test('three identical calls in the recent window give a hint at once', () => {
    const w = E.createWatch();
    for (let i = 0; i < 3; i++) E.observeCall(w, sig('grep', '{"q":"x"}'), `hit ${i % 2}`);
    const hint = E.checkStep(w);
    assert.equal(hint.level, 'hint');
    assert.match(hint.text, /grep/);
    assert.match(hint.text, /3 times/);
});

test('a stall of four steps gives a hint, then, if still stuck, an escalation', () => {
    const w = E.createWatch();
    const levels = [];
    for (let step = 0; step < 8; step++) {
        const h = E.checkStep(w); // no progress in any of these steps
        if (h) levels.push(h.level);
    }
    assert.deepEqual(levels, ['hint', 'escalate']);
});

test('a step that makes progress resets the stall count', () => {
    const w = E.createWatch();
    for (let step = 0; step < 3; step++) assert.equal(E.checkStep(w), null);
    E.observeCall(w, sig('write_file', '{"path":"x"}'), 'wrote x');
    assert.equal(E.checkStep(w), null);
    for (let step = 0; step < 3; step++) assert.equal(E.checkStep(w), null, 'still under the limit after the reset');
    assert.equal(E.checkStep(w).level, 'hint');
});

test('tally counts productive and wasted steps and the cost of the wasted ones', () => {
    const t = E.emptyTally();
    const feed = [
        { type: 'step' },
        { type: 'model', usage: { prompt_tokens: 100, completion_tokens: 10 }, cost: 0.02 },
        { type: 'step-end', progress: true },
        { type: 'step' },
        { type: 'model', usage: { prompt_tokens: 200, completion_tokens: 20 }, cost: 0.05 },
        { type: 'step-end', progress: false },
        { type: 'loop', level: 'hint' },
        { type: 'loop', level: 'escalate' },
    ];
    feed.forEach(e => E.tally(t, e));
    assert.equal(t.steps, 2);
    assert.equal(t.productive, 1);
    assert.equal(t.wasted, 1);
    assert.equal(t.wastedCost, 0.05);
    assert.equal(t.wastedTokens, 220);
    assert.equal(t.loops, 1);
    assert.equal(t.escalations, 1);
});

test('byModel groups runs by their main model and divides spend by successes', () => {
    const runs = [
        { status: 'done', cost: 0.1, models: { 'weak-x': { calls: 5 } }, efficiency: { steps: 5, productive: 5, wastedCost: 0 } },
        { status: 'incomplete', cost: 0.3, models: { 'weak-x': { calls: 9 } }, efficiency: { steps: 9, productive: 3, wastedCost: 0.2, loops: 1 } },
        { status: 'done', cost: 0.2, models: { 'strong-y': { calls: 2 }, 'weak-x': { calls: 1 } }, efficiency: { steps: 2, productive: 2, wastedCost: 0, escalations: 1 } },
    ];
    const rows = E.byModel(runs);
    // run 3 made most of its calls on strong-y, so it counts there
    const weak = rows.find(r => r.model === 'weak-x');
    const strong = rows.find(r => r.model === 'strong-y');
    assert.equal(weak.runs, 2);
    assert.equal(weak.done, 1);
    assert.equal(weak.costPerSuccess, 0.4, 'all spend on the row over its successes');
    assert.equal(weak.loopRuns, 1);
    assert.equal(weak.escalatedRuns, 0);
    assert.equal(strong.runs, 1);
    assert.equal(strong.costPerSuccess, 0.2);
    assert.equal(strong.escalatedRuns, 1);
    assert.equal(strong.escalatedDone, 1);
});

test('the agent loop hints, then escalates, when a model keeps repeating itself', async () => {
    const events = [];
    const escalatedAt = [];
    let lastHistoryHints = 0;
    const result = await runAgent({
        run: {
            goal: 'test', maxSteps: 14, softSteps: 0, deadline: Date.now() + 10000, stopped: () => false,
            onLoop: (hint) => escalatedAt.push(hint.level),
        },
        tools: {
            definitions: [],
            async call() { return { text: 'no match' }; },
        },
        emit: (e) => events.push(e),
        async chat(messages) {
            // the model never changes its call, whatever it was told
            lastHistoryHints = messages.filter(m => m.role === 'user' && /Stop and check|Still going round/.test(m.content)).length;
            return { message: { tool_calls: [{ id: `c${events.length}`, type: 'function', function: { name: 'grep', arguments: '{"q":"same"}' } }] }, usage: { prompt_tokens: 50, completion_tokens: 5 }, model: 'weak-x' };
        },
    });
    assert.equal(result.status, 'out_of_steps');
    const loops = events.filter(e => e.type === 'loop').map(e => e.level);
    assert.equal(loops[0], 'hint');
    assert.ok(loops.includes('escalate'));
    assert.deepEqual(escalatedAt.slice(0, 1), ['escalate'], 'onLoop asked for more effort after the hint');
    assert.ok(events.some(e => e.type === 'step-end' && e.progress === false));
    assert.ok(lastHistoryHints >= 1, 'the hints were in the model history it was sent');
});

function run(model, { status = 'done', steps = 4, productive = 3, cost = 0.1, tokens = 1000, goal = 'fix the bug', repo = 'x/y' } = {}) {
    return {
        goal, repo, status, cost, tokens: { in: tokens - 100, out: 100 }, models: { [model]: { calls: steps } },
        efficiency: { steps, productive, wasted: steps - productive, wastedCost: 0, loops: 0, escalations: 0 },
        created: '2026-11-03T00:00:00Z',
    };
}

test('compareRuns: both finished, the cheaper one wins and the gap splits into steps and cost per step', () => {
    const cheap = run('weak-x', { steps: 4, productive: 4, cost: 0.1 });
    const dear = run('strong-y', { steps: 6, productive: 5, cost: 0.3 });
    const c = E.compareRuns(cheap, dear);
    assert.equal(c.sameTask, true);
    assert.match(c.verdict, /weak-x cost \$0\.1000, 67% less than strong-y/);
    const cost = c.rows.find(r => r.key === 'cost');
    assert.equal(cost.winner, 'a');
    const steps = c.rows.find(r => r.key === 'steps');
    assert.equal(steps.winner, 'a');
    // costGap = fromSteps + fromCostPerStep, exactly
    assert.ok(Math.abs(c.split.costGap - (c.split.fromSteps + c.split.fromCostPerStep)) < 1e-6);
    assert.equal(c.split.costGap, -0.2);
});

test('compareRuns: one finished and one did not', () => {
    const c = E.compareRuns(run('weak-x', { status: 'incomplete' }), run('strong-y'));
    assert.match(c.verdict, /strong-y finished; weak-x ended as incomplete/);
    assert.equal(c.rows.find(r => r.key === 'done').winner, 'b');
});

test('compareRuns: different goals are flagged as not like for like', () => {
    const c = E.compareRuns(run('weak-x'), run('strong-y', { goal: 'something else' }));
    assert.equal(c.sameTask, false);
    assert.match(c.verdict, /not like for like/);
});

test('compareRuns: equal numbers have no winner', () => {
    const c = E.compareRuns(run('weak-x'), run('strong-y'));
    assert.equal(c.rows.find(r => r.key === 'cost').winner, null);
});
