// The Tools page's API: add, edit, test, switch off and remove MCP servers
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mcpadmin-'));
const file = path.join(dir, 'mcp.json');
process.env.MCP_CONFIG = file; // before utils/mcp is loaded
const { buildSpec, describeSpec, maskUrl } = require('../utils/mcpAdmin');
const fixture = path.join(__dirname, 'fixtures', 'echo-mcp-server.js');
let harness, base, app;

test.before(async () => {
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    fs.writeFileSync(file, JSON.stringify({ note: 'kept', mcpServers: { first: { command: 'x', disabled: true } } }));
    ({ app } = require('../server'));
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});
test.after(async () => { harness?.close(); await require('../server').mcp.close(); });

const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

test('literal env and header values are masked, ${NAME} references are shown', () => {
    const d = describeSpec({ command: 'x', env: { KEY: 'sk-secret', REF: '${FROM_ENV}' }, headers: { Authorization: 'Bearer sk-secret' } });
    assert.deepEqual(d.env, [{ key: 'KEY', secret: true }, { key: 'REF', value: '${FROM_ENV}' }]);
    assert.deepEqual(d.headers, [{ key: 'Authorization', secret: true }]);
    assert.ok(!JSON.stringify(d).includes('sk-secret'));
    assert.ok(!maskUrl('https://h.example/mcp?key=sk-secret&x=${X}').includes('sk-secret'));
    assert.match(maskUrl('https://h.example/mcp?key=sk-secret&x=${X}'), /x=\$\{X\}/);
});

test('buildSpec checks the entry and keeps stored secrets on keep', () => {
    assert.throws(() => buildSpec({ type: 'stdio' }), /command/);
    assert.throws(() => buildSpec({ type: 'http', url: 'ftp://x' }), /http/);
    assert.throws(() => buildSpec({ type: 'carrier-pigeon' }), /type/);
    assert.throws(() => buildSpec({ command: 'x', env: [{ key: 'A', keep: true }] }), /no saved value/);
    const old = { command: 'x', env: { A: 'secret' }, disabledTools: ['t'], extra: 1 };
    const spec = buildSpec({ command: 'y', args: ['a'], env: [{ key: 'A', keep: true }, { key: 'B', value: 'new' }] }, old);
    assert.deepEqual(spec, { command: 'y', args: ['a'], env: { A: 'secret', B: 'new' }, disabledTools: ['t'], extra: 1 });
    const http = buildSpec({ type: 'http', url: maskUrl('https://h.example/m?k=zzz'), headers: [{ key: 'Authorization', keep: true }] }, { type: 'http', url: 'https://h.example/m?k=zzz', headers: { Authorization: 'Bearer q' } });
    assert.equal(http.url, 'https://h.example/m?k=zzz');
    assert.equal(http.headers.Authorization, 'Bearer q');
});

test('tests an entry without saving it, naming what is wrong', async () => {
    const ok = await (await post('/ui/api/mcp/test', { spec: { command: process.execPath, args: [fixture] } })).json();
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.tools.map(t => t.name).sort(), ['add', 'fail', 'shout']);
    const missing = await (await post('/ui/api/mcp/test', { spec: { command: 'definitely-not-installed-uvx' } })).json();
    assert.equal(missing.ok, false);
    assert.match(missing.error, /not found on PATH/);
    assert.deepEqual(Object.keys(read().mcpServers), ['first']);
});

test('adds, switches tools off, edits, renames and removes a server, keeping the file tidy', async () => {
    let j = await (await post('/ui/api/mcp/save', { name: 'echo', spec: { command: process.execPath, args: [fixture], env: [{ key: 'ECHO_SUFFIX', value: 'sk-top-secret' }] } })).json();
    const echo = j.servers.find(s => s.name === 'echo');
    assert.equal(echo.status, 'connected');
    assert.equal(echo.tools.length, 3);
    assert.ok(!JSON.stringify(j).includes('sk-top-secret'), 'the secret is never sent back');
    assert.equal(read().note, 'kept');
    assert.equal(read().mcpServers.echo.env.ECHO_SUFFIX, 'sk-top-secret');

    j = await (await post('/ui/api/mcp/patch', { name: 'echo', disabledTools: ['fail'] })).json();
    assert.equal(j.servers.find(s => s.name === 'echo').tools.find(t => t.name === 'fail').enabled, false);
    const offered = await (await fetch(`${base}/ui/api/tools`)).json();
    const names = offered.servers.find(s => s.name === 'echo').tools.map(t => t.name);
    assert.deepEqual(names.sort(), ['mcp__echo__add', 'mcp__echo__shout']);

    j = await (await post('/ui/api/mcp/save', { from: 'echo', name: 'echo2', spec: { command: process.execPath, args: [fixture], env: [{ key: 'ECHO_SUFFIX', keep: true }] } })).json();
    assert.deepEqual(j.servers.map(s => s.name), ['first', 'echo2']);
    assert.equal(read().mcpServers.echo2.env.ECHO_SUFFIX, 'sk-top-secret');
    assert.deepEqual(read().mcpServers.echo2.disabledTools, ['fail']);

    j = await (await post('/ui/api/mcp/patch', { name: 'echo2', disabled: true })).json();
    assert.equal(j.servers.find(s => s.name === 'echo2').status, 'disabled');

    assert.equal((await post('/ui/api/mcp/save', { name: 'first', spec: { command: 'x' } })).status, 409);
    assert.equal((await post('/ui/api/mcp/save', { name: 'bad name!', spec: { command: 'x' } })).status, 400);
    assert.equal((await post('/ui/api/mcp/remove', { name: 'nope' })).status, 404);
    j = await (await post('/ui/api/mcp/remove', { name: 'echo2' })).json();
    assert.deepEqual(j.servers.map(s => s.name), ['first']);
    assert.deepEqual(Object.keys(read().mcpServers), ['first']);
});

test('the catalog is listed and every entry would pass the checks', async () => {
    const { catalog } = await (await fetch(`${base}/ui/api/mcp`)).json();
    assert.ok(catalog.length >= 8);
    for (const c of catalog) {
        const spec = c.spec;
        buildSpec({ ...spec, env: Object.entries(spec.env || {}).map(([key, value]) => ({ key, value })), headers: Object.entries(spec.headers || {}).map(([key, value]) => ({ key, value })) });
    }
});

test('a request from a proxy or without JSON is refused', async () => {
    assert.equal((await fetch(`${base}/ui/api/mcp/save`, { method: 'POST', body: 'x' })).status, 415);
    assert.equal((await fetch(`${base}/ui/api/mcp`, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 403);
});
