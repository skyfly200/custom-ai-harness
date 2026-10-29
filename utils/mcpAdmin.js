// The Tools page's side of MCP servers: checking an entry before it is written
// to mcp-servers.json, and showing entries without their secrets.
'use strict';

const { transportType } = require('./mcp');

const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const TYPES = new Set(['stdio', 'http', 'sse']);
const MASK = '••••••';
// a ${NAME} reference is a pointer into .env, not a secret
const isRef = (v) => /\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/.test(v);

function fail(message) {
    throw Object.assign(new Error(message), { status: 400 });
}

// The address with literal query values hidden; ${NAME} references stay readable
function maskUrl(url) {
    try {
        const u = new URL(url);
        if (!u.search && !u.username && !u.password) return url;
        for (const [k, v] of [...u.searchParams]) if (!isRef(v)) u.searchParams.set(k, MASK);
        u.username = u.username && MASK;
        u.password = u.password && MASK;
        return decodeURIComponent(u.toString());
    } catch {
        return url;
    }
}

function maskMap(map) {
    return Object.entries(map || {}).map(([key, value]) => (isRef(String(value)) ? { key, value: String(value) } : { key, secret: true }));
}

/** A server entry as the Tools page gets it: literal env and header values are not sent. */
function describeSpec(spec) {
    const out = { ...spec };
    out.type = transportType(spec);
    if (spec.url) out.url = maskUrl(spec.url);
    out.env = maskMap(spec.env);
    out.headers = maskMap(spec.headers);
    return out;
}

// Rows from the page: { key, value } sets a value; { key, keep: true } keeps the stored one
function mergeMap(rows, stored, label) {
    if (rows === undefined || rows === null) return undefined;
    if (!Array.isArray(rows)) fail(`${label} must be a list`);
    const out = {};
    for (const row of rows) {
        const key = String(row?.key ?? '').trim();
        if (!key) continue;
        if (out[key] !== undefined) fail(`${label} lists ${key} twice`);
        if (row.keep) {
            if (stored?.[key] === undefined) fail(`${label} ${key} has no saved value to keep: type one`);
            out[key] = stored[key];
        } else {
            if (typeof row.value !== 'string') fail(`${label} ${key} needs a value`);
            out[key] = row.value;
        }
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * Turn what the page sent into a server entry. `old` is the entry being edited
 * (kept values, keys this page doesn't know). Throws a 400 with a plain message.
 */
function buildSpec(input, old = {}) {
    if (!input || typeof input !== 'object') fail('send the server as an object');
    const type = input.type || 'stdio';
    if (!TYPES.has(type)) fail('type must be stdio, http or sse');
    const spec = { ...old };
    for (const k of ['command', 'args', 'cwd', 'type', 'url', 'env', 'headers', 'timeoutMs', 'retries', 'callTimeoutMs', 'askBefore']) delete spec[k];

    if (type === 'stdio') {
        const command = String(input.command ?? '').trim();
        if (!command) fail('a stdio server needs a command (for example npx or uvx)');
        spec.command = command;
        const args = input.args ?? [];
        if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) fail('arguments must be a list of text');
        if (args.length) spec.args = args;
        const cwd = String(input.cwd ?? '').trim();
        if (cwd) spec.cwd = cwd;
        const env = mergeMap(input.env, old.env, 'environment variable');
        if (env) spec.env = env;
    } else {
        const url = String(input.url ?? '').trim();
        if (!url) fail('an HTTP or SSE server needs a url');
        // a masked address that came back unchanged keeps the real one
        if (old.url && url === maskUrl(old.url)) spec.url = old.url;
        else {
            try {
                const u = new URL(url);
                if (!/^https?:$/.test(u.protocol)) throw new Error('not http');
            } catch {
                fail('the url must start with http:// or https://');
            }
            spec.url = url;
        }
        spec.type = type;
        const headers = mergeMap(input.headers, old.headers, 'header');
        if (headers) spec.headers = headers;
    }
    for (const k of ['timeoutMs', 'callTimeoutMs']) {
        if (input[k] === undefined || input[k] === null || input[k] === '') continue;
        if (!(Number(input[k]) > 0)) fail(`${k} must be a number above 0`);
        spec[k] = Number(input[k]);
    }
    if (input.retries !== undefined && input.retries !== null && input.retries !== '') {
        if (!Number.isInteger(Number(input.retries)) || Number(input.retries) < 0) fail('retries must be 0 or more');
        spec.retries = Number(input.retries);
    }
    if (input.askBefore !== undefined && input.askBefore !== null && input.askBefore !== '') {
        if (input.askBefore !== 'writes' && input.askBefore !== 'all') fail('askBefore must be writes, all or empty');
        spec.askBefore = input.askBefore;
    }
    if (input.disabled !== undefined) {
        if (input.disabled) spec.disabled = true;
        else delete spec.disabled;
    }
    return spec;
}

function checkName(name) {
    if (!NAME.test(String(name || ''))) fail('the name is 1 to 40 letters, digits, dots, dashes or underscores');
    return name;
}

module.exports = { buildSpec, describeSpec, maskUrl, checkName };
