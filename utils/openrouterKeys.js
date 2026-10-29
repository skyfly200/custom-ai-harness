// OpenRouter's Management API (https://openrouter.ai/docs/guides/overview/auth/management-api-keys): with a
// management key (OPENROUTER_MANAGEMENT_KEY, a server secret in .env) the harness creates and deletes API keys
// under the owner's account, each with its own spending limit. Those keys bill the owner, so issuing one is an
// admin act (utils/userCredentials.js issue). The management key never reaches a browser, a log or an error text.
'use strict';

const openrouterAuth = require('./openrouterAuth');

const trim = (v) => String(v || '').trim();
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

const managementKey = (env = process.env) => trim(env.OPENROUTER_MANAGEMENT_KEY);
const configured = (env = process.env) => Boolean(managementKey(env));
/** USD limit for each issued key (OPENROUTER_USER_KEY_LIMIT, default 5) and days until it expires (unset: no expiry). */
const limitUsd = (env = process.env) => { const n = Number(env.OPENROUTER_USER_KEY_LIMIT); return Number.isFinite(n) && n > 0 ? n : 5; };
const lifetimeDays = (env = process.env) => { const n = Number(env.OPENROUTER_USER_KEY_DAYS); return Number.isFinite(n) && n > 0 ? n : 0; };

async function call(method, path, body, { env = process.env, fetchFn = fetch } = {}) {
    const mk = managementKey(env);
    if (!mk) throw fail('OPENROUTER_MANAGEMENT_KEY is not set', 503);
    let res;
    try {
        res = await fetchFn(`${openrouterAuth.apiRoot(env)}/v1/keys${path}`, {
            method,
            headers: { authorization: `Bearer ${mk}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        throw fail(`OpenRouter did not answer: ${err.message}`);
    }
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw fail(`OpenRouter refused the key request (HTTP ${res.status}): ${json.error?.message || json.error || text.slice(0, 200)}`);
    return json;
}

/** Make a key named for `owner`. Resolves { key, hash, expires } (expires: ms since 1970, or null). The secret comes back only now. */
async function create(owner, opts = {}) {
    const env = opts.env || process.env;
    const now = (opts.now || Date.now)();
    const days = lifetimeDays(env);
    const expires = days ? now + days * 24 * 3600 * 1000 : null;
    const json = await call('POST', '', {
        name: `harness: ${owner}`,
        ...(opts.noLimit ? {} : { limit: limitUsd(env) }),
        ...(expires ? { expires_at: new Date(expires).toISOString().replace(/\.\d+Z$/, 'Z') } : {}),
    }, opts);
    const key = json.data?.key || json.key;
    const hash = json.data?.hash || json.hash;
    if (typeof key !== 'string' || !key || typeof hash !== 'string' || !hash) throw fail('OpenRouter answered without a key and hash');
    return { key, hash, expires };
}

/** Delete a key by its hash. A key already gone (404) counts as deleted. */
async function revoke(hash, opts = {}) {
    try { await call('DELETE', `/${encodeURIComponent(hash)}`, null, opts); } catch (err) {
        if (!/HTTP 404/.test(err.message)) throw err;
    }
}

module.exports = { configured, limitUsd, lifetimeDays, create, revoke };
