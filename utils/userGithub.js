// A person's own GitHub token for hosted Runs (a fine-grained personal access token with Contents read/write
// on the repos they want agents to work in). Pasted on the Agents page, checked against GitHub once, stored
// encrypted (utils/secrets.js). The Interceptor hands it to the task runner for one request at a time (clone,
// fetch, push); the runner never stores it and it never goes into a sandbox.
'use strict';

const db = require('./db');
const secrets = require('./secrets');

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
        `INSERT INTO user_github (owner, login, secret_enc, updated) VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner) DO UPDATE SET login = EXCLUDED.login, secret_enc = EXCLUDED.secret_enc, updated = EXCLUDED.updated`,
        [owner, login, secrets.encrypt(t), Date.now()]);
    return { login };
}

const remove = (owner) => db.query('DELETE FROM user_github WHERE owner = $1', [owner]);

/** The token, or null. */
async function resolve(owner) {
    const { rows } = await db.query('SELECT secret_enc FROM user_github WHERE owner = $1', [owner]);
    return rows[0] ? secrets.decrypt(rows[0].secret_enc) : null;
}

/** What the page shows: whether there is one and whose. Never the token. */
async function status(owner) {
    const { rows } = await db.query('SELECT login, updated FROM user_github WHERE owner = $1', [owner]);
    return rows[0] ? { set: true, login: rows[0].login, updated: Number(rows[0].updated) } : { set: false };
}

module.exports = { setToken, remove, resolve, status };
