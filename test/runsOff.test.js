const test = require('node:test');
const assert = require('node:assert');

// A hosted server started without HARNESS_RUNS has no task runner: the Agents page gets a plain explanation
test('the runner routes say Agents are off when the server has no runner', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:9';
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_RUNS_OFF = '1';
    const { app } = require('../server');
    const harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    try {
        const base = `http://127.0.0.1:${harness.address().port}`;
        for (const part of ['runs', 'agents', 'apps', 'tickets']) {
            const res = await fetch(`${base}/ui/api/${part}`);
            assert.strictEqual(res.status, 503);
            const body = await res.json();
            assert.strictEqual(body.disabled, true);
            assert.match(body.error, /HARNESS_RUNS=1/);
        }
    } finally {
        harness.close();
        delete process.env.HARNESS_RUNS_OFF;
    }
});
