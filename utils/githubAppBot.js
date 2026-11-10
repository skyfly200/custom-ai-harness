// The agent's own GitHub identity: a GitHub App installed on the repo. Pull requests opened with its
// installation token are authored by "<app slug>[bot]", not by the person, so they do not look as if
// the person wrote them. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (the app's PEM key, \n allowed) and
// GITHUB_APP_SLUG. Without them, or for a repo the app is not installed on, botToken() resolves null
// and the caller keeps using the person's own token. No dependency: the JWT is signed with node:crypto.
'use strict';

const crypto = require('crypto');

const API = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const cache = new Map(); // "owner/name" -> { token, expiresAt, login }
const installations = new Map(); // "owner/name" -> installation id
const REFRESH_MS = 5 * 60 * 1000; // a token is renewed this long before GitHub says it ends

/** The app's settings from the environment, or null when the app is not set up here. */
function appConfig(env = process.env) {
    const appId = String(env.GITHUB_APP_ID || '').trim();
    const key = String(env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
    const slug = String(env.GITHUB_APP_SLUG || '').trim();
    if (!appId || !key || !slug) return null;
    return { appId, key, slug };
}

/** A JWT that GitHub accepts as the app itself (valid for ten minutes, issued a minute in the past). */
function appJwt({ appId, key }, now = Date.now()) {
    const iat = Math.floor(now / 1000) - 60;
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key);
    return `${head}.${body}.${b64u(sig)}`;
}

async function call(url, { method = 'GET', jwt, fetchFn = fetch }) {
    const res = await fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'custom-ai-harness' },
        signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

/**
 * The bot's identity for a repo: { token, login, expiresAt } with an installation token for it, or null when the app
 * is not configured, is not installed on the repo, or GitHub refuses. Never throws: a null means "use the person's token".
 * `fetchFn` and `now` are injectable for tests.
 */
async function botToken({ owner, name }, { env = process.env, fetchFn = fetch, now = Date.now() } = {}) {
    const cfg = appConfig(env);
    if (!cfg || !owner || !name) return null;
    const repo = `${owner}/${name}`.toLowerCase();
    const hit = cache.get(repo);
    if (hit && hit.expiresAt - REFRESH_MS > now) return hit;
    try {
        const jwt = appJwt(cfg, now);
        let id = installations.get(repo);
        if (!id) {
            const found = await call(`${API()}/repos/${owner}/${name}/installation`, { jwt, fetchFn });
            if (!found.ok || !found.data.id) return null;
            id = found.data.id;
            installations.set(repo, id);
        }
        const made = await call(`${API()}/app/installations/${id}/access_tokens`, { method: 'POST', jwt, fetchFn });
        if (!made.ok || !made.data.token) { installations.delete(repo); return null; }
        const entry = { token: made.data.token, login: `${cfg.slug}[bot]`, expiresAt: Date.parse(made.data.expires_at) || now + 50 * 60 * 1000 };
        cache.set(repo, entry);
        return entry;
    } catch {
        return null;
    }
}

/** Forget the cached tokens and installations (tests, or after the app is reinstalled). */
function resetBotCache() { cache.clear(); installations.clear(); }

module.exports = { appConfig, appJwt, botToken, resetBotCache };
