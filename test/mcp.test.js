// MCP servers for the chat page: reading mcp-servers.json, connecting over
// stdio, listing tools in OpenAI's format and running calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpManager, readConfig, expand, toolName, resultText, connectPolicy, describeFailure, crashSummary } = require('../utils/mcp');

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

test('a server that times out once is tried again; "timeoutMs" and "retries" are read from its entry', async () => {
    const file = path.join(dir, 'flaky.json');
    const marker = path.join(dir, 'flaky-marker');
    const flaky = path.join(__dirname, 'fixtures', 'flaky-mcp-server.js');
    // The first try hangs for the whole window, so a long window makes the test slow; 4 s
    // still leaves the second try time to boot Node even on a slow machine.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {
        retried: { command: process.execPath, args: [flaky], env: { FLAKY_MARKER: marker }, timeoutMs: 4000, retries: 1 },
        once: { command: process.execPath, args: [flaky], env: { FLAKY_MARKER: path.join(dir, 'once-marker') }, timeoutMs: 1000, retries: 0 },
    } }));
    const mcp = new McpManager({ file });
    try {
        await mcp.start();
        const byName = Object.fromEntries(mcp.status().servers.map(s => [s.name, s]));
        assert.equal(byName.retried.status, 'connected');
        assert.equal(byName.once.status, 'failed');
        assert.match(byName.once.error, /did not answer within 1 s/);
        assert.match(byName.once.error, /timeoutMs/);
    } finally {
        await mcp.close();
    }
});

test('connect policy: npx and uvx get longer and one retry; others keep 30 s, no retry; entries override', () => {
    assert.deepEqual(connectPolicy({ command: 'npx' }), { timeoutMs: 120000, retries: 1 });
    assert.deepEqual(connectPolicy({ command: 'C:\\Program Files\\nodejs\\npx.cmd' }), { timeoutMs: 120000, retries: 1 });
    assert.deepEqual(connectPolicy({ command: 'uvx' }), { timeoutMs: 120000, retries: 1 });
    assert.deepEqual(connectPolicy({ command: 'node' }), { timeoutMs: 30000, retries: 0 });
    assert.deepEqual(connectPolicy({ url: 'https://x.test/mcp' }), { timeoutMs: 30000, retries: 0 });
    assert.deepEqual(connectPolicy({ command: 'npx', timeoutMs: 5000, retries: 0 }), { timeoutMs: 5000, retries: 0 });
    assert.deepEqual(connectPolicy({ command: 'node', timeoutMs: -1, retries: 2 }), { timeoutMs: 30000, retries: 2 });
});

test('failures say what to do', () => {
    const timeout = Object.assign(new Error('MCP error -32001: Request timed out'), { code: -32001 });
    assert.match(describeFailure(timeout, { command: 'npx' }, { timeoutMs: 120000, tries: 2 }), /did not answer within 120 s, even after 2 tries.*downloading.*timeoutMs/);
    assert.doesNotMatch(describeFailure(timeout, { command: 'node' }, { timeoutMs: 30000 }), /downloading/);
    const http404 = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":{"code":"404"}}'), { code: 404 });
    const msg = describeFailure(http404, { type: 'http', url: 'https://aa.test/mcp?key=SECRET' });
    assert.match(msg, /https:\/\/aa\.test\/mcp answered 404.*"url".*"disabled": true/);
    assert.doesNotMatch(msg, /SECRET/);
    assert.match(describeFailure(Object.assign(new Error('x'), { code: 401 }), { type: 'http', url: 'https://a.test/' }), /refused the login.*headers/);
    assert.match(describeFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }), { type: 'http', url: 'https://a.test/' }), /could not reach.*ENOTFOUND/);
    assert.match(describeFailure(Object.assign(new Error('nf'), { code: 'ENOENT' }), { command: 'uvx' }), /"uvx": not found on PATH \(install uv/);
});

test('a program that dies on start shows its error, not the end of the stack', async () => {
    const stack = "node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\nError: Cannot find module '/app/scripts/x.js'\nRequire stack:\n- /app/y.js\n    at Function._resolveFilename (node:internal/x:1:1) {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v22.23.4\n";
    assert.match(crashSummary(stack), /^Error: Cannot find module '\/app\/scripts\/x\.js'/);
    assert.doesNotMatch(crashSummary(stack), /Node\.js v/);
    assert.equal(crashSummary('just a note\nmore'), 'just a note more');

    const file = path.join(dir, 'dead.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { dead: { command: process.execPath, args: ['scripts/does-not-exist.js'] } } }));
    const manager = new McpManager({ file });
    await manager.start();
    assert.match(manager.status().servers.find((s) => s.name === 'dead').error, /Cannot find module.*does-not-exist\.js/);
    await manager.close();
});

test('the Docker image ships the jev-files tool server', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'), /COPY .*scripts\/jev-files-mcp\.js/);
});

test('servers that download their program connect one at a time, the rest alongside', async () => {
    const m = new McpManager({ specs: async () => ({}) });
    let running = 0, peak = 0, plain = 0;
    m.connect = async (s) => {
        if (s.spec.command === 'node') { plain++; return; }
        peak = Math.max(peak, ++running);
        await new Promise(r => setTimeout(r, 20));
        running--;
    };
    const list = ['npx', 'uvx', 'npx', 'node'].map((command, i) => ({ name: `s${i}`, spec: { command } }));
    await m.connectAll(list);
    assert.equal(peak, 1);
    assert.equal(plain, 1);
});
