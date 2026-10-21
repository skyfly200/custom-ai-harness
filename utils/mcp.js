// MCP servers for the chat page. The harness connects to the servers listed in
// mcp-servers.json (the same layout as Claude Code's .mcp.json), offers their
// tools to the model in OpenAI's function format, and runs the calls the model
// makes. Claude Code doesn't need this: it runs its own MCP servers.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = process.env.MCP_CONFIG || path.join(__dirname, '..', 'mcp-servers.json');
const CALL_TIMEOUT_MS = 120000;
const MAX_RESULT_CHARS = 100000; // Headroom trims it further when it's on

// ${VAR} and ${VAR:-default} from the environment (.env included), as Claude Code does.
// Also ${HOME} (the home folder on Windows too) and ${HARNESS_DIR} (this repo's folder).
// Names with no value and no default are added to `missing`, when given.
function expand(value, missing) {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
            const found = process.env[name] || (name === 'HOME' ? os.homedir() : name === 'HARNESS_DIR' ? ROOT : undefined);
            if (found !== undefined) return found;
            if (fallback === undefined) missing?.push(name);
            return fallback ?? '';
        });
    }
    if (Array.isArray(value)) return value.map(v => expand(v, missing));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, missing)]));
    return value;
}

// Whether a bare program name (npx, uvx...) is on PATH; Windows adds .exe/.cmd/.bat
function onPath(command) {
    if (path.isAbsolute(command) || /[\\/]/.test(command)) return fs.existsSync(command);
    const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat('') : [''];
    return (process.env.PATH || '').split(path.delimiter).filter(Boolean).some(dir => exts.some(ext => fs.existsSync(path.join(dir, command + ext))));
}

// What to install when a server's program isn't found
const INSTALL_HINTS = {
    npx: 'install Node.js from nodejs.org',
    node: 'install Node.js from nodejs.org',
    uvx: 'install uv from docs.astral.sh/uv, then restart the Interceptor',
    uv: 'install uv from docs.astral.sh/uv, then restart the Interceptor',
    docker: 'install Docker Desktop',
    python: 'install Python',
};

/**
 * Read the server list: { name: { command, args, env, cwd } | { type: 'http' | 'sse', url, headers } }.
 * A server with "disabled": true is listed but not started.
 */
function readConfig(file = CONFIG_FILE) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
    const json = JSON.parse(text);
    const servers = json.mcpServers ?? json.servers ?? {};
    if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcpServers must be an object of named servers');
    return servers;
}

function transportType(spec) {
    if (spec.type) return spec.type === 'streamable-http' ? 'http' : spec.type;
    return spec.url ? 'http' : 'stdio';
}

// OpenAI function names: letters, digits, _ and -, at most 64 characters
function toolName(server, tool, taken) {
    const clean = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_');
    let name = `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
    for (let n = 2; taken.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
    return name;
}

// A tool result as text for the model. Tool messages carry text only, so
// images and audio are described rather than sent.
function resultText(result) {
    if (result?.toolResult !== undefined) return typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
    const parts = (result?.content || []).map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri || ''}]`;
        if (c.type === 'resource_link') return `[resource ${c.uri}${c.name ? ` (${c.name})` : ''}]`;
        return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} not shown]`;
    });
    if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
    let text = parts.join('\n');
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n[harness: cut at ${MAX_RESULT_CHARS} characters]`;
    return text;
}

class McpManager {
    constructor({ file = CONFIG_FILE } = {}) {
        this.file = file;
        this.servers = new Map(); // name -> { name, spec, status, error, client, tools }
        this.byTool = new Map();  // exposed tool name -> { server, tool }
        this.loading = null;
    }

    // Connect every server in the file (once; reload() starts over)
    start() {
        if (!this.loading) this.loading = this.load();
        return this.loading;
    }

    async reload() {
        await this.close();
        this.loading = this.load();
        return this.loading;
    }

    async load() {
        let specs;
        try {
            specs = readConfig(this.file);
            this.configError = null;
        } catch (err) {
            this.configError = `${path.basename(this.file)}: ${err.message}`;
            specs = {};
        }
        for (const [name, spec] of Object.entries(specs)) {
            this.servers.set(name, { name, spec, type: transportType(spec), status: spec.disabled ? 'disabled' : 'connecting', tools: [] });
        }
        await Promise.all([...this.servers.values()].filter(s => s.status === 'connecting').map(s => this.connect(s)));
        this.indexTools();
    }

