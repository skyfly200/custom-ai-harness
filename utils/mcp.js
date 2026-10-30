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
const CONNECT_TIMEOUT_MS = 30000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
// npx, uvx and docker download the server on first use, which can take minutes on a cold cache
const LAUNCHER_CONNECT_TIMEOUT_MS = 120000;
const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'docker']);
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
 * Any entry may add "timeoutMs" (connect and list tools), "retries" (more tries after a timeout)
 * and "callTimeoutMs" (one tool call).
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

/**
 * Write the server list back, keeping any other keys in the file and the key
 * name it already uses (mcpServers or servers). Written whole, then renamed
 * into place, so a crash never leaves half a file.
 */
function writeConfig(servers, file = CONFIG_FILE) {
    let json = {};
    try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const key = json.mcpServers === undefined && json.servers !== undefined ? 'servers' : 'mcpServers';
    json[key] = servers;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
    fs.renameSync(tmp, file);
}

/**
 * Settings that keep npx from stalling on a server host: no update check, funding or audit requests, and a
 * download cache in a folder that can be written (a read-only or missing home folder makes npx hang or fail).
 */
function launcherEnv() {
    const env = { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_yes: 'true' };
    const writable = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
    if (!process.env.npm_config_cache && !writable(path.join(os.homedir(), '.npm'))) {
        const dir = path.join(process.env.HARNESS_DATA_DIR || os.tmpdir(), 'npm-cache');
        if (writable(dir)) env.npm_config_cache = dir;
    }
    return env;
}

function programName(spec) {
    return String(spec.command || '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
}

// Servers started through a package launcher are slow the first time and worth a second try
function isLauncher(spec) {
    return transportType(spec) === 'stdio' && LAUNCHERS.has(programName(spec));
}

function positive(n) {
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * How long to wait for a server to connect and list its tools, and how many
 * more tries after a timeout. "timeoutMs" and "retries" in the server's entry win.
 */
function connectPolicy(spec) {
    const launcher = isLauncher(spec);
    const retries = Number.isInteger(spec.retries) && spec.retries >= 0 ? spec.retries : (launcher ? 1 : 0);
    return { timeoutMs: positive(spec.timeoutMs) ?? (launcher ? LAUNCHER_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS), retries };
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
function resultText(result, max = MAX_RESULT_CHARS) {
    if (result?.toolResult !== undefined) return typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
    const parts = (result?.content || []).map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri || ''}]`;
        if (c.type === 'resource_link') return `[resource ${c.uri}${c.name ? ` (${c.name})` : ''}]`;
        return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} not shown]`;
    });
    if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
    let text = parts.join('\n');
    if (text.length > max) text = `${text.slice(0, max)}\n[harness: cut at ${max} characters]`;
    return text;
}

