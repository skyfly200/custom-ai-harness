// Runs on a shared (hosted) server: owners, GitHub repos, limits, the push, and the Interceptor-side pieces
process.env.DATABASE_URL = 'postgres://unused';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.E2B_API_KEY = 'test-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PGlite } = require('@electric-sql/pglite');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hosted-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const { RunManager } = require('../runner/runs');
const { createApp } = require('../runner/server');
const github = require('../runner/github');
const runnerAuth = require('../utils/runnerAuth');
const { RunKeys } = require('../utils/runKeys');
const db = require('../utils/db');
const userGithub = require('../utils/userGithub');

const reposBase = path.join(dir, 'repos');
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// A stand-in for GitHub access: "cloning" makes a real one-commit repo; every call is remembered with the token it got
const calls = [];
const fakeGit = {
    ...github,
    ensureClone: async ({ base, person, spec, token }) => {
        const d = github.cloneDir(base, person, github.parse(spec));
        calls.push({ what: 'clone', person, spec, token });
        if (!fs.existsSync(path.join(d, '.git'))) {
            fs.mkdirSync(d, { recursive: true });
            gitIn(d, 'init', '-q'); gitIn(d, 'config', 'user.email', 't@e.com'); gitIn(d, 'config', 'user.name', 'T');
            fs.writeFileSync(path.join(d, 'a.txt'), 'x'); gitIn(d, 'add', '-A'); gitIn(d, 'commit', '-q', '-m', 'start');
        }
        return d;
    },
    openPullRequest: async ({ dir: d, branch, token, title, body, base }) => { calls.push({ what: 'pr', dir: d, branch, token, title, body, base }); return { number: 7, url: 'https://github.com/o/r/pull/7', base: base || 'main', pushed: { branch, url: 'u', compare: 'c' } }; },
    pushBranch: async ({ dir: d, branch, token }) => { calls.push({ what: 'push', dir: d, branch, token }); return { branch, url: `https://github.com/o/r/tree/${branch}`, compare: 'c' }; },
    // new apps: the person's GitHub repo is made (no network) and its first commit is pushed
    createRepo: async ({ name, token }) => { calls.push({ what: 'create', name, token }); return { owner: 'dee', name, url: `https://github.com/dee/${name}` }; },
    pushDefault: async ({ dir: d, token }) => { calls.push({ what: 'pushDefault', dir: d, token }); },
    refreshClone: async ({ dir: d, token }) => { calls.push({ what: 'refresh', dir: d, token }); },
};

let manager, server, url;
test.before(async () => {
    fs.mkdirSync(reposBase, { recursive: true });
    // maxRuns 0: runs are accepted and stay queued; nothing starts a sandbox
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposBase], maxRuns: 0, hosted: true, token: 'tok', sandbox: 'e2b', limits: { perUser: 2, maxMinutes: 20, defaultCost: 1.5 }, github: fakeGit });
    // the runner only answers to its own host name, so find a free port first
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    server = http.createServer(createApp(manager, { token: 'tok', port, hosted: true, reposBase, git: fakeGit }));
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (owner, method, p, body, extra = {}) => fetch(url + p, {
    method, headers: { 'content-type': 'application/json', 'x-runner-token': 'tok', ...(owner ? { 'x-runner-owner': owner } : {}), ...extra },
    body: body && JSON.stringify(body),
});
const mk = (owner, over = {}) => call(owner, 'POST', '/runs', { goal: 'do it', repo: 'o/r', sandbox: 'e2b', ...over });

