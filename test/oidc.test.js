// The harness as an OIDC issuer: discovery, JWKS, signed tokens a verifier accepts, and one person's
// federation through the proxy's token exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-oidc-'));
process.env.OIDC_ISSUER = 'https://agents.example.com/';
process.env.OIDC_KEY_FILE = path.join(dir, 'key.pem');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
const oidc = require('../utils/oidcIssuer');

const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');
const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
})();
db.query = async (t, p) => { await ready; return pg.query(t, p); };
const userCredentials = require('../utils/userCredentials');

// what OpenRouter would do: read the JWKS, check the RS256 signature and the claims
function verify(jwt, jwks, { iss, aud }) {
    const [h, b, s] = jwt.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url'));
    const jwk = jwks.keys.find((k) => k.kid === head.kid);
    assert.ok(jwk, 'key id is in the JWKS');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    const claims = JSON.parse(Buffer.from(b, 'base64url'));
    return ok && head.alg === 'RS256' && claims.iss === iss && claims.aud === aud && claims.exp > Date.now() / 1000 ? claims : null;
}

test('discovery and JWKS are public documents with the issuer address OpenRouter must match', async () => {
    const app = express();
    app.use(oidc.routes(express));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const d = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
        assert.equal(d.issuer, 'https://agents.example.com');
        assert.equal(d.jwks_uri, 'https://agents.example.com/.well-known/jwks.json');
        assert.deepEqual(d.id_token_signing_alg_values_supported, ['RS256']);
        const j = await (await fetch(`${base}/.well-known/jwks.json`)).json();
        assert.equal(j.keys.length, 1);
        assert.equal(j.keys[0].kty, 'RSA');
        assert.equal(j.keys[0].d, undefined, 'no private part');
        assert.equal(fs.statSync(process.env.OIDC_KEY_FILE).mode & 0o077, 0, 'the key file is private');
    } finally { server.close(); }
});

test('a minted token verifies against the published keys, and only for its subject and audience', () => {
    const jwt = oidc.mint({ subject: 'carol', audience: 'openrouter' });
    const claims = verify(jwt, oidc.jwks(), { iss: 'https://agents.example.com', aud: 'openrouter' });
    assert.equal(claims.sub, 'carol');
    assert.ok(claims.exp - claims.iat <= 300);
    assert.equal(verify(jwt, oidc.jwks(), { iss: 'https://agents.example.com', aud: 'other' }), null);
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: 'https://agents.example.com', sub: 'alice', aud: 'openrouter', exp: 9999999999 })).toString('base64url')}.${s}`;
    assert.equal(verify(forged, oidc.jwks(), { iss: 'https://agents.example.com', aud: 'openrouter' }), null);
    assert.throws(() => oidc.mint({ subject: '', audience: 'x' }), /subject/);
});

test('it will not sign for an address OpenRouter would refuse', () => {
    assert.match(oidc.problem({ OIDC_ISSUER: 'http://agents.example.com' }), /https/);
    assert.match(oidc.problem({}), /OIDC_ISSUER/);
    assert.equal(oidc.problem({ OIDC_ISSUER: 'https://agents.example.com' }), null);
    assert.throws(() => oidc.mint({ subject: 'a', audience: 'b', env: { OIDC_ISSUER: 'http://x.example.com' } }), /https/);
});

test('federation for one person: the harness signs, OpenRouter trades the token, the key is theirs and renews', async () => {
    await assert.rejects(userCredentials.setFederation('dan', 'bad id!'), /policy id/);
    await userCredentials.setFederation('dan', 'pol_123', 'my-audience');
    assert.deepEqual(await userCredentials.status('dan'), { set: true, kind: 'federation', policyId: 'pol_123', audience: 'my-audience', updated: (await userCredentials.status('dan')).updated });
    assert.equal(userCredentials.federationFacts('dan').subject, 'dan');

    // a stand-in OpenRouter: checks the subject token like the real one, then hands out an access token
    const exchanges = [];
    const orig = global.fetch;
    global.fetch = async (url, init) => {
        if (!String(url).endsWith('/oauth/token')) return orig(url, init);
        const form = new URLSearchParams(init.body);
        const claims = verify(form.get('subject_token'), oidc.jwks(), { iss: 'https://agents.example.com', aud: 'my-audience' });
        exchanges.push({ policy: form.get('federation_policy_id'), claims });
        return new Response(JSON.stringify(claims ? { access_token: `tok-${exchanges.length}`, expires_in: 900 } : { error: 'invalid_grant' }), { status: claims ? 200 : 400 });
    };
    try {
        assert.deepEqual(await userCredentials.resolve('dan'), { kind: 'federation', key: 'tok-1' });
        assert.deepEqual(await userCredentials.resolve('dan'), { kind: 'federation', key: 'tok-1' }, 'the token is reused until it nears its end');
        assert.equal(exchanges.length, 1);
        assert.equal(exchanges[0].policy, 'pol_123');
        assert.equal(exchanges[0].claims.sub, 'dan');
        // switching to a pasted key replaces federation
        await userCredentials.setKey('dan', 'sk-or-v1-dankeydankeydankey1234');
        assert.equal((await userCredentials.resolve('dan')).kind, 'key');
    } finally { global.fetch = orig; }
});