// The address without credentials in a query string, for messages
function shownUrl(spec) {
    try {
        const u = new URL(spec.url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return String(spec.url || '');
    }
}

// A connection error as one line saying what happened and what to do about it
function describeFailure(err, spec, { timeoutMs, tries = 1 } = {}) {
    const http = transportType(spec) !== 'stdio';
    const code = err.code;
    const secs = Math.round((timeoutMs || CONNECT_TIMEOUT_MS) / 1000);
    if (code === 'ENOENT' && !http) {
        const hint = INSTALL_HINTS[programName(spec)];
        return `could not start "${spec.command}": not found on PATH${hint ? ` (${hint})` : ''}`;
    }
    if (code === -32001 || /timed out/i.test(err.message)) {
        const tried = tries > 1 ? `, even after ${tries} tries` : '';
        if (http) return `no answer from ${shownUrl(spec)} within ${secs} s${tried}. Check the "url", or raise "timeoutMs" in its mcp-servers.json entry`;
        return `did not answer within ${secs} s${tried}${isLauncher(spec) ? ` (${programName(spec)} may still be downloading the server: run its command once in a terminal, then press Reload)` : ''}. Raise "timeoutMs" in its mcp-servers.json entry if it just needs longer`;
    }
    if (http) {
        const where = shownUrl(spec);
        if (code === 404) return `${where} answered 404 (not found): the address is wrong or the service was removed. Fix the "url" in mcp-servers.json, or set "disabled": true`;
        if (code === 401 || code === 403) return `${where} refused the login (HTTP ${code}): check the key in its "headers" (and that the \${NAME} it uses is set in .env)`;
        if (code === 405 || code === 400) return `${where} answered HTTP ${code}: it may not speak MCP over ${transportType(spec) === 'sse' ? 'SSE' : 'streamable HTTP'}. Try "type": "${transportType(spec) === 'sse' ? 'http' : 'sse'}", or check the "url"`;
        if (typeof code === 'number' && code >= 500) return `${where} had a server error (HTTP ${code}): try again later`;
        const net = err.cause?.code || code;
        if (net === 'ENOTFOUND' || net === 'ECONNREFUSED' || net === 'ECONNRESET' || net === 'ETIMEDOUT' || /fetch failed/i.test(err.message)) {
            return `could not reach ${where} (${net || 'network error'}): check the address and your connection`;
        }
    }
    if (!http && /Connection closed|-32000/.test(err.message)) return `${err.message} (the program stopped right after starting)`;
    return err.message;
}

// What a program that died on start printed, boiled down to its error: from the "Error: ..." line on (a stack ends in
// "}" and "Node.js v22", which says nothing), else the last few lines.
function crashSummary(stderr) {
    const lines = String(stderr || '').split('\n').map((l) => l.trim())
        .filter((l) => l && !/^(\^|\}|\{|Node\.js v[\d.]+|at )/.test(l) && !/^throw /.test(l));
    const at = lines.findIndex((l) => /\b\w*Error\b/.test(l));
    return (at >= 0 ? lines.slice(at, at + 3) : lines.slice(-3)).join(' ');
}

class McpManager {
    // `specs` (async, returns the {name: entry} object) replaces the file for a source that is not mcp-servers.json
    // (a user's servers in the database). `plain` turns off ${VAR} expansion, so an entry can't read this process's
    // environment; `vet` (async, throws) checks an entry before each connection.
    // `lazy` (a small hosted Machine): a stdio server's tool list is remembered next to the file, and the program itself
    // starts on its first call and stops again after idleMs, so Playwright's browser and the npx servers don't sit in memory.
    // `maxResultChars` caps a tool's text reply (Infinity for a server whose reply must arrive whole, as Headroom's does)
    constructor({ file = CONFIG_FILE, specs = null, plain = false, vet = null, lazy = false, idleMs = IDLE_CLOSE_MS, maxResultChars = MAX_RESULT_CHARS } = {}) {
        this.file = file;
        this.maxResultChars = maxResultChars;
        this.lazy = lazy;
        this.idleMs = idleMs;
        this.specsFn = specs;
        this.plain = plain;
        this.vet = vet;
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
            specs = await this.readSpecs();
            this.configError = null;
        } catch (err) {
            this.configError = `${path.basename(this.file)}: ${err.message}`;
            specs = {};
        }
        for (const [name, spec] of Object.entries(specs)) this.servers.set(name, this.entry(name, spec));
        await this.connectAll([...this.servers.values()].filter(s => s.status === 'connecting'));
        this.indexTools();
    }

    // Servers that download their program (npx, uvx, docker) connect one after another: started together they
    // fight over the network, the npm cache and a small Machine's CPU and memory, and every one of them times out.
    // The rest connect in parallel alongside.
    async connectAll(list) {
        if (this.lazy) list = this.fromCache(list);
        const queue = list.filter(s => isLauncher(s.spec));
        await Promise.all([
            ...list.filter(s => !isLauncher(s.spec)).map(s => this.connectKept(s)),
            (async () => { for (const s of queue) await this.connectKept(s); })(),
        ]);
    }

    // --- lazy mode ---
    get cacheFile() { return `${this.file}.tools.json`; }
    cacheKey(spec) { return JSON.stringify({ ...spec, disabledTools: undefined, askBefore: undefined }); }
    readCache() { try { return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch { return {}; } }
    writeCache(server) {
        try {
            const all = this.readCache();
            all[server.name] = { key: this.cacheKey(server.spec), tools: server.tools };
            fs.writeFileSync(this.cacheFile, JSON.stringify(all));
        } catch {}
    }
    // Servers with a remembered tool list are shown as connected without starting; the rest still connect once
    fromCache(list) {
        const cache = this.readCache();
        return list.filter((s) => {
            const hit = cache[s.name];
            if (transportType(s.spec) !== 'stdio' || !hit || hit.key !== this.cacheKey(s.spec)) return true;
            s.tools = hit.tools;
            s.status = 'connected';
            s.idle = true;
            return false;
        });
    }
    // connect(), then in lazy mode keep the tool list and stop the program until it is called
    async connectKept(server) {
        await this.connect(server);
        if (!this.lazy || server.status !== 'connected' || transportType(server.spec) !== 'stdio') return;
        this.writeCache(server);
        await this.sleep(server);
    }
    async sleep(server) {
        const client = server.client;
        server.client = null;
        server.idle = true;
        try { await client?.close(); } catch {}
    }
    // Start an idle server for a call, and schedule its stop
    async wake(server) {
        if (!server.waking) {
            server.waking = (async () => {
                const spec = this.plain ? server.spec : expand(server.spec);
                const { timeoutMs } = connectPolicy(spec);
                try {
                    await this.attempt(server, spec, timeoutMs);
                    server.idle = false;
                    this.writeCache(server);
                } catch (err) {
                    try { await server.client?.close(); } catch {}
                    server.client = null;
                    throw new Error(`MCP server ${server.name} did not start: ${describeFailure(err, spec, { timeoutMs, tries: 1 })}`);
                } finally { server.waking = null; }
            })();
        }
        return server.waking;
    }
    touch(server) {
        if (!this.lazy) return;
        clearTimeout(server.idleTimer);
        server.idleTimer = setTimeout(() => { if (server.client && !server.busy) this.sleep(server); }, this.idleMs);
        server.idleTimer.unref?.();
    }

    async readSpecs() {
        return this.specsFn ? this.specsFn() : readConfig(this.file);
    }

    entry(name, spec) {
        return { name, spec, type: transportType(spec), status: spec.disabled ? 'disabled' : 'connecting', tools: [] };
    }

    /**
     * Bring the running servers in line with the file after an edit: servers
     * that were removed or changed are closed, new or changed ones connect,
     * and untouched ones keep running. Tool switches (disabledTools) don't
     * restart a server.
     */
    async sync() {
        await this.start();
        let specs = {};
        try {
            specs = await this.readSpecs();
            this.configError = null;
        } catch (err) {
            this.configError = `${path.basename(this.file)}: ${err.message}`;
            return;
        }
        const restartKey = (spec) => JSON.stringify({ ...spec, disabledTools: undefined });
        const old = this.servers;
        this.servers = new Map();
        const fresh = [];
        for (const [name, spec] of Object.entries(specs)) {
            const had = old.get(name);
            if (had && restartKey(had.spec) === restartKey(spec)) {
                had.spec = spec;
                this.servers.set(name, had);
                old.delete(name);
                continue;
            }
            const next = this.entry(name, spec);
            this.servers.set(name, next);
            if (next.status === 'connecting') fresh.push(next);
        }
        await Promise.all([...old.values()].map(async (s) => {
            const client = s.client;
            s.client = null;
            try { await client?.close(); } catch {}
        }));
        await this.connectAll(fresh);
        this.indexTools();
    }

    // Try a server that isn't (yet) in the file: connect, list the tools, disconnect
    async probe(spec) {
        const server = this.entry('test', spec);
        const started = Date.now();
        await this.connect(server);
        const result = { ok: server.status === 'connected', error: server.error || null, tools: server.tools.map(t => ({ name: t.name, title: t.title || t.annotations?.title || t.name, description: t.description || '' })), ms: Date.now() - started };
        const client = server.client;
        server.client = null;
        try { await client?.close(); } catch {}
        return result;
    }

    async connect(server) {
        const missing = [];
        const spec = this.plain ? server.spec : expand(server.spec, missing);
        const { timeoutMs, retries } = connectPolicy(spec);
        let tries = 0;
        try {
            if (this.vet) await this.vet(spec);
            if (missing.length) throw new Error(`${[...new Set(missing)].map(n => '${' + n + '}').join(', ')} ${new Set(missing).size > 1 ? 'are' : 'is'} not set: add ${new Set(missing).size > 1 ? 'them' : 'it'} to .env, then restart the Interceptor and press Reload`);
            if (transportType(spec) === 'stdio' && spec.command && !onPath(spec.command)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            for (;;) {
                tries++;
                try {
                    await this.attempt(server, spec, timeoutMs);
                    break;
                } catch (err) {
                    const timedOut = err.code === -32001 || /timed out/i.test(err.message);
                    try { await server.client?.close(); } catch {}
                    server.client = null;
                    if (!timedOut || tries > retries) throw err;
                }
            }
        } catch (err) {
            server.status = 'failed';
            const message = describeFailure(err, spec, { timeoutMs, tries });
            const lines = crashSummary(server.stderr);
            server.error = lines && err.code !== 'ENOENT' ? `${message}: ${lines}` : message;
            try { await server.client?.close(); } catch {}
            server.client = null;
        }
    }

    // One go at connecting and listing the tools; throws on failure
    async attempt(server, spec, timeout) {
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const client = new Client({ name: 'custom-ai-harness', version: '1.0.0' });
        client.onerror = () => {};
        server.client = client;
        await client.connect(this.transport(server, spec), { timeout });
        const tools = [];
        let cursor;
        do {
            const page = await client.listTools(cursor ? { cursor } : {}, { timeout });
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
    }

    transport(server, spec) {
        const type = transportType(spec);
        if (type === 'stdio') {
            if (!spec.command) throw new Error('needs a "command" (or a "url" for an HTTP server)');
            const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
            const env = { ...launcherEnv(), ...process.env, ...(spec.env || {}) };
            delete env.NODE_TEST_CONTEXT;
            const transport = new StdioClientTransport({
                command: spec.command,
                args: spec.args || [],
                // the whole environment, as Claude Code does: npx needs the proxy, npm and Windows folder variables
                env,
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
            const off = new Set(server.spec.disabledTools || []);
            for (const tool of server.tools) {
                if (off.has(tool.name)) continue;
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
                tools: s.tools.filter(t => names.has(`${s.name}\0${t.name}`)).map(t => ({ name: names.get(`${s.name}\0${t.name}`), title: t.title || t.annotations?.title || t.name, description: t.description || '', needsApproval: askFirst(s.spec, t) })),
            })),
        };
    }

    // Each server's own tools, the switched-off ones included, for the Tools page
    allTools() {
        return new Map([...this.servers.values()].map(s => [s.name, s.tools.map(t => ({
            name: t.name,
            title: t.title || t.annotations?.title || t.name,
            description: t.description || '',
            enabled: !(s.spec.disabledTools || []).includes(t.name),
        }))]));
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

    // Does this tool wait for the person's Allow (the server's "askBefore" setting)?
    needsApproval(name) {
        const entry = this.byTool.get(name);
        return !!entry && askFirst(entry.server.spec, entry.tool);
    }

    async call(name, args, { confirmed = false } = {}) {
        const entry = this.byTool.get(name);
        if (!entry) throw new Error(`no MCP tool named ${name}`);
        const { server, tool } = entry;
        if (!confirmed && askFirst(server.spec, tool)) throw new Error(`${tool.name} needs the person's approval (server ${server.name} is set to ask first), but the page sent none`);
        if (!server.client && server.idle) await this.wake(server);
        if (!server.client) throw new Error(`MCP server ${server.name} is not connected`);
        server.busy = (server.busy || 0) + 1;
        let result;
        try {
            result = await server.client.callTool({ name: tool.name, arguments: args || {} }, undefined, { timeout: positive((this.plain ? server.spec : expand(server.spec)).callTimeoutMs) ?? CALL_TIMEOUT_MS });
        } finally { server.busy--; this.touch(server); }
        return { text: resultText(result, this.maxResultChars), isError: !!result.isError, server: server.name, tool: tool.name };
    }

    async close() {
        const servers = [...this.servers.values()];
        this.servers.clear();
        this.byTool.clear();
        this.loading = null;
        await Promise.all(servers.map(async (s) => {
            clearTimeout(s.idleTimer);
            const client = s.client;
            s.client = null;
            try { await client?.close(); } catch {}
        }));
    }
}

// "askBefore": "all" asks for every tool of the server; "writes" for every tool the server
// does not mark read-only (annotations.readOnlyHint), so an unmarked tool is treated as a change.
function askFirst(spec, tool) {
    if (spec.askBefore === 'all') return true;
    return spec.askBefore === 'writes' && tool.annotations?.readOnlyHint !== true;
}

module.exports = {
    onPath, INSTALL_HINTS, crashSummary, McpManager, readConfig, writeConfig, transportType, expand, toolName, resultText, connectPolicy, describeFailure, CONFIG_FILE };
