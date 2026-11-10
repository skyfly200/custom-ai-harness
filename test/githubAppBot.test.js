// The agent's own GitHub identity (a GitHub App installed on the repo). No network: GitHub is a stub fetch and the
// key pair is generated here, so the JWT is really signed and checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bot = require('../utils/githubAppBot');
const { openPullRequest } = require('../runner/github');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const env = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'), GITHUB_APP_SLUG: 'claude-agent' };
const EXPIRES = new Date(Date.now() + 60 * 60 * 1000).toISOString();

// a GitHub that has the app on skyfly200/custom-ai-harness (installation 42) and nowhere else
function fakeGitHub({ installed = true, tokenStatus = 201 } = {}) {
    const calls = [];
    const fetchFn = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', auth: opts.headers?.authorization || '' });
        const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
        if (url.endsWith('/repos/skyfly200/custom-ai-harness/installation')) return installed ? json(200, { id: 42 }) : json(404, { message: 'Not Found' });
        if (url.endsWith('/app/installations/42/access_tokens')) return tokenStatus === 201 ? json(201, { token: 'ghs_app_token', expires_at: EXPIRES }) : json(tokenStatus, { message: 'no' });
        return json(404, {});
    };
    return { calls, fetchFn };
}

test.beforeEach(() => bot.resetBotCache());

test('no bot is used unless the app is set up: no calls, no identity', async () => {
    const gh = fakeGitHub();
    assert.equal(bot.appConfig({}), null);
    assert.equal(await bot.botToken({ owner: 'skyfly200', name: 'custom-ai-harness' }, { env: {}, fetchFn: gh.fetchFn }), null);
    assert.equal(gh.calls.length, 0);
});

test('the app signs a real JWT and turns it into an installation token that is named after the app', async () => {
    const gh = fakeGitHub();
    const got = await bot.botToken({ owner: 'skyfly200', name: 'custom-ai-harness' }, { env, fetchFn: gh.fetchFn, now: Date.now() });
    assert.equal(got.token, 'ghs_app_token');
    assert.equal(got.login, 'claude-agent[bot]');
    // the JWT GitHub was asked with verifies against the app's public key, and names the app
    const jwt = gh.calls[0].auth.replace('Bearer ', '');
    const [h, p, s] = jwt.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, '12345');
});

test('the installation token is reused until it nears its end, not fetched again for every PR', async () => {
    const gh = fakeGitHub();
    const repo = { owner: 'skyfly200', name: 'custom-ai-harness' };
    await bot.botToken(repo, { env, fetchFn: gh.fetchFn });
    await bot.botToken(repo, { env, fetchFn: gh.fetchFn });
    assert.equal(gh.calls.filter((c) => c.url.includes('access_tokens')).length, 1);
});

test('a repo the app is not installed on gets no identity, so the person\'s token is used', async () => {
    const gh = fakeGitHub({ installed: false });
    assert.equal(await bot.botToken({ owner: 'someone', name: 'else' }, { env, fetchFn: gh.fetchFn }), null);
});

test('a pull request is opened as the app, and falls back to the person when the app may not open it', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        const remote = 'https://github.com/skyfly200/custom-ai-harness.git';
        const git = async (args) => (args[0] === 'remote' ? `${remote}\n` : '');
        // the app opens it: the POST carries the app's token
        let gh = fakeGitHub();
        const fetchAs = async (url, opts = {}) => {
            if (url.endsWith('/pulls') && opts.method === 'POST') {
                const auth = opts.headers.authorization;
                if (gh.appDenied && auth === 'Bearer ghs_app_token') return { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible' }) };
                return { ok: true, status: 201, json: async () => ({ number: 9, html_url: 'https://github.com/skyfly200/custom-ai-harness/pull/9' }) };
            }
            return gh.fetchFn(url, opts);
        };
        const pushes = [];
        const gitPush = async (args, o) => { if (args.includes('push')) pushes.push(o.token); return git(args); };
        const pr = await openPullRequest({ dir: '/x', branch: 'harness/a1', token: 'user-token', title: 't', git: gitPush, fetchImpl: fetchAs });
        assert.equal(pr.number, 9);
        assert.equal(pushes[0], 'user-token', 'pushing stays with the person');
        // the app is refused: the same PR is opened with the person's token
        gh = fakeGitHub();
        gh.appDenied = true;
        bot.resetBotCache();
        const seen = [];
        const recording = async (url, opts) => { if (url.endsWith('/pulls') && opts?.method === 'POST') seen.push(opts.headers.authorization); return fetchAs(url, opts); };
        const pr2 = await openPullRequest({ dir: '/x', branch: 'harness/a2', token: 'user-token', title: 't', git: gitPush, fetchImpl: recording });
        assert.equal(pr2.number, 9);
        assert.deepEqual(seen, ['Bearer ghs_app_token', 'Bearer user-token']);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        bot.resetBotCache();
    }
});
