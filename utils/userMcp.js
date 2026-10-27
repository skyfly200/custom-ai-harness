// Each signed-in person's own MCP servers, for a hosted harness. Only remote (http/sse) servers:
// a stdio server is a program run on this machine, which a non-admin must never be able to start.
// Entries sit in the user_mcp table, encrypted whole (utils/secrets.js), and each person gets their
// own McpManager, so one person's servers and tools are never offered to or callable by another.
// ${VAR} references are not expanded for these (they could read the server's secrets), and an address
// that points at this machine or a private network is refused (see checkRemoteUrl).
'use strict';

const dns = require('dns').promises;
const net = require('net');
const db = require('./db');
const secrets = require('./secrets');
const { McpManager } = require('./mcp');
const mcpAdmin = require('./mcpAdmin');
const catalog = require('./mcpCatalog');

const MAX_SERVERS = 20;
const IDLE_MS = 15 * 60 * 1000;
const MAX_MANAGERS = 50;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// loopback, private, link-local, carrier-grade NAT, unique-local (Fly's private network is fdaa::/16), multicast, unspecified
function isPrivateIp(ip) {
    if (net.isIPv6(ip)) {
        const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
        if (v4) return isPrivateIp(v4[1]);
        const l = ip.toLowerCase();
        return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
    }
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
}

const BAD_HOST = /(^|\.)(localhost|local|internal|localdomain|lan|home)$/i;

/**
 * Throws unless `url` is an http(s) address on the public internet. Names are resolved and every
 * address checked. A name that resolves differently later (DNS rebinding) is not caught here: the
 * address is checked again before each connection, but the connection does its own lookup.
 */
async function checkRemoteUrl(url, lookup = (h) => dns.lookup(h, { all: true })) {
    let u;
    try { u = new URL(url); } catch { throw fail('that is not a web address'); }
    if (!/^https?:$/.test(u.protocol)) throw fail('the address must start with http:// or https://');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (BAD_HOST.test(host) || !host) throw fail('that address is on this machine or a private network, which is not allowed');
    if (net.isIP(host)) {
        if (isPrivateIp(host)) throw fail('that address is on this machine or a private network, which is not allowed');
        return;
    }
    let found;
    try { found = await lookup(host); } catch { throw fail(`could not find ${host}: check the address`); }
    if (!found.length || found.some((a) => isPrivateIp(a.address))) throw fail('that address is on this machine or a private network, which is not allowed');
}

/** buildSpec for a person: remote servers only. */
function buildUserSpec(input, old = {}) {
    const type = input && typeof input === 'object' ? input.type || 'http' : 'http';
    if (type !== 'http' && type !== 'sse') throw fail('you can add remote servers only (type http or sse); programs that run on this machine are for admins');
    return mcpAdmin.buildSpec({ ...input, type }, old);
}

/** The catalog entries a person may add: remote ones. */
const remoteCatalog = () => catalog.filter((c) => c.spec && c.spec.url);

const available = () => db.enabled() && secrets.available();

async function readAll(owner) {
    const { rows } = await db.query('SELECT name, spec_enc FROM user_mcp WHERE owner = $1 ORDER BY updated, name', [owner]);
    const out = {};
    for (const r of rows) {
        try { out[r.name] = JSON.parse(secrets.decrypt(r.spec_enc)); } catch { /* a row the current key can't open is skipped, not shown */ }
    }
    return out;
}

// Make the stored set equal `servers`: upsert what changed, delete what's gone
async function writeAll(owner, servers, before) {
    const names = Object.keys(servers);
    if (names.length > MAX_SERVERS) throw fail(`at most ${MAX_SERVERS} servers each`);
    for (const name of Object.keys(before)) {
        if (!(name in servers)) await db.query('DELETE FROM user_mcp WHERE owner = $1 AND name = $2', [owner, name]);
    }
    const now = Date.now();
    for (const [i, name] of names.entries()) {
        if (JSON.stringify(before[name]) === JSON.stringify(servers[name])) continue;
        await db.query(
            `INSERT INTO user_mcp (owner, name, spec_enc, updated) VALUES ($1, $2, $3, $4)
             ON CONFLICT (owner, name) DO UPDATE SET spec_enc = EXCLUDED.spec_enc, updated = EXCLUDED.updated`,
            [owner, name, secrets.encrypt(JSON.stringify(servers[name])), now + i]);
    }
}

class UserMcp {
    constructor() {
        this.managers = new Map(); // owner -> { mgr, last }
        this.timer = setInterval(() => this.sweep(), 60000);
        this.timer.unref();
    }
    manager(owner) {
        let m = this.managers.get(owner);
        if (!m) {
            if (this.managers.size >= MAX_MANAGERS) this.evict();
            m = { mgr: new McpManager({ file: 'your account', specs: () => readAll(owner), plain: true, vet: (spec) => checkRemoteUrl(spec.url) }) };
            this.managers.set(owner, m);
        }
        m.last = Date.now();
        return m.mgr;
    }
    evict() {
        const [oldest] = [...this.managers].sort((a, b) => a[1].last - b[1].last);
        if (oldest) this.drop(oldest[0]);
    }
    drop(owner) {
        const m = this.managers.get(owner);
        this.managers.delete(owner);
        return m ? m.mgr.close() : undefined;
    }
    sweep() {
        for (const [owner, m] of this.managers) if (Date.now() - m.last > IDLE_MS) this.drop(owner);
    }
    async closeAll() {
        clearInterval(this.timer);
        await Promise.all([...this.managers.keys()].map((o) => this.drop(o)));
    }
    read(owner) { return readAll(owner); }
    write(owner, servers, before) { return writeAll(owner, servers, before); }
}

module.exports = { UserMcp, checkRemoteUrl, buildUserSpec, remoteCatalog, isPrivateIp, available, MAX_SERVERS };
