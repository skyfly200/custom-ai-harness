// OpenRouter credentials. Either a static OPENROUTER_API_KEY, or workload
// identity federation: the harness trades a JWT from your own identity
// provider for a short-lived OpenRouter access token (RFC 8693 token exchange,
// POST {OPENROUTER_URL}/oauth/token) and swaps in a fresh one before it expires.
// https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation
//
// Federation is on when OPENROUTER_FEDERATION_POLICY_ID is set, plus one place
// to read the identity provider's JWT from:
//   OPENROUTER_FEDERATION_TOKEN_FILE     file holding the JWT, read on every exchange
//                                        (a Kubernetes projected token, a CI-written file)
//   OPENROUTER_FEDERATION_TOKEN_URL      GET returns the JWT, bare or as JSON
//                                        ({"token"|"value"|"id_token"|"access_token": "..."})
//   OPENROUTER_FEDERATION_TOKEN_HEADERS  optional, for the URL: "Name: value; Name2: value2"
//                                        (GCP metadata: Metadata-Flavor: Google)
//   OPENROUTER_FEDERATION_TOKEN_COMMAND  command that prints the JWT
// With federation on, OPENROUTER_API_KEY is not used.
const fs = require('fs');
const { execFile } = require('child_process');

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
const SKEW_MS = 60 * 1000;            // renew a minute before the token runs out
const MIN_LIFETIME_MS = 30 * 1000;    // never treat a token as lasting less than this

const trim = (v) => String(v || '').trim();

