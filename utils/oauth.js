// "Continue with Google / GitHub" through Neon Auth (managed Better Auth), invite-only.
//
// Neon Auth does the provider hand-off; the harness stays in charge of who may sign in:
//   GET /auth/<provider>   asks Neon for the provider's sign-in URL, keeps the challenge cookie
//                          Neon returns on the server (keyed by a short-lived harness_oauth cookie)
//                          and sends the browser on to the provider.
//   GET /auth/callback     Neon sends the browser back with ?neon_auth_session_verifier=...; the
//                          server swaps it (plus the kept cookie) for the session, reads the
//                          verified email, and starts a normal harness session only if that email
//                          is invited on the Users page or listed in HARNESS_ADMIN_EMAILS.
// Needs NEON_AUTH_BASE_URL. The public address (HARNESS_PUBLIC_URL, or the request's own host) must be a
// trusted domain in Neon Auth (`neon neon-auth domain add https://...`; localhost is trusted already).
const crypto = require('crypto');
const express = require('express');

const COOKIE = 'harness_oauth';
const TTL_MS = 10 * 60 * 1000;
const PROVIDERS = new Set(['google', 'github']);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function enabled(env = process.env) { return Boolean(env.NEON_AUTH_BASE_URL); }

// Which providers to offer: OAUTH_PROVIDERS="google,github" (default google; GitHub needs its own OAuth app in Neon)
function providers(env = process.env) {
    return String(env.OAUTH_PROVIDERS || 'google').split(/[,\s]+/).map((p) => p.trim().toLowerCase()).filter((p) => PROVIDERS.has(p));
}

function cookiesOf(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

// name=value pairs from Set-Cookie headers, as a Cookie header
function cookieHeaderFrom(setCookies) {
    return setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function createOAuth({ users, startSession, safeNext, env = process.env, fetchFn = fetch }) {
    const pending = new Map(); // nonce -> { cookie, next, expires }
    const base = () => String(env.NEON_AUTH_BASE_URL || '').replace(/\/+$/, '');
    const adminEmails = () => String(env.HARNESS_ADMIN_EMAILS || '').split(/[,\s]+/).filter(Boolean);
    const publicUrl = (req) => (env.HARNESS_PUBLIC_URL
        ? String(env.HARNESS_PUBLIC_URL).replace(/\/+$/, '')
        : `${(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()}://${req.headers['x-forwarded-host'] || req.headers.host}`);
    const sweep = () => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); };
    const fail = (res, message, status = 403) => res.status(status).set('cache-control', 'no-store').type('html').send(
        `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>`
        + `<p style="font:16px system-ui;padding:24px;max-width:480px">${esc(message)} <a href="/login">Back to sign in</a></p>`);

    const router = express.Router();

    router.get('/auth/callback', async (req, res) => {
        const verifier = String(req.query.neon_auth_session_verifier || '');
        const entry = pending.get(cookiesOf(req)[COOKIE]);
        res.append('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
        if (!verifier || !entry || entry.expires < Date.now()) return fail(res, 'That sign-in has expired or did not start here.', 400);
        pending.delete(cookiesOf(req)[COOKIE]);
        let session;
        try {
            const r = await fetchFn(`${base()}/get-session?neon_auth_session_verifier=${encodeURIComponent(verifier)}`, {
                headers: { cookie: entry.cookie, origin: entry.origin, accept: 'application/json' },
            });
            session = r.ok ? await r.json() : null;
        } catch { return fail(res, 'Could not reach the sign-in service. Try again.', 502); }
        const email = session && session.user && session.user.email;
        if (!email) return fail(res, 'The provider did not complete the sign-in.', 401);
        if (session.user.emailVerified === false) return fail(res, 'Your email address is not verified with that provider.');
        const user = users.forEmail(email, adminEmails());
        if (!user) return fail(res, `${email} has not been invited. Ask an admin to add it on the Users page.`);
        startSession(req, res, user.name);
        res.redirect(safeNext(entry.next));
    });

    router.get('/auth/:provider', async (req, res) => {
        const provider = req.params.provider;
        if (!enabled(env) || !providers(env).includes(provider)) return fail(res, 'That sign-in method is not available.', 404);
        const origin = publicUrl(req);
        let r;
        try {
            r = await fetchFn(`${base()}/sign-in/social`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin },
                body: JSON.stringify({ provider, callbackURL: `${origin}/auth/callback` }),
            });
        } catch { return fail(res, 'Could not reach the sign-in service. Try again.', 502); }
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.url) {
            const why = body && (body.code || body.error || body.message);
            return fail(res, `The sign-in service refused ${origin}${why ? ` (${why})` : ''}. An admin must trust that address with \`neon neon-auth domain add\`, or set HARNESS_PUBLIC_URL to the address people use.`, 502);
        }
        sweep();
        const nonce = crypto.randomBytes(24).toString('base64url');
        pending.set(nonce, { cookie: cookieHeaderFrom(r.headers.getSetCookie ? r.headers.getSetCookie() : []), origin, next: req.query.next, expires: Date.now() + TTL_MS });
        res.append('set-cookie', `${COOKIE}=${nonce}; Path=/; Max-Age=${TTL_MS / 1000}; HttpOnly; SameSite=Lax${origin.startsWith('https') ? '; Secure' : ''}`);
        res.redirect(body.url);
    });

    return router;
}

module.exports = { createOAuth, enabled, providers, cookieHeaderFrom, COOKIE };
