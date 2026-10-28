// A person's own OpenRouter credential, which pays for their requests. A pasted key sits in
// user_credentials, encrypted with ENCRYPTION_KEY (utils/secrets.js). Or federation, which stores no
// secret: just the id of an OpenRouter policy that trusts this harness's issuer (utils/oidcIssuer.js).
// The harness signs a token for the person, OpenRouter trades it for a 15-minute key (utils/openrouterAuth.js).
'use strict';

const db = require('./db');
const secrets = require('./secrets');
const oidc = require('./oidcIssuer');
const { createAuth } = require('./openrouterAuth');

const KEY_RE = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const TTL_MS = 60000;
const cache = new Map(); // owner -> { at, value }
const auths = new Map(); // `${owner}\0${policy}\0${audience}` -> a token source that renews itself
const POLICY_RE = /^[A-Za-z0-9_.:-]{3,100}$/;
const AUDIENCE_RE = /^[\x21-\x7e]{1,200}$/;
const defaultAudience = () => process.env.OIDC_AUDIENCE || 'openrouter';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function setKey(owner, key) {
    const k = String(key || '').trim();
    if (!KEY_RE.test(k)) throw fail('that does not look like an OpenRouter key (they start with sk-or-)');
    if (!secrets.available()) throw fail('this server has no ENCRYPTION_KEY, so it cannot store a key', 503);
    await db.query(
        `INSERT INTO user_credentials (owner, kind, secret_enc, updated) VALUES ($1, 'key', $2, $3)
         ON CONFLICT (owner) DO UPDATE SET kind = 'key', secret_enc = EXCLUDED.secret_enc, updated = EXCLUDED.updated`,
        [owner, secrets.encrypt(k), Date.now()]);
    cache.delete(owner);
}

/** Use federation: `policyId` is the id from OpenRouter's Workload identity page; `audience` what that policy expects. */
async function setFederation(owner, policyId, audience) {
    const policy = String(policyId || '').trim();
    const aud = String(audience || '').trim() || defaultAudience();
    if (!POLICY_RE.test(policy)) throw fail('that is not a policy id: copy it from OpenRouter, Settings, Workload identity');
    if (!AUDIENCE_RE.test(aud)) throw fail('the audience must be plain text without spaces');
    const bad = oidc.problem();
    if (bad) throw fail(`this server can't sign tokens yet: ${bad}`, 503);
    await db.query(
        `INSERT INTO user_credentials (owner, kind, secret_enc, policy_id, audience, updated) VALUES ($1, 'federation', NULL, $2, $3, $4)
         ON CONFLICT (owner) DO UPDATE SET kind = 'federation', secret_enc = NULL, policy_id = EXCLUDED.policy_id, audience = EXCLUDED.audience, updated = EXCLUDED.updated`,
        [owner, policy, aud, Date.now()]);
    cache.delete(owner);
}

/** What the person puts into OpenRouter to trust this harness for them. */
function federationFacts(owner) {
    return { issuer: oidc.issuer(), subject: owner, audience: defaultAudience(), problem: oidc.problem() };
}

async function remove(owner) {
    await db.query('DELETE FROM user_credentials WHERE owner = $1', [owner]);
    cache.delete(owner);
}

/** { kind: 'key', key } for the proxy, or null. Cached a minute. */
async function resolve(owner) {
    const hit = cache.get(owner);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const { rows } = await db.query('SELECT kind, secret_enc, policy_id, audience FROM user_credentials WHERE owner = $1', [owner]);
    const r = rows[0];
    if (r && r.kind === 'federation') {
        // not cached: the auth below caches its own token, and a changed policy must apply at once
        const id = `${owner}\0${r.policy_id}\0${r.audience}`;
        if (!auths.has(id)) {
            auths.set(id, createAuth({ policyId: r.policy_id, subject: async () => oidc.mint({ subject: owner, audience: r.audience || defaultAudience() }) }));
            if (auths.size > 500) auths.delete(auths.keys().next().value);
        }
        return { kind: 'federation', key: await auths.get(id).key() };
    }
    let value = null;
    if (r && r.kind === 'key' && r.secret_enc) value = { kind: 'key', key: secrets.decrypt(r.secret_enc) };
    cache.set(owner, { at: Date.now(), value });
    return value;
}

/** What the account page shows: whether there is one and which kind. Never the key. */
async function status(owner) {
    const { rows } = await db.query('SELECT kind, secret_enc, policy_id, audience, updated FROM user_credentials WHERE owner = $1', [owner]);
    if (!rows[0]) return { set: false };
    if (rows[0].kind === 'federation') return { set: true, kind: 'federation', policyId: rows[0].policy_id, audience: rows[0].audience, updated: Number(rows[0].updated) };
    let last4 = null;
    try { last4 = rows[0].secret_enc ? secrets.decrypt(rows[0].secret_enc).slice(-4) : null; } catch { /* a key the current ENCRYPTION_KEY can't open */ }
    return { set: true, kind: rows[0].kind, last4, updated: Number(rows[0].updated) };
}

module.exports = { setKey, setFederation, federationFacts, remove, resolve, status };
