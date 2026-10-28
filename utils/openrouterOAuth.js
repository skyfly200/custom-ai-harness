// "Connect OpenRouter": OpenRouter's OAuth PKCE flow (https://openrouter.ai/docs/guides/overview/auth/oauth).
// begin() makes a code verifier and sends the person to openrouter.ai/auth with its S256 challenge and our
// callback address. OpenRouter comes back with ?code=; finish() trades code + verifier at
// POST /api/v1/auth/keys for an API key that belongs to that person's own account. The caller stores the key
// (utils/userCredentials.js). The verifier waits in memory for 10 minutes: one Fly machine, no extra table.
'use strict';

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;
const pending = new Map(); // state -> { owner, verifier, callback, expires }

const site = (env) => String(env.OPENROUTER_SITE_URL || 'https://openrouter.ai').replace(/\/+$/, '');
const apiBase = (env) => String(env.OPENROUTER_URL || `${site(env)}/api/v1`).replace(/\/+$/, '');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function sweep(now) {
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

/** The address to send the person to, for `owner`. `callback` is where OpenRouter returns them (our own address). */
function begin({ owner, callback, env = process.env, now = Date.now }) {
    if (!owner) throw fail('no one is signed in');
    let u;
    try { u = new URL(callback); } catch { throw fail('the callback address is not a web address'); }
    if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw fail('OpenRouter sends people back only to https addresses (or localhost): set HARNESS_PUBLIC_URL');
    sweep(now());
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    pending.set(state, { owner, verifier, callback: u.href, expires: now() + TTL_MS });
    // OpenRouter hands back only ?code=, so our state rides on the callback address itself
    u.searchParams.set('state', state);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(`${site(env)}/auth`);
    url.searchParams.set('callback_url', u.href);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
}

/** Trade the code for the person's key. State is single use and must belong to `owner`. Resolves { key, userId }. */
async function finish({ owner, state, code, env = process.env, fetchFn = fetch, now = Date.now }) {
    const p = pending.get(String(state || ''));
    pending.delete(String(state || ''));
    if (!p || p.expires < now()) throw fail('that sign-in link expired: press Connect OpenRouter again');
    if (p.owner !== owner) throw fail('that sign-in was started by someone else', 403);
    if (!code) throw fail('OpenRouter did not send a code');
    let res;
    try {
        res = await fetchFn(`${apiBase(env)}/auth/keys`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: 'S256' }),
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        throw fail(`OpenRouter did not answer: ${err.message}`, 502);
    }
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw fail(`OpenRouter refused the code (HTTP ${res.status}): ${json.error?.message || json.error || text.slice(0, 200)}`, 502);
    if (typeof json.key !== 'string' || !json.key) throw fail('OpenRouter answered without a key', 502);
    return { key: json.key, userId: json.user_id || null };
}

module.exports = { begin, finish, _pending: pending };
