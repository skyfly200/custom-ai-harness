const test = require('node:test');
const assert = require('node:assert/strict');
const { SONNET, OPUS, HAIKU, ASSUMED, multiplier, rowCost, priceRows, savings, usd, modelLayer } = require('../ui/costs');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('cached input costs the cache price, not the full input price', () => {
    const claude = { inputCost: 2e-6, outputCost: 1e-5, cacheReadCost: 2e-7, cacheWriteCost: 2.5e-6, upstream: 'anthropic/claude-sonnet-5-5' };
    // 100k input of which 90k read from cache and 5k written, 1k output
    const c = rowCost({ input: 100000, cacheRead: 90000, cacheWrite: 5000, output: 1000 }, claude);
    close(c.cost, 5000 * 2e-6 + 90000 * 2e-7 + 5000 * 2.5e-6 + 1000 * 1e-5);
    close(c.listCost, 100000 * 2e-6 + 1000 * 1e-5);
    // without cache prices in the list: a tenth for Claude, half for others
    close(rowCost({ input: 1000, cacheRead: 1000, output: 0 }, { inputCost: 1e-6, upstream: 'openrouter/anthropic/claude-x' }).cost, 1000 * 1e-7);
    close(rowCost({ input: 1000, cacheRead: 1000, output: 0 }, { inputCost: 1e-6, upstream: 'openrouter/openai/gpt-4o-mini' }).cost, 1000 * 5e-7);
    assert.deepEqual(rowCost({ input: 5, output: 5 }, { free: true, inputCost: 0 }), { cost: 0, listCost: 0, free: true, unpriced: false });
    assert.equal(rowCost({ input: 5, output: 5 }, { inputCost: null }).unpriced, true);
    assert.equal(rowCost({ input: 5, output: 5 }, undefined).unpriced, true);
});