test('github repo names: only owner/name, and each person gets their own folder', () => {
    assert.deepEqual(github.parse('skyfly200/custom-ai-harness'), { owner: 'skyfly200', name: 'custom-ai-harness' });
    assert.deepEqual(github.parse('github:a/b.js'), { owner: 'a', name: 'b.js' });
    assert.deepEqual(github.parse('https://github.com/a/b.git'), { owner: 'a', name: 'b' });
    for (const bad of ['/etc', '../x/y', 'a/../b', 'a/b/c', 'a', '', 'https://evil.com/a/b', '-x/y', 'a/..']) assert.throws(() => github.parse(bad), undefined, bad);
    const a = github.cloneDir('/base', 'ann', { owner: 'o', name: 'r' });
    assert.notEqual(a, github.cloneDir('/base', 'bob', { owner: 'o', name: 'r' }));
    assert.ok(a.startsWith('/base/'));
});

test('clone: the token goes to git for that call only, never into the remote or a path', async () => {
    const seen = [];
    const git = async (args, opts) => { seen.push({ args, token: opts.token }); return ''; };
    const d = await github.ensureClone({ base: path.join(dir, 'c'), person: 'ann', spec: 'o/r', token: 'ghp_SECRET0123456789abcdef', git });
    assert.equal(seen[0].args[0], 'clone');
    assert.equal(seen[0].token, 'ghp_SECRET0123456789abcdef');
    assert.ok(!JSON.stringify(seen[0].args).includes('SECRET'));
    assert.ok(!d.includes('SECRET'));
});

test('push: only harness/ branches, and only with a token', async () => {
    const git = async () => 'https://github.com/o/r.git\n';
    await assert.rejects(github.pushBranch({ dir: '/x', branch: 'main', token: 't', git }), /only harness/);
    await assert.rejects(github.pushBranch({ dir: '/x', branch: 'harness/r1', token: '', git }), /connect a GitHub token/);
    assert.equal((await github.pushBranch({ dir: '/x', branch: 'harness/r1', token: 't', git })).url, 'https://github.com/o/r/tree/harness/r1');
});

test('a request must say whose it is, and the runner token is checked', async () => {
    assert.equal((await call(null, 'GET', '/runs')).status, 400);
    assert.equal((await call('ann', 'GET', '/runs', undefined, { 'x-runner-token': 'wrong' })).status, 401);
});

test('runs belong to their owner: others cannot list, read, stop, approve, push or delete them', async () => {
    const made = await mk('ann');
    assert.equal(made.status, 201);
    const run = await made.json();
    assert.equal(run.owner, 'ann');
    assert.equal((await (await call('ann', 'GET', '/runs')).json()).runs.length, 1);
    assert.equal((await (await call('bob', 'GET', '/runs')).json()).runs.length, 0);
    for (const [m, p] of [['GET', ''], ['GET', '/diff'], ['POST', '/stop'], ['POST', '/approve'], ['POST', '/push'], ['POST', '/retry'], ['POST', '/continue'], ['DELETE', '']]) {
        assert.equal((await call('bob', m, `/runs/${run.id}${p}`, m === 'GET' ? undefined : {})).status, 404, `${m} ${p}`);
    }
    assert.equal((await call('ann', 'GET', `/runs/${run.id}`)).status, 200);
    // a client can't claim someone else's name in the body
    const sneaky = await (await mk('bob', { owner: 'ann' })).json();
    assert.equal(sneaky.owner, 'bob');
});

test('repos are GitHub repos cloned for the person, with their token; a path on the machine is refused', async () => {
    calls.length = 0;
    const r = await mk('cy', { repo: 'o/r' });
    assert.equal(r.status, 201);
    const withToken = await call('cy', 'POST', '/runs', { goal: 'g', repo: 'o/priv', sandbox: 'e2b' }, { 'x-runner-github-token': 'ghp_TOKEN0123456789abcdefgh' });
    assert.equal(withToken.status, 201);
    assert.deepEqual(calls.map((c) => [c.spec, c.token]), [['o/r', ''], ['o/priv', 'ghp_TOKEN0123456789abcdefgh']]);
    assert.equal((await mk('cy', { repo: '/etc' })).status, 400);
    assert.equal((await mk('cy', { repo: path.join(reposBase, 'someone-else') })).status, 400);
    const repos = await (await call('cy', 'GET', '/runs/repos')).json();
    assert.equal(repos.hosted, true);
    assert.equal(repos.repos.length, 2);
    assert.deepEqual((await (await call('dee', 'GET', '/runs/repos')).json()).repos, []);
});

