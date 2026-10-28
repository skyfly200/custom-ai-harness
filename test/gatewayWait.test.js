const test = require('node:test');
const assert = require('node:assert/strict');
const { waitSeconds, waitUntilUp } = require('../utils/gatewayWait');

test('waitSeconds is off unless HARNESS_GATEWAY_WAIT_S is a positive number', () => {
    assert.equal(waitSeconds({}), 0);
    assert.equal(waitSeconds({ HARNESS_GATEWAY_WAIT_S: 'x' }), 0);
    assert.equal(waitSeconds({ HARNESS_GATEWAY_WAIT_S: '240' }), 240);
});

test('waitUntilUp returns once the probe succeeds, and false at the deadline', async () => {
    let n = 0;
    assert.equal(await waitUntilUp('http://x:1', { timeoutMs: 1000, intervalMs: 5, probe: async () => ++n >= 3 }), true);
    assert.equal(n, 3);
    assert.equal(await waitUntilUp('http://x:1', { timeoutMs: 50, intervalMs: 10, probe: async () => false }), false);
});
