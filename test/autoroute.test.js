const test = require('node:test');
const assert = require('node:assert');
const { autoRoute, preset, describe: describeStrategy, PRESETS } = require('../ui/autoroute');

const m = (quality, blended, strengths = ['tools']) => ({ quality, blended, strengths });
const stats = {
    big: m(90, 10), good: m(75, 3), mid: m(60, 1), cheap: m(40, 0.1), free: m(30, 0, []),
    noscore: { quality: null, blended: 1, strengths: [] },
};

test('best rated is Strong, cheapest of the rest is Weak', () => {
    const plan = autoRoute(['big', 'good', 'cheap'], stats, {});
    assert.equal(plan.routes.strong, 'big');
    assert.equal(plan.routes.weak, 'cheap');
    assert.deepEqual(plan.tiers, []);
    assert.equal(plan.routes.down, 'big');
    assert.equal(plan.routes.downTools, 'big');
});

test('a Mid tier needs four rated models, Frontier five, and each sits on the right side of the threshold', () => {
    const four = autoRoute(['big', 'good', 'mid', 'cheap'], stats, { threshold: 0.5 });
    assert.deepEqual(four.tiers.map(t => [t.name, t.model, t.from]), [['Mid', 'good', 0.3]]);
    assert.equal(four.routes.strong, 'big');
    assert.equal(four.routes.weak, 'cheap');
    const five = autoRoute(['big', 'good', 'mid', 'cheap', 'free'], stats, { threshold: 0.5 });
    assert.equal(five.routes.strong, 'good');
    assert.deepEqual(five.tiers.map(t => t.name), ['Frontier', 'Mid']);
    assert.ok(five.tiers[0].from > 0.5 && five.tiers[1].from < 0.5);
    assert.equal(five.routes.weak, 'free');
});

test('unrated models are skipped and listed, never placed', () => {
    const plan = autoRoute(['big', 'noscore', 'cheap'], stats, {});
    assert.deepEqual(plan.skipped, ['noscore']);
    assert.ok(!Object.values(plan.routes).includes('noscore'));
    assert.equal(autoRoute(['noscore'], stats, {}), null);
});

test('tools outputs get a model that takes tools when the main one does not', () => {
    const plan = autoRoute(['big', 'good', 'free'], { ...stats, big: m(90, 10, []) }, {});
    assert.equal(plan.routes.strong, 'big');
    assert.equal(plan.routes.strongTools, 'good');
    assert.equal(plan.routes.weak, 'free');
    assert.equal(plan.routes.tools, 'good');
    // with no tool tags anywhere nothing is ruled out
    const none = autoRoute(['big', 'cheap'], { big: m(90, 10, []), cheap: m(40, 1, []) }, {});
    assert.equal(none.routes.strongTools, null);
    assert.equal(none.notes.length, 1);
});

test('keeps served Router-down and image models, picks an image model otherwise', () => {
    const s = { ...stats, good: m(75, 3, ['tools', 'images']) };
    const kept = autoRoute(['big', 'good', 'cheap'], s, { down: 'cheap', downTools: 'good', images: 'big' });
    assert.equal(kept.routes.down, 'cheap');
    assert.equal(kept.routes.downTools, 'good');
    assert.equal(kept.routes.images, undefined);
    const stale = autoRoute(['big', 'good', 'cheap'], s, { down: 'gone', images: 'gone' });
    assert.equal(stale.routes.down, 'big');
    assert.equal(stale.routes.images, 'good');
});

test('fallbacks are added only where a model has none, and never point at itself', () => {
    const plan = autoRoute(['big', 'good', 'cheap'], stats, {}, { big: ['cheap'] });
    assert.ok(!('big' in plan.fallbacks));
    assert.deepEqual(plan.fallbacks.cheap, ['good']);
    for (const [src, to] of Object.entries(plan.fallbacks)) assert.ok(!to.includes(src));
    // one model: nothing to fall back to
    assert.deepEqual(autoRoute(['big'], stats, {}).fallbacks, {});
});

test('the result has every required output filled', () => {
    for (const names of [['big'], ['big', 'cheap'], ['big', 'good', 'mid', 'cheap', 'free']]) {
        const { routes } = autoRoute(names, stats, {});
        for (const k of ['strong', 'weak', 'down', 'downTools']) assert.ok(names.includes(routes[k]), `${k} for ${names}`);
    }
});

test('presets: each starts with its own wiring', () => {
    const served = ['big', 'good', 'mid', 'cheap'];
    const plans = Object.fromEntries(PRESETS.map(p => [p.id, preset(p.id, served, stats, {})]));
    assert.equal(plans.best.routes.strong, 'big');
    assert.equal(plans.best.routes.weak, 'big');
    assert.equal(plans.cheapest.routes.strong, 'cheap');
    assert.equal(plans.cheapest.routes.weak, 'cheap');
    assert.equal(plans.balanced.routes.strong, 'big');
    assert.notEqual(plans.balanced.routes.weak, 'big');
    assert.notEqual(plans.fast.routes.strong, 'big');
    assert.equal(plans.fast.routes.threshold, 0.8);
    assert.equal(plans.local, null);
    const seen = new Set(['best', 'cheapest', 'balanced', 'fast'].map(k => JSON.stringify([plans[k].routes, plans[k].tiers])));
    assert.equal(seen.size, 4);
});

test('presets: local only uses local models', () => {
    const plan = preset('local', ['big', 'local-engine'], { ...stats, 'local-engine': m(20, 0) }, {});
    assert.equal(plan.routes.strong, 'local-engine');
    assert.equal(plan.routes.weak, 'local-engine');
});

test('describe: one line per strategy', () => {
    assert.equal(describeStrategy({ strong: 'a', weak: 'a' }), 'a for everything');
    assert.equal(describeStrategy({ strong: 'a', weak: 'b', threshold: 0.8 }), 'a ↔ b at 0.8');
    assert.equal(describeStrategy({ pin: 'x' }), 'pinned to x');
});
