// A remote MCP server set to "ask first" (the Vercel catalog entry): the Authorization header goes
// out, and a tool that changes something is refused without the person's confirmation.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { McpManager } = require('../utils/mcp');
const catalog = require('../utils/mcpCatalog');
const { buildSpec, describeSpec } = require('../utils/mcpAdmin');
const { remoteCatalog } = require('../utils/userMcp');

let stub, url, seenAuth = [], deployed = 0;

test.before(async () => {
    stub = http.createServer(async (req, res) => {
        seenAuth.push(req.headers.authorization);
        const server = new McpServer({ name: 'vercel-stub', version: '1.0.0' });
        server.registerTool('list_projects', { description: 'List projects', annotations: { readOnlyHint: true } },
            async () => ({ content: [{ type: 'text', text: 'site-a, site-b' }] }));
        server.registerTool('create_deployment', { description: 'Deploy', inputSchema: { project: z.string() } },
            async ({ project }) => { deployed++; return { content: [{ type: 'text', text: `deployed ${project}` }] }; });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        let body = '';
        for await (const chunk of req) body += chunk;
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${stub.address().port}/mcp`;
});
test.after(() => { stub.closeAllConnections?.(); stub.close(); });

const manager = (askBefore) => new McpManager({ file: 'test', plain: true, specs: () => ({ vercel: { type: 'http', url, headers: { Authorization: 'Bearer tok_123' }, askBefore } }) });

test('the Vercel catalog entry is a remote server that asks before changes', () => {
    const v = catalog.find((c) => c.id === 'vercel');
    assert.equal(v.spec.url, 'https://mcp.vercel.com');
    assert.equal(v.spec.askBefore, 'writes');
    assert.equal(v.spec.headers.Authorization, 'Bearer ${VERCEL_TOKEN}');
    assert.ok(remoteCatalog().some((c) => c.id === 'vercel'), 'members can add it too');
    const spec = buildSpec({ ...v.spec, headers: [{ key: 'Authorization', value: v.spec.headers.Authorization }] });
    assert.equal(spec.askBefore, 'writes');
    assert.equal(describeSpec(spec).askBefore, 'writes');
    assert.throws(() => buildSpec({ type: 'http', url: 'https://x.test', askBefore: 'maybe' }), /askBefore/);
    assert.equal(buildSpec({ type: 'http', url: 'https://x.test', askBefore: '' }, { askBefore: 'all' }).askBefore, undefined);
});

test('writes need confirmation, read-only tools do not, the header is sent', async () => {
    const mgr = manager('writes');
    await mgr.start();
    try {
        assert.ok(seenAuth.includes('Bearer tok_123'));
        const tools = Object.fromEntries(mgr.status().servers[0].tools.map((t) => [t.name, t.needsApproval]));
        assert.deepEqual(tools, { mcp__vercel__list_projects: false, mcp__vercel__create_deployment: true });
        assert.equal((await mgr.call('mcp__vercel__list_projects', {})).text, 'site-a, site-b');
        await assert.rejects(mgr.call('mcp__vercel__create_deployment', { project: 'site-a' }), /needs the person's approval/);
        assert.equal(deployed, 0);
        assert.equal((await mgr.call('mcp__vercel__create_deployment', { project: 'site-a' }, { confirmed: true })).text, 'deployed site-a');
        assert.equal(deployed, 1);
    } finally { await mgr.close(); }
});

test('"all" asks for every tool and no setting asks for none', async () => {
    let mgr = manager('all');
    await mgr.start();
    await assert.rejects(mgr.call('mcp__vercel__list_projects', {}), /approval/);
    await mgr.close();
    mgr = manager(undefined);
    await mgr.start();
    try {
        assert.equal(mgr.needsApproval('mcp__vercel__create_deployment'), false);
        assert.equal((await mgr.call('mcp__vercel__create_deployment', { project: 'x' })).isError, false);
    } finally { await mgr.close(); }
});