test('only cloud sandboxes; minutes and cost are capped; a person has at most N runs going', async () => {
    assert.match((await (await mk('ed', { sandbox: 'local' })).json()).error, /cloud sandboxes only/);
    const a = await (await mk('ed', { maxMinutes: 200, maxCost: 50 })).json();
    assert.equal(a.maxMinutes, 20);
    assert.equal(a.maxCost, 1.5);
    const b = await (await mk('ed', { maxMinutes: 5, maxCost: 0.25 })).json();
    assert.deepEqual([b.maxMinutes, b.maxCost], [5, 0.25]);
    const third = await mk('ed');
    assert.equal(third.status, 429);
    assert.match((await third.json()).error, /at most 2/);
    assert.equal((await mk('fay')).status, 201); // someone else is not affected
});

test('agents belong to their owner too', async () => {
    const made = await call('gus', 'POST', '/agents', { name: 'helper', repo: 'o/r', sandbox: 'e2b' });
    assert.equal(made.status, 201);
    const agent = await made.json();
    assert.equal(agent.owner, 'gus');
    assert.equal((await (await call('hal', 'GET', '/agents')).json()).agents.length, 0);
    assert.equal((await call('hal', 'GET', `/agents/${agent.id}`)).status, 404);
    assert.equal((await call('hal', 'POST', `/agents/${agent.id}/tasks`, { goal: 'x' })).status, 404);
    assert.equal((await call('hal', 'DELETE', `/agents/${agent.id}`, {})).status, 404);
    const task = await call('gus', 'POST', `/agents/${agent.id}/tasks`, { goal: 'x' });
    assert.equal(task.status, 201);
    assert.equal((await task.json()).owner, 'gus');
});

test('local-only features are off: browse, tickets, app settings, previews', async () => {
    for (const p of ['/runs/browse', '/tickets/read']) assert.equal((await call('ann', 'GET', p)).status, 404, p);
    assert.equal((await call('ann', 'PATCH', '/apps/nope', { name: 'X' })).status, 404);
    assert.equal((await call('ann', 'POST', '/apps', { name: 'X', repo: '/etc' })).status, 404);
    assert.equal((await call('ann', 'POST', '/apps/nope/proposals', { kind: 'error' })).status, 404);
});

test('a new app on a shared server: a GitHub repo in the person\'s own folder, made with their token', async () => {
    const local = await call('dee', 'POST', '/apps/new', { template: 'web-app', name: 'Board', github: { mode: 'local' }, build: false });
    assert.equal(local.status, 400);
    assert.match((await local.json()).error, /needs a GitHub repo/);
    // a folder the person names is ignored here: the app goes in their own folder
    const res = await call('dee', 'POST', '/apps/new', { template: 'web-app', name: 'Board', parent: '/etc', build: false, github: { mode: 'create', repo: 'board' } }, { 'x-runner-github-token': 'dee-token' });
    assert.equal(res.status, 201);
    const { app, run, buildError } = await res.json();
    assert.equal(run, null);
    assert.equal(buildError, null);
    assert.equal(app.owner, 'dee');
    assert.equal(app.githubRepo, 'dee/board');
    assert.equal(app.baseBranch, 'main');
    assert.ok(app.repo.startsWith(github.personDir(reposBase, 'dee') + path.sep), app.repo);
    assert.ok(fs.existsSync(path.join(app.repo, '.git')));
    assert.ok(calls.some((c) => c.what === 'create' && c.token === 'dee-token'));
    assert.ok(calls.some((c) => c.what === 'pushDefault' && c.token === 'dee-token'));
    // an app is only ever seen by its owner
    assert.equal((await call('bob', 'GET', `/apps/${app.id}`)).status, 404);
});

