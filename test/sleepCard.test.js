const test = require('node:test');
const assert = require('node:assert/strict');
const card = require('../ui/sleepcard.js');

const MIN = 60 * 1000;
const base = { canStop: true, sleepsAfterMin: 30, totalMs: 30 * MIN, stopsInMs: 15 * MIN, extraMs: 0, maxExtraMs: 4 * 60 * MIN, canExtend: true, busy: false, stopping: false };

test('the ring shows the share of the countdown left, and the time reads in words', () => {
    const v = card.view(base);
    assert.equal(v.kind, 'counting');
    assert.equal(v.frac, 0.5);
    assert.equal(v.note, 'Sleeps in 15 min.');
    assert.equal(card.view(base, 10 * MIN).note, 'Sleeps in 5 min.');
    assert.equal(card.fmt(65 * MIN), '1 h 05 min');
    assert.equal(card.fmt(30 * 1000), 'under a minute');
    assert.equal(card.fmt(2 * 60 * MIN), '2 h');
});

test('a running job shows as busy with a full ring, and no countdown', () => {
    const v = card.view({ ...base, busy: true, stopsInMs: null });
    assert.equal(v.kind, 'busy');
    assert.equal(v.frac, 1);
    assert.match(v.note, /clock starts again/);
});

test('a server that does not sleep by itself stays on, with nothing to extend', () => {
    const v = card.view({ ...base, sleepsAfterMin: 0, stopsInMs: null, totalMs: 0, canExtend: false });
    assert.equal(v.kind, 'on');
    assert.equal(v.canExtend, false);
});

test('no card without a way to stop, and extend stops offering once the cap is reached', () => {
    assert.equal(card.view({ ...base, canStop: false }), null);
    const capped = card.view({ ...base, extraMs: 4 * 60 * MIN, maxExtraMs: 4 * 60 * MIN });
    assert.equal(capped.canExtend, false);
});

test('the dash offset empties the ring as the time runs out', () => {
    assert.equal(card.dashOffset(1), 0);
    assert.equal(card.dashOffset(0), card.RING);
    assert.ok(Math.abs(card.dashOffset(0.5) - card.RING / 2) < 1e-9);
});
