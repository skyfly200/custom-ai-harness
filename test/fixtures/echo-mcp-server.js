// A tiny MCP server over stdio for the tests: "add" and "shout" tools.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('shout', { description: 'Upper-case some text', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text: `${text.toUpperCase()} ${process.env.ECHO_SUFFIX || ''}`.trim() }] }));
server.registerTool('fail', { description: 'Always fails' },
    async () => ({ isError: true, content: [{ type: 'text', text: 'it broke' }] }));
server.connect(new StdioServerTransport());
