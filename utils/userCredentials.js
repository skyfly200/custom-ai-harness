// A person's own OpenRouter key, which pays for their requests. It sits in user_credentials, encrypted with
// ENCRYPTION_KEY (utils/secrets.js). kind 'oauth' came from "Connect OpenRouter" (utils/openrouterOAuth.js),
// kind 'key' was pasted.
'use strict';

const db = require('./db');
const secrets = require('./secrets');

const KEY_RE = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const TTL_MS = 60000;
const cache = new Map(); // owner -> { at, value }

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Save a key: `kind` is 'key' (pasted) or 'oauth' (from Connect OpenRouter). */
async function setKey(owner, key, kind = 'key') {
    const k = String(key || '').trim();
    if (!KEY_RE.test(k)) throw fail('that does not look like an OpenRouter key (they start with sk-or-)');
    if (!secrets.available()) throw fail('this server has no ENCRYPTION_KEY, so it cannot store a key', 503);
    await db.query(
        `INSERT INTO user_credentials (owner, kind, secret_enc, updated) VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner) DO UPDATE SET kind = EXCLUDED.kind, secret_enc = EXCLUDED.secret_enc, updated = EXCLUDED.updated`,
        [owner, kind === 'oauth' ? 'oauth' : 'key', secrets.encrypt(k), Date.now()]);
    cache.delete(owner);
}

async function remove(owner) {
    await db.query('DELETE FROM user_credentials WHERE owner = $1', [owner]);
    cache.delete(owner);
}

/** { kind: 'key', key } for the proxy, or null. Cached a minute. */
async function resolve(owner) {
    const hit = cache.get(owner);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const { rows } = await db.query('SELECT kind, secret_enc FROM user_credentials WHERE owner = $1', [owner]);
    const r = rows[0];
    let value = null;
    if (r && r.secret_enc && (r.kind === 'key' || r.kind === 'oauth')) value = { kind: 'key', key: secrets.decrypt(r.secret_enc) };
    cache.set(owner, { at: Date.now(), value });
    return value;
}

/** What the account page shows: whether there is one and which kind. Never the key. */
async function status(owner) {
    const { rows } = await db.query('SELECT kind, secret_enc, updated FROM user_credentials WHERE owner = $1', [owner]);
    if (!rows[0]) return { set: false };
    let last4 = null;
    try { last4 = rows[0].secret_enc ? secrets.decrypt(rows[0].secret_enc).slice(-4) : null; } catch { /* a key the current ENCRYPTION_KEY can't open */ }
    return { set: true, kind: rows[0].kind, last4, updated: Number(rows[0].updated) };
}

module.exports = { setKey, remove, resolve, status };