test('savings split the Sonnet price into compression, model choice and caching', () => {
    const prices = {
        free: { free: true, inputCost: 0, outputCost: 0 },
        mini: { inputCost: 1.5e-7, outputCost: 6e-7, cacheReadCost: 7.5e-8, upstream: 'openrouter/openai/gpt-4o-mini' },
        opus: { inputCost: 4e-6, outputCost: 2e-5, upstream: 'anthropic/claude-opus-5-5' },
    };
    const rows = priceRows([
        { route: 'Router', model: 'free', servedBy: 'free', requests: 3, input: 30000, output: 3000, cacheRead: 0, cacheWrite: 0, savedHeadroom: 2000, savedAnchor: 1000 },
        { route: 'Router', model: 'opus', servedBy: 'mini', requests: 2, input: 20000, output: 1000, cacheRead: 10000, cacheWrite: 0 },
        { route: 'Pinned', model: 'opus', servedBy: 'opus', requests: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
        { route: 'Router', model: 'x', servedBy: 'x', requests: 4, input: 999, output: 9, cacheRead: 0, cacheWrite: 0 },
    ], prices);
    const s = savings(rows);
    assert.equal(s.unpriced, 4);
    assert.equal(s.requests, 6);
    const sonnet = (i, o) => i * SONNET.inputCost + o * SONNET.outputCost;
    close(s.baseline, sonnet(30000 + 3000, 3000) + sonnet(20000, 1000) + sonnet(1000, 100));
    const by = Object.fromEntries(s.layers.map(l => [l.id, l]));
    close(by.compression.saved, 3000 * SONNET.inputCost);
    assert.equal(by.compression.tokens, 3000);
    close(by.router.saved, sonnet(30000, 3000));
    assert.equal(by.router.tokens, 33000); // on a free model
    close(by.fallback.saved, sonnet(20000, 1000) - (20000 * 1.5e-7 + 1000 * 6e-7));
    assert.ok(by.pinned.saved < 0, 'Opus costs more than Sonnet');
    close(by.caching.saved, 10000 * (1.5e-7 - 7.5e-8));
    // the layers add up to the difference
    close(s.layers.reduce((sum, l) => sum + l.saved, 0), s.saved);
    close(s.saved, s.baseline - s.actual);
    assert.ok(s.baselineCached < s.baseline);
});

const sample = () => priceRows([
    { route: 'Router', model: 'free', servedBy: 'free', requests: 3, input: 30000, output: 3000, cacheRead: 0, cacheWrite: 0, savedHeadroom: 2000, savedAnchor: 1000 },
    { route: 'Router', model: 'opus', servedBy: 'mini', requests: 2, input: 20000, output: 1000, cacheRead: 10000, cacheWrite: 0 },
    { route: 'Pinned', model: 'haiku', servedBy: 'haiku', requests: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
], {
    free: { free: true, inputCost: 0, outputCost: 0 },
    mini: { inputCost: 1.5e-7, outputCost: 6e-7, cacheReadCost: 7.5e-8, upstream: 'openrouter/openai/gpt-4o-mini' },
    haiku: { inputCost: 1e-7, outputCost: 5e-7, upstream: 'anthropic/claude-haiku-5-5' },
});

test('every baseline\'s layers add up, with or without token assumptions', () => {
    for (const base of [OPUS, SONNET, HAIKU]) for (const a of [undefined, ASSUMED, { ...ASSUMED, perModel: { mini: 2 } }]) {
        const s = savings(sample(), base, a);
        close(s.layers.reduce((sum, l) => sum + l.saved, 0), s.saved);
        close(s.groups.reduce((sum, g) => sum + g.saved, 0), s.saved);
        close(s.saved, s.baseline - s.actual);
    }
});

test('baselines are priced at their own list prices', () => {
    const rows = [{ requests: 1, input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0, cost: 0, listCost: 0, unpriced: 0 }];
    close(savings(rows, OPUS).baseline, 4 + 20);
    close(savings(rows, SONNET).baseline, 2 + 10);
    close(savings(rows, HAIKU).baseline, 0.1 + 0.5);
});

test('a model that needs more tokens makes the baseline cheaper, so the savings shrink', () => {
    const rows = priceRows([{ route: 'Router', model: 'mini', servedBy: 'mini', requests: 1, input: 100000, output: 10000, cacheRead: 0, cacheWrite: 0 }],
        { mini: { inputCost: 1.5e-7, outputCost: 6e-7, upstream: 'openrouter/openai/gpt-4o-mini' } });
    const plain = savings(rows, SONNET), modeled = savings(rows, SONNET, { ...ASSUMED, other: 1.5 });
    close(plain.baseline, 100000 * 2e-6 + 10000 * 1e-5);
    close(modeled.baseline, plain.baseline / 1.5);
    const tokens = modeled.layers.find(l => l.id === 'tokens');
    close(tokens.saved, plain.baseline * (1 / 1.5 - 1));
    assert.ok(tokens.saved < 0 && tokens.basis === 'assumed');
    assert.ok(modeled.saved < plain.saved);
    close(modeled.layers.find(l => l.id === 'router').saved, plain.layers.find(l => l.id === 'router').saved);
    assert.equal(plain.layers.find(l => l.id === 'tokens').saved, 0);
});

test('multipliers follow the model name, free flag and overrides', () => {
    assert.equal(multiplier('or-claude-opus-5.5', ASSUMED), ASSUMED.opus);
    assert.equal(multiplier('claude-haiku-5-5', ASSUMED), ASSUMED.haiku);
    assert.equal(multiplier('fast-groq', ASSUMED), ASSUMED.other);
    assert.equal(multiplier('local-engine', ASSUMED, true), ASSUMED.free);
    assert.equal(multiplier('fast-groq', { ...ASSUMED, perModel: { 'fast-groq': 2 } }), 2);
});

test('model layers follow how the model was picked', () => {
    assert.equal(modelLayer({ route: 'Router', model: 'a', servedBy: 'b' }), 'fallback');
    assert.equal(modelLayer({ route: 'Router', model: 'a', servedBy: 'a' }), 'router');
    assert.equal(modelLayer({ route: 'Router down', model: 'a', servedBy: 'a' }), 'down');
    assert.equal(modelLayer({ route: 'Chosen by client', model: 'a', servedBy: 'a' }), 'pinned');
});

test('small costs keep their digits', () => {
    assert.equal(usd(0), '$0');
    assert.equal(usd(0.000012), '$0.000012');
    assert.equal(usd(0.0034), '$0.0034');
    assert.equal(usd(0.25), '$0.25');
    assert.equal(usd(1234.4), '$1,234');
    assert.equal(usd(-0.5), '−$0.50');
});
