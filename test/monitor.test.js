const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const monitor = require('../utils/monitor');

test('a routing decision records the Gateway result and fallbacks', () => {
    const event = monitor.recordRoute({ path: '/v1/messages', model: 'claude-sonnet-5', threshold: 0.2, winRate: 0.7, tools: true, tokens: 900, prompt: 'refactor the parser' });
    monitor.recordResponse(event, 200, { 'x-litellm-attempted-fallbacks': '1', 'x-litellm-model-group': 'fallback-openrouter-tools' });
    const [latest] = monitor.recentEvents(1);
    assert.equal(latest.model, 'claude-sonnet-5');
    assert.equal(latest.status, 200);
    assert.equal(latest.fallbacks, 1);
    assert.equal(latest.servedBy, 'fallback-openrouter-tools');
    assert.equal(latest.started, undefined);
    assert.equal(monitor.stats().fallbacks, 1);
});

test('a down Router and a failed Gateway call count as errors', () => {
    const before = monitor.stats();
    const event = monitor.recordRoute({ path: '/v1/messages', model: 'fallback-openrouter-tools', threshold: 0.5, winRate: null, routerError: 'fetch failed' });
    monitor.recordError(event, new Error('ECONNREFUSED'));
    const after = monitor.stats();
    assert.equal(after.routerDown, before.routerDown + 1);
    assert.equal(after.errors, before.errors + 1);
    assert.equal(monitor.recentEvents(1)[0].error, 'ECONNREFUSED');
});

test('history keeps the newest 200 decisions, newest first', () => {
    for (let i = 0; i < 250; i++) monitor.recordRoute({ path: '/x', model: `m${i}` });
    const events = monitor.recentEvents(500);
    assert.equal(events.length, 200);
    assert.equal(events[0].model, 'm249');
});

test('probe reports up, down, and optional components', async () => {
    const server = http.createServer((req, res) => res.end('{"status":"ok"}')).listen(0);
    const port = server.address().port;
    try {
        const up = await monitor.probe('Router', `http://127.0.0.1:${port}/health`);
        assert.equal(up.ok, true);
        assert.deepEqual(up.detail, { status: 'ok' });
    } finally {
        server.close();
    }
    const down = await monitor.probe('Ollama', `http://127.0.0.1:${port}/api/tags`, { optional: true });
    assert.equal(down.ok, false);
    assert.equal(down.optional, true);
    assert.ok(down.error);
});
