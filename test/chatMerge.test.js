const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeMessages, mergeChats, delta, fingerprint } = require('../ui/chatmerge');

const m = (id, time, extra = {}) => ({ id, role: 'user', content: id, time, ...extra });

test('messages from both sides are kept once each, in time order', () => {
    const merged = mergeMessages([m('a', 1), m('c', 3), m('d', 4)], [m('a', 1), m('b', 2), m('c', 3)]);
    assert.deepEqual(merged.map((x) => x.id), ['a', 'b', 'c', 'd']);
});

test('this page\'s copy of a shared message stands, unless it is still streaming and the server\'s is finished', () => {
    const mine = m('r', 5, { content: 'mine' });
    assert.equal(mergeMessages([mine], [m('r', 5, { content: 'theirs' })])[0], mine);
    const out = mergeMessages([m('r', 5, { streaming: true, content: 'par' })], [m('r', 5, { content: 'partial and the rest' })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'partial and the rest');
});

test('messages without a time keep their place', () => {
    const merged = mergeMessages([m('a'), m('b')], [m('a'), m('x', 9)]);
    assert.deepEqual(merged.map((x) => x.id), ['a', 'b', 'x']);
});

test('the chat takes its settings from the side saved last and the messages from both', () => {
    const out = mergeChats({ id: 'c', title: 'mine', updated: 10, messages: [m('a', 1)] }, { id: 'c', title: 'theirs', updated: 20, messages: [m('b', 2)] });
    assert.equal(out.title, 'theirs');
    assert.equal(out.updated, 20);
    assert.deepEqual(out.messages.map((x) => x.id), ['a', 'b']);
});

test('delta lists only changed messages, and the order of all', () => {
    const msgs = [m('a', 1), m('b', 2)];
    const first = delta(msgs, new Map());
    assert.equal(first.upserts.length, 2);
    const next = delta([msgs[0], { ...msgs[1], content: 'edited' }, m('c', 3)], first.fingerprints);
    assert.deepEqual(next.upserts.map((x) => x.id), ['b', 'c']);
    assert.deepEqual(next.order, ['a', 'b', 'c']);
    assert.notEqual(fingerprint(m('a', 1)), fingerprint(m('a', 2)));
});
