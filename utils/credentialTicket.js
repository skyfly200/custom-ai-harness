// A ticket tells /openrouter-proxy whose credential a call from the Gateway is for. The Interceptor
// puts one in the request's extra_headers; the Gateway passes it on to the proxy; the proxy checks the
// signature (HMAC with the proxy key, which only the harness, Gateway and Router know) and swaps in that
// person's credential. A client can't make one, and the Interceptor overwrites any extra_headers it sent.
'use strict';

const crypto = require('crypto');

const HEADER = 'x-harness-credential';
const LIFETIME_MS = 25 * 60 * 1000;

const sign = (key, body) => crypto.createHmac('sha256', key).update(body).digest('base64url');

/** kind 'user' (the person's own credential) or 'shared' (the owner's key, for admins and guests). */
function mint(key, { user = '', kind = 'user' }, now = Date.now()) {
    const body = Buffer.from(JSON.stringify({ u: user, k: kind, e: now + LIFETIME_MS })).toString('base64url');
    return `v1.${body}.${sign(key, body)}`;
}

/** { user, kind } or null for a missing, forged or expired ticket. */
function verify(key, ticket, now = Date.now()) {
    const [v, body, mac] = String(ticket || '').split('.');
    if (v !== 'v1' || !body || !mac) return null;
    const want = Buffer.from(sign(key, body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!(p.e > now) || (p.k !== 'user' && p.k !== 'shared')) return null;
        return { user: String(p.u || ''), kind: p.k };
    } catch { return null; }
}

module.exports = { mint, verify, HEADER };