test('a change to a shared-server app starts from GitHub\'s latest, runs for its owner, and is refused to others', async () => {
    const { apps } = await (await call('dee', 'GET', '/apps')).json();
    const app = apps.find((a) => a.name === 'Board');
    assert.ok(app);
    const ch = await call('dee', 'POST', `/apps/${app.id}/changes`, { request: 'add a title' }, { 'x-runner-github-token': 'dee-token' });
    assert.equal(ch.status, 201);
    const { id } = await ch.json();
    assert.ok(calls.some((c) => c.what === 'refresh' && c.dir === app.repo && c.token === 'dee-token'));
    assert.equal((await (await call('dee', 'GET', `/runs/${id}`)).json()).owner, 'dee');
    assert.equal((await call('bob', 'POST', `/apps/${app.id}/changes`, { request: 'x' })).status, 404);
    assert.equal((await call('bob', 'DELETE', `/apps/${app.id}`, {})).status, 404);
    // page-error proposals stay off on a shared server
    assert.equal((await call('dee', 'POST', `/apps/${app.id}/proposals`, { kind: 'error', note: 'boom' })).status, 404);
});

test('ship on a shared server uses the person\'s token, never the server\'s; without one it says to connect GitHub', async () => {
    const { Shipper, verdict } = require('../runner/ship');
    assert.equal(typeof verdict, 'function');
    const seen = [];
    const shipper = new Shipper({ token: 'server-token', api: 'https://api.test', fetchImpl: async (url, opts) => { seen.push(opts.headers.authorization); return new Response('{}', { status: 200 }); } });
    await shipper.gh('GET', '/x', undefined, 'ann-token');
    assert.equal(seen.at(-1), 'Bearer ann-token');
    await shipper.gh('GET', '/x');
    assert.equal(seen.at(-1), 'Bearer server-token');
    await assert.rejects(shipper.gh('GET', '/x', undefined, ''), /connect GitHub to ship/);
});

test('refreshClone: fetches with the token for that one command and only moves a fast-forward', async () => {
    const seen = [];
    await github.refreshClone({ dir: '/x', token: 't', git: async (args, opts) => { seen.push({ cmd: args[0], token: opts.token }); return ''; } });
    assert.deepEqual(seen.map((s) => s.cmd), ['fetch', 'merge']);
    assert.ok(seen.every((s) => s.token === 't'));
});

test('apps on a shared server: import only from GitHub, and each person sees their own apps', async () => {
    const local = await call('ann', 'POST', '/apps/import', { source: 'local', folder: '/somewhere' });
    assert.equal(local.status, 400);
    assert.match((await local.json()).error, /shared server, import a GitHub repo/);
    assert.match((await (await call('ann', 'POST', '/apps/import/detect', { source: 'local', folder: '/x' })).json()).error, /shared server/);
    assert.equal((await call('ann', 'GET', '/apps/templates')).status, 200);
    assert.equal((await (await call('ann', 'GET', '/apps')).json()).apps.length, 0);
    const repo = path.join(reposBase, 'ann', 'notes');
    fs.mkdirSync(repo, { recursive: true });
    gitIn(repo, 'init', '-q');
    manager.createApp({ name: 'Notes', repo, editablePaths: ['ui/**'], owner: 'ann' });
    assert.deepEqual((await (await call('ann', 'GET', '/apps')).json()).apps.map((a) => a.name), ['Notes']);
    assert.equal((await (await call('bob', 'GET', '/apps')).json()).apps.length, 0);
});

