// The chat page's tool endpoints: listing tools, linking a repo, running calls
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-'));
const repo = path.join(dir, 'repo');
let harness, base, app;

test.before(async () => {
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
    process.env.MCP_CONFIG = path.join(dir, 'mcp.json');
    fs.writeFileSync(process.env.MCP_CONFIG, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'echo-mcp-server.js')] } } }));
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    ({ app } = require('../server'));
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test.after(async () => { harness?.close(); await require('../server').mcp.close(); });

const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('lists MCP servers with OpenAI tool definitions, and the repo tools', async () => {
    const j = await (await fetch(`${base}/ui/api/tools`)).json();
    assert.equal(j.servers[0].status, 'connected');
    assert.ok(j.definitions.echo.some(d => d.function.name === 'mcp__echo__add'));
    assert.ok(j.repoDefinitions.some(d => d.function.name === 'repo_read_file'));
});

test('links a repo and runs repo and MCP tool calls', async () => {
    const info = await (await post('/ui/api/repo', { path: repo })).json();
    assert.equal(info.name, 'repo');
    const read = await (await post('/ui/api/tools/call', { name: 'repo_read_file', arguments: { path: 'a.txt' }, repo })).json();
    assert.match(read.text, /1  alpha/);
    assert.equal(read.isError, false);
    const add = await (await post('/ui/api/tools/call', { name: 'mcp__echo__add', arguments: { a: 1, b: 2 } })).json();
    assert.equal(add.text, '3');
});

test('a failing call is an answer for the model, not an HTTP error', async () => {
    const res = await post('/ui/api/tools/call', { name: 'repo_read_file', arguments: { path: '../x' }, repo });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.isError, true);
    assert.match(j.text, /outside the repository/);
    assert.match((await (await post('/ui/api/tools/call', { name: 'repo_git_status', arguments: {} })).json()).text, /not linked/);
    assert.equal((await post('/ui/api/repo', { path: dir })).status, 400);
});

test('tool calls need JSON from this machine', async () => {
    const res = await fetch(`${base}/ui/api/tools/call`, { method: 'POST', body: 'name=repo_git_status' });
    assert.equal(res.status, 415);
});
