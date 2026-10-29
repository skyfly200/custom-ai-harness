// Which account's chats this browser's localStorage copy belongs to (ui/ownerScope.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, isPersonal, OWNER_KEY } = require('../ui/ownerScope');

test('same account keeps its copy; a different one has it removed', () => {
    assert.equal(decide({ stored: 'alice', owner: 'alice', hasData: true, accountHasData: true }), 'keep');
    assert.equal(decide({ stored: 'alice', owner: 'bob', hasData: true, accountHasData: true }), 'wipe');
    assert.equal(decide({ stored: 'alice', owner: 'bob', hasData: true, accountHasData: false }), 'wipe');
});

test('a copy with no label is claimed only when that is safe', () => {
    assert.equal(decide({ stored: null, owner: 'alice', hasData: false, accountHasData: false }), 'adopt'); // nothing to protect
    assert.equal(decide({ stored: null, owner: 'alice', hasData: true, accountHasData: true }), 'adopt');   // an existing account, as before
    assert.equal(decide({ stored: null, owner: 'bob', hasData: true, accountHasData: false }), 'wipe');     // a new account must not inherit it
});

test('no signed-in name means nothing to decide', () => {
    assert.equal(decide({ stored: 'alice', owner: '', hasData: true, accountHasData: true }), 'keep');
});

test('personal keys are removed, browser settings stay', () => {
    for (const k of ['harness-chats', 'harness-chat:abc', 'harness-projects', 'harness-skills', 'harness-commands', 'harness-schedules', 'harness-chat-prefs', 'harness-sync-ts:harness-projects', 'harness-chat-scope', 'harness-new-chat-route']) assert.ok(isPersonal(k), k);
    for (const k of ['harness-notify', 'harness-bright-bg', OWNER_KEY, 'bright-bg-chat', 'harness-chat-options-tab']) assert.ok(!isPersonal(k), k);
});