test('push: a finished run goes to GitHub with the person\'s token', async () => {
    const run = await (await mk('ivy', { repo: 'o/r2' })).json();
    const rec = manager.runs.get(run.id);
    assert.equal((await call('ivy', 'POST', `/runs/${run.id}/push`, {}, { 'x-runner-github-token': 't' })).status, 409); // nothing finished yet
    Object.assign(rec, { status: 'done', result: { commit: 'abc' } });
    calls.length = 0;
    const res = await call('ivy', 'POST', `/runs/${run.id}/push`, {}, { 'x-runner-github-token': 'ghp_TOKEN0123456789abcdefgh' });
    assert.equal(res.status, 200);
    assert.equal(calls[0].branch, rec.branch);
    assert.equal(calls[0].token, 'ghp_TOKEN0123456789abcdefgh');
    assert.ok(rec.pushed.url);
});

test('open pull request: pushes and opens it with the person\'s token, and the run remembers it', async () => {
    const run = await (await mk('ivy', { repo: 'o/r3' })).json();
    const rec = manager.runs.get(run.id);
    assert.equal((await call('ivy', 'POST', `/runs/${run.id}/pr`, {}, { 'x-runner-github-token': 't' })).status, 409);
    Object.assign(rec, { status: 'done', result: { commit: 'abc', summary: 'did it' } });
    calls.length = 0;
    const res = await call('ivy', 'POST', `/runs/${run.id}/pr`, { title: 'Add it' }, { 'x-runner-github-token': 'ghp_TOKEN0123456789abcdefgh' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).url, 'https://github.com/o/r/pull/7');
    assert.equal(calls[0].token, 'ghp_TOKEN0123456789abcdefgh');
    assert.equal(calls[0].title, 'Add it');
    assert.match(calls[0].body, /did it/);
    assert.equal(rec.pr.number, 7);
    assert.ok(rec.pushed);
    assert.equal((await call('ann', 'POST', `/runs/${run.id}/pr`, {})).status, 404, 'not someone else\'s run');
});

test('github.openPullRequest: pushes, uses the default branch, and finds an open one', async () => {
    const seen = [];
    const git = async (args) => { seen.push(args[0]); return 'https://github.com/o/r.git\n'; };
    let pulls = 0;
    const fetchImpl = async (u, opts) => {
        seen.push(`${opts.method} ${new URL(u).pathname}`);
        const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
        if (opts.method === 'GET' && u.endsWith('/repos/o/r')) return reply(200, { default_branch: 'trunk' });
        if (opts.method === 'POST') { pulls++; return pulls === 1 ? reply(201, { number: 3, html_url: 'https://github.com/o/r/pull/3' }) : reply(422, { message: 'exists' }); }
        return reply(200, [{ number: 3, html_url: 'https://github.com/o/r/pull/3', base: { ref: 'trunk' } }]);
    };
    const first = await github.openPullRequest({ dir: '/x', branch: 'harness/r1', token: 't', title: 'T', git, fetchImpl, apiUrl: 'https://api.github.com' });
    assert.deepEqual([first.number, first.base, first.existed], [3, 'trunk', false]);
    assert.ok(seen.includes('push'));
    const again = await github.openPullRequest({ dir: '/x', branch: 'harness/r1', token: 't', title: 'T', git, fetchImpl, base: 'trunk', apiUrl: 'https://api.github.com' });
    assert.equal(again.existed, true);
    await assert.rejects(github.openPullRequest({ dir: '/x', branch: 'main', token: 't', title: 'T', git, fetchImpl }), /only harness/);
});

test('monthly minutes: a person who has used them cannot start another', () => {
    const m = new RunManager({ dir: path.join(dir, 'runs2'), roots: [reposBase], maxRuns: 0, hosted: true, token: 't', limits: { monthlyMinutes: 60 } });
    const now = new Date('2026-10-28T12:00:00Z');
    m.runs.set('x', { id: 'x', owner: 'jo', started: '2026-10-10T10:00:00Z', ended: '2026-10-10T11:30:00Z', status: 'done', events: [] });
    m.runs.set('y', { id: 'y', owner: 'jo', started: '2026-09-10T10:00:00Z', ended: '2026-09-10T20:00:00Z', status: 'done', events: [] }); // last month
    assert.equal(m.minutesThisMonth('jo', now), 90);
    assert.equal(m.minutesThisMonth('kim', now), 0);
});

