const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const monitor = require('../utils/monitor');

test('a routing decision records the Gateway result and fallbacks', () => {
    const event = monitor.recordRoute({ path: '/v1/messages', model: 'local-engine', threshold: 0.2, winRate: 0.7, tools: true, tokens: 900, prompt: 'refactor the parser' });
    monitor.recordResponse(event, 200, { 'x-litellm-attempted-fallbacks': '1', 'x-litellm-model-group': 'fallback-openrouter-tools' });
    const [latest] = monitor.recentEvents(1);
    assert.equal(latest.model, 'local-engine');
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

test('the live feed announces routing, the response and the end of a request', () => {
    const seen = [];
    const listen = (u) => seen.push(u);
    monitor.live.on('update', listen);
    try {
        monitor.recordRouting({ path: '/v1/chat/completions', clientId: 'c1', prompt: 'hi' });
        const event = monitor.recordRoute({ path: '/v1/chat/completions', model: 'm', clientId: 'c1', transforms: ['caveman'], routeMs: 4 });
        monitor.recordResponse(event, 200, { 'x-litellm-model-group': 'g' });
        monitor.recordFinish(event);
    } finally {
        monitor.live.off('update', listen);
    }
    assert.deepEqual(seen.map(u => u.type), ['routing', 'route', 'response', 'finish']);
    assert.equal(seen[1].event.clientId, 'c1');
    assert.deepEqual(seen[1].event.transforms, ['caveman']);
    assert.equal(seen[2].event.servedBy, 'g');
    assert.equal(typeof seen[3].event.doneMs, 'number');
    assert.equal(seen[3].event.started, undefined);
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

test('routerProblem names the cause and the fix', () => {
    const url = 'http://localhost:6060/health';
    assert.equal(monitor.routerProblem({ url, ok: true, detail: { settings: {} } }), null);
    assert.match(monitor.routerProblem({ url, ok: true, detail: {} }), /older version without admin endpoints.*git pull/);
    assert.match(monitor.routerProblem({ url, ok: false, status: 404 }), /not the Router.*port 6060/);
    const refused = monitor.routerProblem({ url, ok: false, status: null, error: 'ECONNREFUSED' }, 'win32');
    assert.match(refused, /Nothing is listening at http:\/\/localhost:6060.*npm run all.*\.venv\\Scripts\\python router\.py.*ROUTER_URL=http:\/\/127\.0\.0\.1:6060/);
    assert.doesNotMatch(monitor.routerProblem({ url: 'http://127.0.0.1:6060/health', ok: false, error: 'ECONNREFUSED' }, 'linux'), /::1/);
    assert.match(monitor.routerProblem({ url, ok: false, error: 'TimeoutError' }), /still be starting/);
});
