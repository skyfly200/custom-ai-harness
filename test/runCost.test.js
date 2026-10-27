const test = require('node:test');
const assert = require('node:assert/strict');
const { callCost, createPricer } = require('../utils/runCost');

const prices = { cheap: { inputCost: 1e-6, outputCost: 2e-6 }, free: { free: true } };

test('a call is priced from the model list', () => {
    const c = callCost({ prompt_tokens: 1000, completion_tokens: 100 }, 'cheap', prices);
    assert.ok(Math.abs(c.cost - 0.0012) < 1e-12);
    assert.equal(c.unpriced, false);
});

test('free models cost nothing, unknown ones are counted as unpriced', () => {
    assert.deepEqual(callCost({ prompt_tokens: 50, completion_tokens: 5 }, 'free', prices), { cost: 0, unpriced: false });
    assert.deepEqual(callCost({ prompt_tokens: 50, completion_tokens: 5 }, 'mystery', prices), { cost: 0, unpriced: true });
    assert.deepEqual(callCost({ prompt_tokens: 50, completion_tokens: 5 }, 'cheap', null), { cost: 0, unpriced: true });
});

test('a cost the provider reported wins', () => {
    assert.equal(callCost({ prompt_tokens: 1000, completion_tokens: 100, cost: 0.5 }, 'cheap', prices).cost, 0.5);
});

test('the pricer loads prices once, and survives the Interceptor being down', async () => {
    let calls = 0;
    const good = createPricer({ url: 'http://x', fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ models: prices }) }; } });
    await good.refresh(); await good.refresh();
    assert.equal(calls, 1);
    assert.ok(good.cost({ prompt_tokens: 1000, completion_tokens: 0 }, 'cheap').cost > 0);
    const down = createPricer({ url: 'http://x', fetchImpl: async () => { throw new Error('refused'); } });
    await down.refresh();
    assert.equal(down.cost({ prompt_tokens: 10, completion_tokens: 1 }, 'cheap').unpriced, true);
});
