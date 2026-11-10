// scripts/headroom-sprite.mjs: the pure parts (token, service request, host env). The Sprites
// calls need a live token and are not run here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'headroom-sprite.mjs')).href);

test('a new token is long, random and hex', async () => {
    const { newToken } = await load();
    const a = newToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, newToken());
});

test('setup refuses a missing or short HEADROOM_PROXY_TOKEN', async () => {
    const { tokenFrom } = await load();
    assert.throws(() => tokenFrom({}), /HEADROOM_PROXY_TOKEN/);
    assert.throws(() => tokenFrom({ HEADROOM_PROXY_TOKEN: 'short' }), /16 characters/);
    assert.equal(tokenFrom({ HEADROOM_PROXY_TOKEN: '  0123456789abcdef  ' }), '0123456789abcdef');
});

test('the service runs the proxy on 8787, bound to all interfaces, with the token set on it', async () => {
    const { serviceRequest, PORT } = await load();
    const req = serviceRequest('0123456789abcdef');
    assert.equal(PORT, 8787);
    assert.equal(req.httpPort, 8787);
    assert.deepEqual(req.args, ['proxy', '--host', '0.0.0.0', '--port', '8787']);
    assert.equal(req.env.HEADROOM_PROXY_TOKEN, '0123456789abcdef');
    assert.match(req.cmd, /\/bin\/headroom$/);
});

test('the host env lines name the sprite URL and the token, with a longer timeout for a cold wake', async () => {
    const { hostEnv } = await load();
    const out = hostEnv({ url: 'https://harness-headroom.example.sprites.app/', token: 'tok123456789abcdef' });
    assert.match(out, /^HEADROOM_URL=https:\/\/harness-headroom\.example\.sprites\.app$/m);
    assert.match(out, /^HEADROOM_API_KEY=tok123456789abcdef$/m);
    assert.match(out, /^HEADROOM_TIMEOUT_MS=8000$/m);
});