function settings(env = process.env) {
    const base = trim(env.OPENROUTER_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    return {
        base,
        policyId: trim(env.OPENROUTER_FEDERATION_POLICY_ID),
        file: trim(env.OPENROUTER_FEDERATION_TOKEN_FILE),
        url: trim(env.OPENROUTER_FEDERATION_TOKEN_URL),
        headers: trim(env.OPENROUTER_FEDERATION_TOKEN_HEADERS),
        command: trim(env.OPENROUTER_FEDERATION_TOKEN_COMMAND),
    };
}

const federated = (env = process.env) => Boolean(settings(env).policyId);

/** What's missing from the federation settings, as sentences; [] when fine or when federation is off. */
function problems(env = process.env) {
    const s = settings(env);
    if (!s.policyId) return [];
    const sources = [s.file, s.url, s.command].filter(Boolean).length;
    if (sources === 0) return ['OPENROUTER_FEDERATION_POLICY_ID is set but nothing says where the identity provider\'s JWT comes from: set OPENROUTER_FEDERATION_TOKEN_FILE, _URL or _COMMAND'];
    if (sources > 1) return ['Set only one of OPENROUTER_FEDERATION_TOKEN_FILE, _URL and _COMMAND'];
    return [];
}

function parseHeaders(text) {
    const out = {};
    for (const part of String(text || '').split(/;|\n/)) {
        const i = part.indexOf(':');
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

/** The JWT text from a response body: bare, or JSON with a token field. */
function jwtFrom(text) {
    const body = trim(text);
    if (body.startsWith('{')) {
        let json;
        try { json = JSON.parse(body); } catch { throw new Error('the identity provider answered with broken JSON'); }
        const found = json.token || json.value || json.id_token || json.access_token;
        if (typeof found !== 'string' || !found) throw new Error('the identity provider\'s answer has no token, value, id_token or access_token field');
        return found.trim();
    }
    return body;
}

function readSubjectToken(s, { fetchFn = fetch, run = execFile } = {}) {
    if (s.file) {
        return fs.promises.readFile(s.file, 'utf8').then(jwtFrom, (err) => { throw new Error(`can't read OPENROUTER_FEDERATION_TOKEN_FILE: ${err.message}`); });
    }
    if (s.url) {
        return fetchFn(s.url, { headers: parseHeaders(s.headers), signal: AbortSignal.timeout(10000) }).then(async (res) => {
            if (!res.ok) throw new Error(`OPENROUTER_FEDERATION_TOKEN_URL answered HTTP ${res.status}`);
            return jwtFrom(await res.text());
        });
    }
    return new Promise((resolve, reject) => {
        run(s.command, { shell: true, timeout: 15000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
            if (err) return reject(new Error(`OPENROUTER_FEDERATION_TOKEN_COMMAND failed: ${err.message}`));
            try { resolve(jwtFrom(stdout)); } catch (e) { reject(e); }
        });
    });
}

/**
 * Make a key source. key() resolves to the string to send as "Bearer <key>"
 * ('' when nothing is configured), exchanging and renewing tokens as needed.
 * opts: env, fetchFn, run, now (for tests). `policyId` and `subject` (async, returns the JWT) make a
 * federation of their own, apart from the environment: the harness's own issuer, for one person.
 */
function createAuth(opts = {}) {
    const env = opts.env || process.env;
    const fetchFn = opts.fetchFn || fetch;
    const now = opts.now || Date.now;
    let cached = null;     // { token, expiresAt }
    let pending = null;    // exchange in flight, shared by concurrent callers
    let failedAt = 0, failure = null;

    const own = Boolean(opts.policyId && opts.subject);
    const isFederated = () => own || federated(env);

    async function exchange() {
        const s = settings(env);
        if (own) s.policyId = opts.policyId;
        const subject = own ? await opts.subject() : await readSubjectToken(s, { fetchFn, run: opts.run });
        if (!subject) throw new Error('the identity provider\'s JWT is empty');
        const body = new URLSearchParams({
            grant_type: GRANT,
            subject_token_type: JWT_TYPE,
            federation_policy_id: s.policyId,
            subject_token: subject,
        });
        let res;
        for (let attempt = 0; attempt < 2; attempt++) {
            res = await fetchFn(`${s.base}/oauth/token`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body,
                signal: AbortSignal.timeout(15000),
            });
            if (res.status !== 503) break; // 503: the issuer's keys weren't reachable; once more
            await new Promise((r) => setTimeout(r, opts.retryMs ?? 1000));
        }
        const text = await res.text();
        let json = {};
        try { json = JSON.parse(text); } catch {}
        if (!res.ok) {
            const why = json.error_description || json.error || text.slice(0, 200) || `HTTP ${res.status}`;
            throw new Error(`OpenRouter refused the token exchange (HTTP ${res.status}): ${why}`);
        }
        if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('OpenRouter\'s token exchange answered without an access_token');
        const lifetime = Math.max(MIN_LIFETIME_MS, (Number(json.expires_in) || 900) * 1000);
        cached = { token: json.access_token, expiresAt: now() + lifetime };
        return cached.token;
    }

    async function key() {
        if (!isFederated()) return trim(env.OPENROUTER_API_KEY);
        const bad = own ? [] : problems(env);
        if (bad.length) throw new Error(bad[0]);
        if (cached && now() < cached.expiresAt - SKEW_MS) return cached.token;
        // After a failure don't hammer the identity provider or OpenRouter (429s): wait 5 s
        if (failure && now() - failedAt < 5000) throw failure;
        if (!pending) {
            pending = exchange().then(
                (token) => { failure = null; return token; },
                (err) => { failure = err; failedAt = now(); throw err; },
            ).finally(() => { pending = null; });
        }
        return pending;
    }

    /** Forget the cached token (OpenRouter answered 401 for it before its expiry): the next key() exchanges again. */
    function invalidate() { cached = null; failure = null; }

    /** { mode: 'federation'|'key'|'none', ok, expiresInSec?, error? }, for the dashboard and logs. Never the token. */
    function status() {
        if (!isFederated()) return { mode: trim(env.OPENROUTER_API_KEY) ? 'key' : 'none', ok: Boolean(trim(env.OPENROUTER_API_KEY)) };
        const bad = own ? [] : problems(env);
        if (bad.length) return { mode: 'federation', ok: false, error: bad[0] };
        const live = cached && now() < cached.expiresAt;
        return {
            mode: 'federation',
            ok: Boolean(live) || !failure,
            ...(live ? { expiresInSec: Math.round((cached.expiresAt - now()) / 1000) } : {}),
            ...(failure ? { error: failure.message } : {}),
        };
    }

    const configured = () => isFederated() || Boolean(trim(env.OPENROUTER_API_KEY));
    return { key, status, configured, invalidate };
}

// ---- The local door for programs that only know a static key (the Gateway, the Router) ----

/** The key those programs send to the harness's /openrouter-proxy; '' means the door is shut. */
const proxyKey = (env = process.env) => trim(env.OPENROUTER_PROXY_KEY) || trim(env.LITELLM_MASTER_KEY);

/** OpenRouter's API root without /v1, e.g. https://openrouter.ai/api (the Router's base_url is that). */
const apiRoot = (env = process.env) => settings(env).base.replace(/\/v1$/, '');

const crypto = require('crypto');
const ticket = require('./credentialTicket');
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();

/**
 * Express handler for /openrouter-proxy/<path>: forwards to OpenRouter with a
 * fresh token in place of the caller's key. Mount it before the harness
 * password gate; the callers (Gateway, Router) prove themselves with proxyKey().
 * A call may carry a credential ticket (utils/credentialTicket.js): 'user' tickets get that person's own
 * credential from `resolveUser(name)` (null: they have none, answered 402); 'shared' tickets and calls
 * with no ticket (the Router) use the owner's.
 */
function proxyHandler(auth, { env = process.env, fetchFn = fetch, resolveUser = null, onBadCredential = null } = {}) {
    const { Readable } = require('stream');
    return async function openrouterProxy(req, res) {
        const want = proxyKey(env);
        const given = String(req.headers.authorization || '').replace(/^bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
        if (!want) return res.status(503).json({ error: 'set OPENROUTER_PROXY_KEY (or LITELLM_MASTER_KEY) in .env to use federation' });
        if (!given || !crypto.timingSafeEqual(digest(given), digest(want))) return res.status(401).json({ error: 'wrong key for the OpenRouter proxy' });
        let token, ownerOfToken = null;
        const sentTicket = req.headers[ticket.HEADER];
        if (sentTicket !== undefined) {
            const t = ticket.verify(want, sentTicket);
            if (!t) return res.status(401).json({ error: { message: 'bad or expired credential ticket' } });
            if (t.kind === 'user') {
                let cred = null;
                try { cred = resolveUser ? await resolveUser(t.user) : null; } catch (err) {
                    return res.status(502).json({ error: { message: `your OpenRouter credential could not be read: ${err.message}` } });
                }
                if (!cred || !cred.key) return res.status(402).json({ error: { message: 'You have not added your own OpenRouter credential. Add it on the Users page, then try again.' } });
                token = cred.key;
                ownerOfToken = t.user;
            }
        }
        try {
            if (!token) token = await auth.key();
        } catch (err) {
            return res.status(502).json({ error: { message: `OpenRouter sign-in failed: ${err.message}` } });
        }
        if (!token) return res.status(503).json({ error: { message: 'no OpenRouter credentials: set OPENROUTER_API_KEY or the OPENROUTER_FEDERATION_* settings' } });
        const rest = req.originalUrl.replace(/^\/openrouter-proxy/, '');
        const headers = { authorization: `Bearer ${token}` };
        for (const h of ['content-type', 'accept', 'http-referer', 'x-title']) if (req.headers[h]) headers[h] = req.headers[h];
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        try {
            const upstream = await fetchFn(apiRoot(env) + rest, {
                method: req.method, headers, signal: controller.signal,
                ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
            });
            if (upstream.status === 401) {
                // The key was refused. A person's own: say so plainly and flag it; the install's token: drop it so the next call exchanges again.
                if (ownerOfToken) {
                    if (onBadCredential) onBadCredential(ownerOfToken);
                    controller.abort();
                    return res.status(401).json({ error: { code: 'openrouter_reconnect', message: 'OpenRouter no longer accepts your connected key. Open the Users page and press Reconnect OpenRouter, then try again.' } });
                }
                if (auth.invalidate) auth.invalidate();
            }
            res.status(upstream.status);
            for (const h of ['content-type', 'cache-control', 'retry-after']) {
                const v = upstream.headers.get(h);
                if (v) res.set(h, v);
            }
            if (!upstream.body) return res.end();
            Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
        } catch (err) {
            if (!res.headersSent) res.status(502).json({ error: { message: `OpenRouter unreachable: ${err.message}` } });
            else res.end();
        }
    };
}

module.exports = { createAuth, federated, problems, settings, jwtFrom, parseHeaders, proxyKey, apiRoot, proxyHandler };
