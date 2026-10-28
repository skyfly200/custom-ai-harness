// The harness as a small OpenID Connect issuer, so OpenRouter workload identity federation can trust it:
// it publishes /.well-known/openid-configuration and a JWKS, and signs short RS256 JWTs for people
// (iss = the harness's https address, sub = the person, aud = what their OpenRouter policy expects).
// OpenRouter fetches the keys to check a token, then trades it for a 15-minute access token
// (utils/openrouterAuth.js does the trade). The private key is OIDC_PRIVATE_KEY (PEM, "\n" allowed) or a
// file (OIDC_KEY_FILE, default data/oidc-key.pem, made on first use with mode 0600). Lose it and every
// policy keeps working once the new public key is published, since OpenRouter reads the JWKS each time.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LIFETIME_S = 300; // a token only has to live long enough to be traded
let cached = null;

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The address OpenRouter must see as `iss`: OIDC_ISSUER, else HARNESS_PUBLIC_URL; https only, no trailing slash. */
function issuer(env = process.env) {
    const raw = String(env.OIDC_ISSUER || env.HARNESS_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    return raw;
}

/** Why this can't issue tokens, as a sentence, or null. */
function problem(env = process.env) {
    const iss = issuer(env);
    if (!iss) return 'set OIDC_ISSUER (or HARNESS_PUBLIC_URL) to this server\'s https address';
    let u;
    try { u = new URL(iss); } catch { return 'OIDC_ISSUER is not a web address'; }
    if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return 'OpenRouter requires an https issuer address';
    if (u.search || u.hash) return 'the issuer address must have no query or fragment';
    return null;
}

function loadKey(env = process.env) {
    if (cached && cached.env === env) return cached;
    let pem = String(env.OIDC_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
    if (!pem) {
        const file = env.OIDC_KEY_FILE || path.join(env.HARNESS_DATA_DIR || path.join(__dirname, '..', 'data'), 'oidc-key.pem');
        try {
            pem = fs.readFileSync(file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, pem, { mode: 0o600 });
        }
    }
    const privateKey = crypto.createPrivateKey(pem);
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    // RFC 7638 thumbprint as the key id
    const kid = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url');
    cached = { env, privateKey, jwks: { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }, kid };
    return cached;
}

const jwks = (env = process.env) => loadKey(env).jwks;

function discovery(env = process.env) {
    const iss = issuer(env);
    return {
        issuer: iss,
        jwks_uri: `${iss}/.well-known/jwks.json`,
        response_types_supported: ['id_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        claims_supported: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti'],
    };
}

/** A signed JWT for `subject`, meant for `audience`. */
function mint({ subject, audience, env = process.env, now = Date.now() }) {
    const bad = problem(env);
    if (bad) throw new Error(`can't sign tokens: ${bad}`);
    if (!subject || !audience) throw new Error('a token needs a subject and an audience');
    const k = loadKey(env);
    const iat = Math.floor(now / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: k.kid });
    const body = b64({ iss: issuer(env), sub: String(subject), aud: String(audience), iat, nbf: iat - 10, exp: iat + LIFETIME_S, jti: crypto.randomBytes(12).toString('base64url') });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), k.privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}

/** Express handlers for the two public documents. Mount before any login gate. */
function routes(express, env = process.env) {
    const r = express.Router();
    const guard = (fn) => (req, res) => {
        const bad = problem(env);
        if (bad) return res.status(503).json({ error: bad });
        try { res.set('cache-control', 'public, max-age=300').json(fn()); } catch (err) { res.status(500).json({ error: err.message }); }
    };
    r.get('/.well-known/openid-configuration', guard(() => discovery(env)));
    r.get('/.well-known/jwks.json', guard(() => jwks(env)));
    return r;
}

const reset = () => { cached = null; };

module.exports = { issuer, problem, jwks, discovery, mint, routes, reset };
