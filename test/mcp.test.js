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
