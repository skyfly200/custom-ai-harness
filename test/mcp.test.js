// MCP servers for the chat page: reading mcp-servers.json, connecting over
// stdio, listing tools in OpenAI's format and running calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpManager, readConfig, expand, toolName, resultText } = require('../utils/mcp');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-'));
const fixture = path.join(__dirname, 'fixtures', 'echo-mcp-server.js');

test('a missing config file means no servers', () => {
    assert.deepEqual(readConfig(path.join(dir, 'nope.json')), {});
});

test('${VAR} and ${VAR:-default} expand from the environment', () => {
    process.env.HARNESS_TEST_TOKEN = 'abc';
    assert.deepEqual(expand({ h: 'Bearer ${HARNESS_TEST_TOKEN}', a: ['${MISSING_VAR:-x}', 1] }), { h: 'Bearer abc', a: ['x', 1] });
});

test('tool names fit OpenAI rules and stay unique', () => {
    const taken = new Map();
    const a = toolName('my server', 'do.thing', taken);
    assert.equal(a, 'mcp__my_server__do_thing');
    taken.set(a, 1);
    assert.notEqual(toolName('my server', 'do thing', taken), a);
    assert.ok(toolName('s', 'x'.repeat(100), new Map()).length <= 64);
});

test('results become text; images are described, long text is cut', () => {
    assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'x' }] }), 'a\n[image image/png not shown]');
    assert.match(resultText({ content: [{ type: 'text', text: 'x'.repeat(200000) }] }), /cut at 100000/);
});

test('connects to a stdio server, lists its tools and runs calls', async () => {
    const file = path.join(dir, 'servers.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {
        echo: { command: process.execPath, args: [fixture], env: { ECHO_SUFFIX: '${HARNESS_TEST_TOKEN}' } },
        broken: { command: path.join(dir, 'no-such-program') },
        off: { command: 'whatever', disabled: true },
    } }));
    process.env.HARNESS_TEST_TOKEN = 'abc';
    const mcp = new McpManager({ file });
    try {
        await mcp.start();
        const { servers } = mcp.status();
        const byName = Object.fromEntries(servers.map(s => [s.name, s]));
        assert.equal(byName.echo.status, 'connected');
        assert.deepEqual(byName.echo.tools.map(t => t.name).sort(), ['mcp__echo__add', 'mcp__echo__fail', 'mcp__echo__shout']);
        assert.equal(byName.broken.status, 'failed');
        assert.ok(byName.broken.error);
        assert.equal(byName.off.status, 'disabled');

        const defs = mcp.definitions();
        const add = defs.find(d => d.function.name === 'mcp__echo__add');
        assert.equal(add.type, 'function');
        assert.equal(add.function.parameters.properties.a.type, 'number');
        assert.equal(mcp.definitions(['echo']).length, 0);

        assert.deepEqual(await mcp.call('mcp__echo__add', { a: 2, b: 3 }), { text: '5', isError: false, server: 'echo', tool: 'add' });
        assert.equal((await mcp.call('mcp__echo__shout', { text: 'hi' })).text, 'HI abc');
        assert.equal((await mcp.call('mcp__echo__fail', {})).isError, true);
        await assert.rejects(mcp.call('mcp__nope__x', {}), /no MCP tool/);

        await mcp.reload();
        assert.equal(mcp.status().servers.find(s => s.name === 'echo').status, 'connected');
    } finally {
        await mcp.close();
    }
});

test('a broken config file is reported, not thrown', async () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    const mcp = new McpManager({ file });
    await mcp.start();
    assert.match(mcp.status().error, /bad\.json/);
    assert.deepEqual(mcp.status().servers, []);
});

test('${HOME} and ${HARNESS_DIR} always resolve; unset names are reported', () => {
    const missing = [];
    const out = expand(['${HOME}/Documents', '${HARNESS_DIR}', '${NOPE_NOT_SET}', '${NOPE2:-d}'], missing);
    assert.equal(out[0], `${process.env.HOME || os.homedir()}/Documents`);
    assert.equal(out[1], path.join(__dirname, '..'));
    assert.equal(out[2], '');
    assert.equal(out[3], 'd');
    assert.deepEqual(missing, ['NOPE_NOT_SET']);
});

test('a server using an unset ${VAR} fails with a message naming it', async () => {
    const file = path.join(dir, 'unset.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'http://127.0.0.1:9/', headers: { Authorization: 'Bearer ${HARNESS_TEST_UNSET}' } } } }));
    const mcp = new McpManager({ file });
    try {
        await mcp.start();
        const gh = mcp.status().servers[0];
        assert.equal(gh.status, 'failed');
        assert.match(gh.error, /\$\{HARNESS_TEST_UNSET\} is not set/);
    } finally { await mcp.close(); }
});

test('a missing program names what to install; relative paths resolve from the repo folder', async () => {
    const file = path.join(dir, 'hints.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {
        fetch: { command: 'uvx-not-installed-xyz' },
        rel: { command: process.execPath, args: ['test/fixtures/echo-mcp-server.js'] },
    } }));
    const mcp = new McpManager({ file });
    try {
        await mcp.start();
        const by = Object.fromEntries(mcp.status().servers.map(s => [s.name, s]));
        assert.match(by.fetch.error, /not found on PATH/);
        assert.equal(by.rel.status, 'connected');
    } finally { await mcp.close(); }
});

test('mcp-servers.example.json parses and its enabled servers are plain stdio', () => {
    const servers = readConfig(path.join(__dirname, '..', 'mcp-servers.example.json'));
    assert.deepEqual(Object.keys(servers), ['filesystem', 'jev-files', 'fetch', 'github']);
    assert.ok(!servers.filesystem.disabled && !servers['jev-files'].disabled);
    assert.ok(servers.fetch.disabled && servers.github.disabled);
    assert.ok(!JSON.stringify(servers).includes('C:\\\\Users\\\\you'));
});
