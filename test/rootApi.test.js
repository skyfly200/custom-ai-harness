// The pages call their API with relative URLs ("api/status"); served at the site root those must reach /ui/api/...
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeGateway } = require('./helpers/stubs');

const hits = [];
const gateway = fakeGateway((req) => { hits.push(req.url); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rootapi-'));
let harness, base;

test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    process.env.MCP_CONFIG = path.join(dir, 'none.json');
    delete process.env.HARNESS_PASSWORD;
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(() => { harness?.close(); gateway.close(); });

test('GET api/... at the site root answers like /ui/api/...', async () => {
    for (const p of ['status', 'settings', 'profiles', 'gateway']) {
        const root = await fetch(`${base}/api/${p}`);
        const ui = await fetch(`${base}/ui/api/${p}`);
        assert.equal(root.status, ui.status, p);
        assert.equal(root.headers.get('content-type'), ui.headers.get('content-type'), p);
        assert.ok(/json/.test(root.headers.get('content-type')), `${p} is the harness's JSON, not the Gateway's reply`);
        await root.body?.cancel(); await ui.body?.cancel();
        assert.ok(!hits.some((u) => u.startsWith('/api/')), `${p} reached the Gateway`);
    }
});

test('every GET the pages make by relative URL exists', async () => {
    const urls = new Set();
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'ui')).filter((n) => n.endsWith('.js'))) {
        for (const m of fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8').matchAll(/(?:fetch|getJSON)\('(api\/[a-z-]+)'\)/g)) urls.add(m[1]);
    }
    assert.ok(urls.size > 5);
    for (const u of urls) {
        const res = await fetch(`${base}/${u}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (res) await res.body?.cancel();
        assert.ok(res && res.status !== 404, u);
    }
    assert.deepEqual(hits.filter((u) => u.startsWith('/api/')), [], 'no api/ request fell through to the Gateway');
});
