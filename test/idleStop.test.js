const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { create, counts } = require('../utils/idleStop');

const req = (method, path) => ({ method, path });
const clock = (start = 1000000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const MIN = 60 * 1000;

test('what counts as use: pages, API calls and changes, not polling or the live feed', () => {
    assert.equal(counts(req('POST', '/ui/api/sync/chats/x/delta')), true);
    assert.equal(counts(req('POST', '/v1/messages')), true);
    assert.equal(counts(req('GET', '/v1/models')), true);
    assert.equal(counts(req('GET', '/ui/chat.html')), true);
    assert.equal(counts(req('GET', '/chat')), true);
    assert.equal(counts(req('GET', '/ui/routing')), true);
    assert.equal(counts(req('GET', '/ui/')), true);
    assert.equal(counts(req('GET', '/ui/api/status')), false);
    assert.equal(counts(req('GET', '/ui/api/live')), false);
    assert.equal(counts(req('GET', '/healthz')), false);
    assert.equal(counts(req('GET', '/ui/chat.js')), false);
});

test('stops after the idle time, and not before', () => {
    const c = clock(); let stopped = null;
    const idle = create({ minutes: 30, stop: (why) => { stopped = why; }, now: c.now });
    c.advance(29 * MIN); idle.check();
    assert.equal(stopped, null);
    c.advance(2 * MIN); idle.check();
    assert.match(stopped, /idle for 31 minutes/);
});

test('use resets the clock, polling does not', () => {
    const c = clock(); let stopped = false;
    const idle = create({ minutes: 30, stop: () => { stopped = true; }, now: c.now });
    c.advance(25 * MIN);
    idle.middleware(req('GET', '/ui/api/status'), new EventEmitter(), () => {});
    c.advance(10 * MIN); idle.check();
    assert.equal(stopped, true);
    const c2 = clock(); let s2 = false;
    const idle2 = create({ minutes: 30, stop: () => { s2 = true; }, now: c2.now });
    c2.advance(25 * MIN);
    const res = new EventEmitter();
    idle2.middleware(req('POST', '/v1/messages'), res, () => {});
    res.emit('close');
    c2.advance(10 * MIN); idle2.check();
    assert.equal(s2, false);
});

test('a request still being answered, or a busy hook, keeps it awake', () => {
    const c = clock(); let stopped = false; let working = true;
    const idle = create({ minutes: 30, stop: () => { stopped = true; }, busy: [() => working], now: c.now });
    const res = new EventEmitter();
    idle.middleware(req('POST', '/v1/messages'), res, () => {});
    c.advance(120 * MIN); idle.check();
    assert.equal(stopped, false);
    assert.equal(idle.status().busy, true);
    assert.equal(idle.status().stopsInMs, null);
    res.emit('close');
    idle.check();
    assert.equal(stopped, false); // busy hook still says working
    working = false;
    c.advance(31 * MIN); idle.check();
    assert.equal(stopped, true);
});

test('with no way to stop, or no idle time, it never stops by itself', () => {
    const c = clock();
    const none = create({ minutes: 30, stop: null, now: c.now });
    c.advance(999 * MIN); none.check();
    assert.equal(none.status().canStop, false);
    let stopped = false;
    const off = create({ minutes: 0, stop: () => { stopped = true; }, now: c.now });
    off.check();
    assert.equal(stopped, false);
    assert.equal(off.status().stopsInMs, null);
    assert.equal(off.status().canStop, true);
});

test('stop is requested once, and the status counts down', () => {
    const c = clock(); let n = 0;
    const idle = create({ minutes: 30, stop: () => { n++; }, now: c.now });
    c.advance(10 * MIN);
    assert.equal(idle.status().stopsInMs, 20 * MIN);
    assert.equal(idle.requestStop('asked'), true);
    assert.equal(idle.requestStop('again'), false);
    assert.equal(n, 1);
    assert.equal(idle.status().stopping, true);
});

test('extend adds idle time before the stop, on top of the countdown already running', () => {
    const c = clock(); let stopped = null;
    const idle = create({ minutes: 30, stop: (why) => { stopped = why; }, now: c.now });
    c.advance(20 * MIN);
    assert.equal(idle.status().stopsInMs, 10 * MIN);
    assert.equal(idle.extend(30 * MIN), true);
    assert.equal(idle.status().stopsInMs, 40 * MIN);
    assert.equal(idle.status().totalMs, 60 * MIN);
    assert.equal(idle.status().extraMs, 30 * MIN);
    c.advance(39 * MIN); idle.check();
    assert.equal(stopped, null);
    c.advance(2 * MIN); idle.check();
    assert.match(stopped, /idle for 61 minutes/);
});

test('extend is capped at four hours in all, and does nothing without a sleep timer', () => {
    const c = clock();
    const idle = create({ minutes: 30, stop: () => {}, now: c.now });
    for (let i = 0; i < 20; i++) idle.extend(60 * MIN);
    assert.equal(idle.status().extraMs, 4 * 60 * MIN);
    const never = create({ minutes: 0, stop: () => {}, now: c.now });
    assert.equal(never.extend(30 * MIN), false);
    assert.equal(never.status().canExtend, false);
    const noStop = create({ minutes: 30, stop: null, now: c.now });
    assert.equal(noStop.extend(30 * MIN), false);
});

test('any use of the server clears the extension', () => {
    const c = clock();
    const idle = create({ minutes: 30, stop: () => {}, now: c.now });
    idle.extend(30 * MIN);
    const mw = idle.middleware;
    const res = new EventEmitter();
    mw(req('POST', '/v1/messages'), res, () => {});
    res.emit('close');
    assert.equal(idle.status().extraMs, 0);
    assert.equal(idle.status().stopsInMs, 30 * MIN);
});

test('a running job keeps it awake and restarts the clock when it finishes', () => {
    const c = clock(); let stopped = null; let jobs = true;
    const idle = create({ minutes: 30, stop: (why) => { stopped = why; }, busy: [() => jobs], now: c.now });
    c.advance(25 * MIN); idle.check();
    assert.equal(idle.status().busy, true);
    assert.equal(idle.status().stopsInMs, null);
    c.advance(60 * MIN); idle.check();
    assert.equal(stopped, null);
    jobs = false;
    idle.check();
    assert.equal(idle.status().stopsInMs, 30 * MIN);
    c.advance(29 * MIN); idle.check();
    assert.equal(stopped, null);
    c.advance(2 * MIN); idle.check();
    assert.match(stopped, /idle for 31 minutes/);
});
