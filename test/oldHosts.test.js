const test = require('node:test');
const assert = require('node:assert');
const { oldHostsRedirect } = require('../utils/oldHosts');

const run = (env, host, path = '/ui/chat.html?x=1', extra = {}) => {
    const out = {};
    const req = { method: 'GET', headers: { host, ...(extra.accept ? { accept: extra.accept } : {}) }, path: path.split('?')[0], originalUrl: path, ...(extra.method ? { method: extra.method } : {}) };
    const res = {
        redirect: (code, url) => { out.code = code; out.url = url; },
        status(c) { out.code = c; return this; },
        type() { return this; },
        send(body) { out.body = body; },
    };
    oldHostsRedirect(env)(req, res, () => { out.next = true; });
    return out;
};
const env = { HARNESS_PUBLIC_URL: 'https://ai.skylerfly.com/', HARNESS_OLD_HOSTS: 'agents.skylerfly.com, Old.example.com' };

test('old host redirects with 308 to the public address', () => {
    assert.deepStrictEqual(run(env, 'agents.skylerfly.com'), { code: 308, url: 'https://ai.skylerfly.com/ui/chat.html?x=1' });
    assert.strictEqual(run(env, 'old.example.com:443').code, 308);
    assert.strictEqual(run(env, 'agents.skylerfly.com', '/v1/messages', { method: 'POST', accept: 'text/html' }).code, 308);
});
test('old host answers browser page loads with a 200 page that forwards', () => {
    const r = run(env, 'agents.skylerfly.com', '/ui/chat.html?x=1', { accept: 'text/html,application/xhtml+xml,*/*' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.url, undefined);
    assert.match(r.body, /content="0;url=https:\/\/ai\.skylerfly\.com\/ui\/chat\.html\?x=1"/);
    assert.match(r.body, /location\.replace\("https:\/\/ai\.skylerfly\.com\/ui\/chat\.html\?x=1"\)/);
});
test('new host, health check and unset config pass through', () => {
    assert.ok(run(env, 'ai.skylerfly.com').next);
    assert.ok(run(env, 'agents.skylerfly.com', '/healthz').next);
    assert.ok(run({ HARNESS_PUBLIC_URL: env.HARNESS_PUBLIC_URL }, 'agents.skylerfly.com').next);
});