test('the runner proves itself to the Interceptor with its token and names the owner', () => {
    const m = new RunManager({ dir: path.join(dir, 'runs3'), roots: [reposBase], maxRuns: 0, hosted: true, token: 'sekret' });
    assert.deepEqual(m.authHeaders('ann'), { 'x-runner-token': 'sekret', 'x-harness-run-owner': 'ann' });
    assert.deepEqual(m.authHeaders(null), { 'x-runner-token': 'sekret' });
    assert.deepEqual(m.headers({ id: 'r', owner: 'ann' }, 1)['x-harness-run-owner'], 'ann');
});

test('Interceptor side: runner token from loopback, listed paths only; the owner becomes the user', () => {
    const mw = runnerAuth.middleware((n) => (n === 'ann' ? { name: 'ann', role: 'user' } : null), () => 'sekret');
    const run = (req) => { const res = { status(c) { this.code = c; return this; }, json() { return this; } }; let next = false; mw(req, res, () => { next = true; }); return { res, next }; };
    const base = { method: 'POST', path: '/v1/chat/completions', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-runner-token': 'sekret', 'x-harness-run-owner': 'ann' } };
    const ok = { ...base };
    assert.ok(run(ok).next && ok.harnessRunner && ok.harnessUser.name === 'ann');
    assert.equal(run({ ...base, headers: { ...base.headers, 'x-runner-token': 'nope' } }).res.code, 401);
    assert.equal(run({ ...base, socket: { remoteAddress: '203.0.113.5' } }).res.code, 401);
    assert.equal(run({ ...base, path: '/ui/api/users', method: 'GET' }).res.code, 401);
    assert.equal(run({ ...base, path: '/v1/run-keys' }).next, true);
    const plain = { ...base, headers: {} };
    assert.ok(run(plain).next && !plain.harnessRunner);
});

test('a run key made for an owner makes its requests count as that owner', () => {
    const keys = new RunKeys();
    const { key } = keys.create({ maxUsd: 1, owner: 'ann' });
    const req = { headers: { authorization: `Bearer ${key}` }, method: 'POST', path: '/v1/chat/completions' };
    let went = false;
    keys.middleware((n) => ({ name: n, role: 'user' }))(req, {}, () => { went = true; });
    assert.ok(went && req.harnessRunKey && req.harnessUser.name === 'ann' && req.harnessLogin);
    const noOwner = { headers: { authorization: `Bearer ${keys.create({ maxUsd: 1 }).key}` }, method: 'POST', path: '/v1/chat/completions' };
    keys.middleware(() => ({ name: 'x' }))(noOwner, {}, () => {});
    assert.equal(noOwner.harnessUser, undefined);
});

test('the GitHub token is stored encrypted, checked once, and never shown', async () => {
    const pg = new PGlite();
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    db.query = async (text, params) => pg.query(text, params);
    await assert.rejects(userGithub.setToken('ann', 'short', async () => 'x'), /does not look like/);
    const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const out = await userGithub.setToken('ann', tok, async (t) => { assert.equal(t, tok); return 'anncat'; });
    assert.equal(out.login, 'anncat');
    const raw = (await pg.query('SELECT secret_enc FROM user_github')).rows[0].secret_enc;
    assert.ok(!raw.includes('abcdefghijkl'));
    assert.equal(await userGithub.resolve('ann'), tok);
    assert.equal(await userGithub.resolve('bob'), null);
    const st = await userGithub.status('ann');
    assert.deepEqual([st.set, st.login], [true, 'anncat']);
    assert.ok(!JSON.stringify(st).includes(tok));
    await userGithub.remove('ann');
    assert.equal((await userGithub.status('ann')).set, false);
});
