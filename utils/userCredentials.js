// A person's own OpenRouter key, which pays for their requests. It sits in user_credentials, encrypted with
// ENCRYPTION_KEY (utils/secrets.js). kind 'oauth' came from "Connect OpenRouter" (utils/openrouterOAuth.js),
// kind 'key' was pasted, kind 'managed' was issued by the harness through the Management API (utils/openrouterKeys.js)
// and is replaced by it when it stops working.
'use strict';

const db = require('./db');
const secrets = require('./secrets');
const openrouterAuth = require('./openrouterAuth');
const keys = require('./openrouterKeys');

const KEY_RE = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const TTL_MS = 60000;
const cache = new Map(); // owner -> { at, value }
const bad = new Map();   // owner -> reason: OpenRouter answered 401 for their key since it was last saved
const health = new Map(); // owner -> { at, value }: the last GET /key check
const HEALTH_TTL_MS = 5 * 60000;
const EXPIRY_WARN_MS = 7 * 24 * 3600 * 1000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Save a key: `kind` is 'key' (pasted) or 'oauth' (from Connect OpenRouter). */
async function setKey(owner, key, kind = 'key', { hash = null, expires = null } = {}) {
    const k = String(key || '').trim();
    if (!KEY_RE.test(k)) throw fail('that does not look like an OpenRouter key (they start with sk-or-)');
    if (!secrets.available()) throw fail('this server has no ENCRYPTION_KEY, so it cannot store a key', 503);
    await db.query(
        `INSERT INTO user_credentials (owner, kind, secret_enc, updated, key_hash, expires) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner) DO UPDATE SET kind = EXCLUDED.kind, secret_enc = EXCLUDED.secret_enc, updated = EXCLUDED.updated,
             key_hash = EXCLUDED.key_hash, expires = EXCLUDED.expires`,
        [owner, kind === 'oauth' || kind === 'managed' ? kind : 'key', secrets.encrypt(k), Date.now(), hash, expires]);
    cache.delete(owner);
    bad.delete(owner);
    health.delete(owner);
}

async function remove(owner, opts = {}) {
    const { rows } = await db.query('SELECT kind, key_hash FROM user_credentials WHERE owner = $1', [owner]);
    // a key the harness issued is deleted at OpenRouter too, so it cannot go on spending
    if (rows[0]?.kind === 'managed' && rows[0].key_hash && keys.configured(opts.env)) await keys.revoke(rows[0].key_hash, opts).catch(() => {});
    await db.query('DELETE FROM user_credentials WHERE owner = $1', [owner]);
    cache.delete(owner);
    bad.delete(owner);
    health.delete(owner);
}

/**
 * Give `owner` a fresh harness-issued key (Management API) and delete the one it replaces. The new one is saved
 * before the old one goes, so a failure in between leaves them a working key.
 */
async function issue(owner, opts = {}) {
    if (!keys.configured(opts.env)) throw fail('set OPENROUTER_MANAGEMENT_KEY to issue keys', 503);
    if (!secrets.available()) throw fail('this server has no ENCRYPTION_KEY, so it cannot store a key', 503);
    const { rows } = await db.query('SELECT kind, key_hash FROM user_credentials WHERE owner = $1', [owner]);
    const made = await keys.create(owner, opts);
    await setKey(owner, made.key, 'managed', { hash: made.hash, expires: made.expires });
    if (rows[0]?.kind === 'managed' && rows[0].key_hash) await keys.revoke(rows[0].key_hash, opts).catch(() => {});
    return made;
}

const rotatedAt = new Map(); // owner -> ms of the last automatic replacement: at most one an hour
const ROTATE_GAP_MS = 3600000;

/** Replace a managed key that is refused, expired or about to expire. False when it is not managed, was just replaced, or the attempt failed. */
async function rotate(owner, opts = {}) {
    const now = (opts.now || Date.now)();
    if (!keys.configured(opts.env) || now - (rotatedAt.get(owner) || 0) < ROTATE_GAP_MS) return false;
    const { rows } = await db.query('SELECT kind FROM user_credentials WHERE owner = $1', [owner]);
    if (rows[0]?.kind !== 'managed') return false;
    rotatedAt.set(owner, now);
    try { await issue(owner, opts); return true; } catch { return false; }
}

