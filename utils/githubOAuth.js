// "Connect GitHub": GitHub's web OAuth flow for the harness's own GitHub App (recommended: a person grants
// Contents, Pull requests and Issues on only the repos they pick) or an OAuth App (scope "repo", every repo
// the person can reach). Both use the same two URLs. begin() sends the person to github.com with a state;
// GitHub returns ?code=&state=; finish() trades the code (with the client secret) for a user token. A GitHub
// App's token expires after 8 hours and comes with a refresh token; refresh() renews it. The pending state
// waits in memory for 10 minutes: one Fly machine, no extra table. The caller stores the tokens (utils/userGithub.js).
'use strict';

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;
const pending = new Map(); // state -> { owner, callback, back, expires }
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const site = (env) => String(env.GITHUB_URL || 'https://github.com').replace(/\/+$/, '');
const configured = (env = process.env) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
/** A GitHub App (GITHUB_APP_SLUG set) rather than an OAuth App. */
const isApp = (env = process.env) => Boolean(env.GITHUB_APP_SLUG);
/** Where a person picks which repos a GitHub App may reach. */
const installUrl = (env = process.env) => (isApp(env) ? `${site(env)}/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new` : null);

function sweep(now) {
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

/** The github.com address to send `owner` to. `callback` is our own address GitHub returns them to. */
function begin({ owner, callback, back, env = process.env, now = Date.now }) {
    if (!owner) throw fail('no one is signed in');
    if (!configured(env)) throw fail('GitHub sign-in is not set up on this server: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET', 503);
    let u;
    try { u = new URL(callback); } catch { throw fail('the callback address is not a web address'); }
    sweep(now());
    const state = crypto.randomBytes(24).toString('base64url');
    pending.set(state, { owner, callback: u.href, back: back || null, expires: now() + TTL_MS });
    const url = new URL(`${site(env)}/login/oauth/authorize`);
    url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', u.href);
    url.searchParams.set('state', state);
    if (!isApp(env)) url.searchParams.set('scope', env.GITHUB_OAUTH_SCOPE || 'repo');
    return url.href;
}

async function tokenRequest(params, { env, fetchFn }) {
    let res;
    try {
        res = await fetchFn(`${site(env)}/login/oauth/access_token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'custom-ai-harness' },
            body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        throw fail(`GitHub did not answer: ${err.message}`, 502);
    }
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (!res.ok || json.error) throw fail(`GitHub refused (${json.error_description || json.error || `HTTP ${res.status}`})`, 502);
    if (typeof json.access_token !== 'string' || !json.access_token) throw fail('GitHub answered without a token', 502);
    return {
        token: json.access_token,
        refresh: typeof json.refresh_token === 'string' ? json.refresh_token : null,
        expiresIn: Number(json.expires_in) > 0 ? Number(json.expires_in) : 0,
    };
}

/** Trade the code for the person's token. State is single use and must belong to `owner`. Resolves { token, refresh, expiresIn }. */
async function finish({ owner, state, code, env = process.env, fetchFn = fetch, now = Date.now }) {
    const p = pending.get(String(state || ''));
    pending.delete(String(state || ''));
    if (!p || p.expires < now()) throw fail('that sign-in link expired: press Connect GitHub again');
    if (p.owner !== owner) throw fail('that sign-in was started by someone else', 403);
    if (!code) throw fail('GitHub did not send a code (was the request declined?)');
    return { ...(await tokenRequest({ code, redirect_uri: p.callback }, { env, fetchFn })), back: p.back };
}

/** A new access token from a refresh token (GitHub Apps). Resolves { token, refresh, expiresIn }. */
const refresh = (refreshToken, { env = process.env, fetchFn = fetch } = {}) =>
    tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, { env, fetchFn });

module.exports = { configured, isApp, installUrl, begin, finish, refresh, _pending: pending };