    async connect(server) {
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const missing = [];
        const spec = expand(server.spec, missing);
        try {
            if (missing.length) throw new Error(`${[...new Set(missing)].map(n => '${' + n + '}').join(', ')} ${new Set(missing).size > 1 ? 'are' : 'is'} not set: add ${new Set(missing).size > 1 ? 'them' : 'it'} to .env, then restart the Interceptor and press Reload`);
            const client = new Client({ name: 'custom-ai-harness', version: '1.0.0' });
            client.onerror = () => {};
            server.client = client;
            if (transportType(spec) === 'stdio' && spec.command && !onPath(spec.command)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            await client.connect(this.transport(server, spec), { timeout: 30000 });
            const tools = [];
            let cursor;
            do {
                const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 30000 });
                tools.push(...page.tools);
                cursor = page.nextCursor;
            } while (cursor);
            server.tools = tools;
            server.status = 'connected';
            server.error = null;
            client.onclose = () => {
                if (server.client !== client) return;
                server.status = 'failed';
                server.error = 'the server stopped';
                this.indexTools();
            };
        } catch (err) {
            server.status = 'failed';
            if (err.code === 'ENOENT') {
                const hint = INSTALL_HINTS[path.basename(String(spec.command)).replace(/\.(exe|cmd)$/i, '')];
                err.message = `could not start "${spec.command}": not found on PATH${hint ? ` (${hint})` : ''}`;
            }
            server.error = server.stderr?.trim().split('\n').slice(-3).join(' ') || err.message;
            if (server.stderr && !server.error.includes(err.message)) server.error = `${err.message}: ${server.error}`;
            try { await server.client?.close(); } catch {}
            server.client = null;
        }
    }

    transport(server, spec) {
        const type = transportType(spec);
        if (type === 'stdio') {
            if (!spec.command) throw new Error('needs a "command" (or a "url" for an HTTP server)');
            const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
            const transport = new StdioClientTransport({
                command: spec.command,
                args: spec.args || [],
                // the whole environment, as Claude Code does: npx needs the proxy, npm and Windows folder variables
                env: { ...process.env, ...(spec.env || {}) },
                cwd: spec.cwd || ROOT, // so "scripts/jev-files-mcp.js" works wherever the Interceptor was started
                stderr: 'pipe',
            });
            // keep the last of what the server prints, to explain a failed start
            server.stderr = '';
            transport.stderr?.on('data', (chunk) => { server.stderr = (server.stderr + chunk).slice(-2000); });
            return transport;
        }
        const url = new URL(spec.url);
        const requestInit = spec.headers ? { headers: spec.headers } : undefined;
        if (type === 'sse') {
            const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
            return new SSEClientTransport(url, { requestInit });
        }
        if (type !== 'http') throw new Error(`unknown type "${spec.type}" (use stdio, http or sse)`);
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        return new StreamableHTTPClientTransport(url, { requestInit });
    }

    indexTools() {
        this.byTool.clear();
        for (const server of this.servers.values()) {
            if (server.status !== 'connected') continue;
            for (const tool of server.tools) {
                this.byTool.set(toolName(server.name, tool.name, this.byTool), { server, tool });
            }
        }
    }

    // Servers and their tools, for the chat page's Options
    status() {
        const names = new Map([...this.byTool].map(([name, { server, tool }]) => [`${server.name}\0${tool.name}`, name]));
        return {
            file: this.file,
            error: this.configError || null,
            servers: [...this.servers.values()].map(s => ({
                name: s.name,
                type: s.type,
                status: s.status,
                error: s.error || null,
                tools: s.tools.map(t => ({ name: names.get(`${s.name}\0${t.name}`) || t.name, title: t.title || t.annotations?.title || t.name, description: t.description || '' })),
            })),
        };
    }

    // OpenAI tool definitions for the connected servers, minus the ones switched off
    definitions(off = []) {
        const skip = new Set(off);
        return [...this.byTool].filter(([, { server }]) => !skip.has(server.name)).map(([name, { server, tool }]) => ({
            type: 'function',
            function: {
                name,
                description: `${tool.description || tool.title || tool.name} (MCP server: ${server.name})`.slice(0, 1024),
                parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
        }));
    }

    has(name) {
        return this.byTool.has(name);
    }

    async call(name, args) {
        const entry = this.byTool.get(name);
        if (!entry) throw new Error(`no MCP tool named ${name}`);
        const { server, tool } = entry;
        if (!server.client) throw new Error(`MCP server ${server.name} is not connected`);
        const result = await server.client.callTool({ name: tool.name, arguments: args || {} }, undefined, { timeout: CALL_TIMEOUT_MS });
        return { text: resultText(result), isError: !!result.isError, server: server.name, tool: tool.name };
    }

    async close() {
        const servers = [...this.servers.values()];
        this.servers.clear();
        this.byTool.clear();
        this.loading = null;
        await Promise.all(servers.map(async (s) => {
            const client = s.client;
            s.client = null;
            try { await client?.close(); } catch {}
        }));
    }
}

module.exports = { McpManager, readConfig, expand, toolName, resultText, CONFIG_FILE };