/** The proxy saw OpenRouter refuse this person's key (401): remember it so the Users page asks them to reconnect. */
function markBad(owner, reason = 'OpenRouter no longer accepts this key', opts = {}) {
    bad.set(owner, reason);
    health.delete(owner);
    // a harness-issued key is replaced on the spot; the flag clears when the new one is saved
    rotate(owner, opts).catch(() => {});
}

/**
 * Is the stored key still good? Asks OpenRouter (GET /key, which answers for the key it is given) and says one of:
 * ok, expiring (expires_at within a week), expired, exhausted (limit_remaining 0), invalid (401/403), unknown (no
 * answer, or no key). Cached five minutes. OpenRouter has no way to renew a person's key, so anything but ok/unknown
 * means they press Reconnect.
 */
async function check(owner, { env = process.env, fetchFn = fetch, now = Date.now } = {}) {
    const hit = health.get(owner);
    if (hit && now() - hit.at < HEALTH_TTL_MS) return hit.value;
    const cred = await resolve(owner);
    let value = { state: 'unknown' };
    if (bad.has(owner)) value = { state: 'invalid', reason: bad.get(owner) };
    else if (cred) {
        try {
            const res = await fetchFn(`${openrouterAuth.apiRoot(env)}/v1/key`, {
                headers: { authorization: `Bearer ${cred.key}`, accept: 'application/json' },
                signal: AbortSignal.timeout(10000),
            });
            if (res.status === 401 || res.status === 403) {
                value = { state: 'invalid', reason: 'OpenRouter no longer accepts this key (revoked, deleted or expired)' };
                bad.set(owner, value.reason);
            } else if (res.ok) {
                const d = (await res.json().catch(() => ({}))).data || {};
                const expires = d.expires_at ? Date.parse(d.expires_at) : NaN;
                const left = typeof d.limit_remaining === 'number' ? d.limit_remaining : null;
                value = { state: 'ok', ...(Number.isFinite(expires) ? { expiresAt: expires } : {}), ...(left !== null ? { limitRemaining: left } : {}) };
                if (Number.isFinite(expires) && expires <= now()) value.state = 'expired';
                else if (Number.isFinite(expires) && expires - now() < EXPIRY_WARN_MS) value.state = 'expiring';
                else if (left !== null && left <= 0) value.state = 'exhausted';
            }
        } catch { /* unreachable: stay unknown, do not alarm anyone */ }
    }
    if ((['invalid', 'expired'].includes(value.state) || (value.state === 'expiring' && value.expiresAt - now() < 24 * 3600 * 1000)) && await rotate(owner, { env, fetchFn, now })) {
        value = { state: 'ok', rotated: true };
    }
    health.set(owner, { at: now(), value });
    return value;
}

/** { kind: 'key', key } for the proxy, or null. Cached a minute. */
async function resolve(owner) {
    const hit = cache.get(owner);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const { rows } = await db.query('SELECT kind, secret_enc FROM user_credentials WHERE owner = $1', [owner]);
    const r = rows[0];
    let value = null;
    if (r && r.secret_enc && (r.kind === 'key' || r.kind === 'oauth' || r.kind === 'managed')) value = { kind: 'key', key: secrets.decrypt(r.secret_enc) };
    cache.set(owner, { at: Date.now(), value });
    return value;
}

/** What the account page shows: whether there is one and which kind. Never the key. */
async function status(owner) {
    const { rows } = await db.query('SELECT kind, secret_enc, updated, expires FROM user_credentials WHERE owner = $1', [owner]);
    if (!rows[0]) return { set: false };
    let last4 = null;
    try { last4 = rows[0].secret_enc ? secrets.decrypt(rows[0].secret_enc).slice(-4) : null; } catch { /* a key the current ENCRYPTION_KEY can't open */ }
    return { set: true, kind: rows[0].kind, last4, updated: Number(rows[0].updated), ...(rows[0].expires ? { expires: Number(rows[0].expires) } : {}) };
}

/** Every person holding a harness-issued key; the hourly sweep checks each, which replaces the ones about to lapse. */
async function managedOwners() {
    const { rows } = await db.query("SELECT owner FROM user_credentials WHERE kind = 'managed'");
    return rows.map((r) => r.owner);
}

module.exports = { setKey, remove, resolve, status, check, markBad, issue, rotate, managedOwners };
