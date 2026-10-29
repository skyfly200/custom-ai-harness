// A person's own GitHub token, used by hosted Runs and by chats linked to a GitHub repo. Either "Connect GitHub"
// (utils/githubOAuth.js) or a fine-grained personal access token with Contents read/write pasted on the Agents
// page; one row per person, checked against GitHub once, stored encrypted (utils/secrets.js). The Interceptor hands it to the task runner for one request at a time (clone,
// fetch, push); the runner never stores it and it never goes into a sandbox.
'use strict';

const db = require('./db');
const secrets = require('./secrets');
const githubOAuth = require('./githubOAuth');

const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function whoami(token) {
    const res = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'custom-ai-harness' },
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw fail('GitHub did not accept that token');
    if (!res.ok) throw fail(`GitHub answered HTTP ${res.status}`, 502);
    return (await res.json()).login;
}

/** Check the token with GitHub (`lookup` is replaceable for tests) and store it. Resolves { login }. */
async function setToken(owner, token, lookup = whoami) {
    const t = String(token || '').trim();
    if (!TOKEN_RE.test(t)) throw fail('that does not look like a GitHub token');
    if (!secrets.available()) throw fail('this server has no ENCRYPTION_KEY, so it cannot store a token', 503);
    const login = await lookup(t);
    await db.query(
        `INSERT INTO user_github (owner, login, secret_enc, updated, via, refresh_enc, expires) VALUES ($1, $2, $3, $4, 'token', NULL, 0)
         ON CONFLICT (owner) DO UPDATE SET login = EXCLUDED.login, secret_enc = EXCLUDED.secret_enc, updated = EXCLUDED.updated,
             via = 'token', refresh_enc = NULL, expires = 0`,
        [owner, login, secrets.encrypt(t), Date.now()]);
    return { login };
}

/** Store what "Connect GitHub" returned ({ token, refresh, expiresIn }). `lookup` is replaceable for tests. Resolves { login }. */
async function setOAuth(owner, { token, refresh, expiresIn }, lookup = whoami) {
    if (!secrets.available()) throw fail('this server has no ENCRYPTION_KEY, so it cannot store a token', 503);
    const login = await lookup(token);
    const now = Date.now();
    await db.query(
        `INSERT INTO user_github (owner, login, secret_enc, updated, via, refresh_enc, expires) VALUES ($1, $2, $3, $4, 'oauth', $5, $6)
         ON CONFLICT (owner) DO UPDATE SET login = EXCLUDED.login, secret_enc = EXCLUDED.secret_enc, updated = EXCLUDED.updated,
             via = 'oauth', refresh_enc = EXCLUDED.refresh_enc, expires = EXCLUDED.expires`,
        [owner, login, secrets.encrypt(token), now, refresh ? secrets.encrypt(refresh) : null, expiresIn ? now + expiresIn * 1000 : 0]);
    return { login };
}

const remove = (owner) => db.query('DELETE FROM user_github WHERE owner = $1', [owner]);

const renewing = new Map(); // owner -> promise, so two requests do not both spend one refresh token

async function renew(owner, row, refreshFn) {
    try {
        const got = await refreshFn(secrets.decrypt(row.refresh_enc));
        const now = Date.now();
        await db.query('UPDATE user_github SET secret_enc = $2, refresh_enc = $3, expires = $4, updated = $5 WHERE owner = $1',
            [owner, secrets.encrypt(got.token), got.refresh ? secrets.encrypt(got.refresh) : row.refresh_enc, got.expiresIn ? now + got.expiresIn * 1000 : 0, now]);
        return got.token;
    } finally { renewing.delete(owner); }
}

/** The token, or null. A GitHub App token about to run out is renewed first (`refreshFn` is replaceable for tests). */
async function resolve(owner, refreshFn = (r) => githubOAuth.refresh(r)) {
    const { rows } = await db.query('SELECT secret_enc, refresh_enc, expires FROM user_github WHERE owner = $1', [owner]);
    const row = rows[0];
    if (!row) return null;
    if (row.refresh_enc && Number(row.expires) && Number(row.expires) < Date.now() + 60000) {
        if (!renewing.has(owner)) renewing.set(owner, renew(owner, row, refreshFn));
        try { return await renewing.get(owner); } catch (err) { console.warn(`GitHub token refresh failed for ${owner}: ${err.message}`); return null; }
    }
    return secrets.decrypt(row.secret_enc);
}

/** What the page shows: whether there is one and whose. Never the token. */
async function status(owner) {
    const { rows } = await db.query('SELECT login, updated, via FROM user_github WHERE owner = $1', [owner]);
    return rows[0] ? { set: true, login: rows[0].login, updated: Number(rows[0].updated), via: rows[0].via } : { set: false };
}

module.exports = { setToken, setOAuth, remove, resolve, status };
