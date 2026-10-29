const test = require('node:test');
const assert = require('node:assert');
const { oldHostsRedirect } = require('../utils/oldHosts');

const run = (env, host, path = '/ui/chat.html?x=1') => {
    const out = {};
    const req = { headers: { host }, path: path.split('?')[0], originalUrl: path };
    const res = { redirect: (code, url) => { out.code = code; out.url = url; } };
    oldHostsRedirect(env)(req, res, () => { out.next = true; });
    return out;
};
const env = { HARNESS_PUBLIC_URL: 'https://ai.skylerfly.com/', HARNESS_OLD_HOSTS: 'agents.skylerfly.com, Old.example.com' };

test('old host redirects with 308 to the public address', () => {
    assert.deepStrictEqual(run(env, 'agents.skylerfly.com'), { code: 308, url: 'https://ai.skylerfly.com/ui/chat.html?x=1' });
    assert.strictEqual(run(env, 'old.example.com:443').code, 308);
});
test('new host, health check and unset config pass through', () => {
    assert.ok(run(env, 'ai.skylerfly.com').next);
    assert.ok(run(env, 'agents.skylerfly.com', '/healthz').next);
    assert.ok(run({ HARNESS_PUBLIC_URL: env.HARNESS_PUBLIC_URL }, 'agents.skylerfly.com').next);
});
