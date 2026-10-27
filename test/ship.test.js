// Ship and undo: a finished change to an app is merged on GitHub through a pull request, and
// undone with a revert pull request. GitHub is faked; origin is a local bare repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ship-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { createApp } = require('../runner/server');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const reposDir = path.join(dir, 'repos');
const repo = path.join(reposDir, 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let script = [];
let modelCalls = [];
const fakeHarness = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
        const body = JSON.parse(data || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: {} }));
        if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(body, { jev: false })));
        modelCalls.push(body);
        const next = script.shift();
        if (!next) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'script ran out' })); }
        res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
            choices: [{ message: { role: 'assistant', content: '', tool_calls: next.calls.map(([name, args], i) => ({ id: `c${modelCalls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
    });
});

let manager, server, base;
const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
    return { status: res.status, body: await res.json() };
};
async function settle(id) {
    for (let i = 0; i < 1200; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'stopped', 'incomplete'].includes(run.status)) return run;
        await sleep(25);
    }
    throw new Error('stuck');
}
const writes = (file, text) => ({ calls: [['write_file', { path: file, content: text }]] });

const { Shipper, verdict, parseRemote } = require('../runner/ship');

test('GitHub remotes are read from https and ssh urls', () => {
    assert.equal(parseRemote('https://github.com/skyfly200/custom-ai-harness.git'), 'skyfly200/custom-ai-harness');
    assert.equal(parseRemote('git@github.com:a/b'), 'a/b');
    assert.equal(parseRemote('/tmp/x'), null);
});

// a bare "origin" and a fake GitHub that merges pull requests into it
const origin = path.join(dir, 'origin.git');
let ghLog = [];
const fakeGitHub = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        const body = JSON.parse(data || '{}');
        ghLog.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"message":"bad token"}'); }
        if (req.method === 'POST' && /\/pulls$/.test(req.url)) { fakeGitHub.prs = (fakeGitHub.prs || 0) + 1; fakeGitHub.heads = { ...(fakeGitHub.heads || {}), [fakeGitHub.prs]: [body.head, body.base] }; return res.end(JSON.stringify({ number: fakeGitHub.prs, html_url: `https://github.test/pr/${fakeGitHub.prs}` })); }
        const m = /\/pulls\/(\d+)\/merge$/.exec(req.url);
        if (m) {
            const [head, base] = fakeGitHub.heads[m[1]];
            const clone = path.join(dir, `clone-${m[1]}`);
            git(dir, 'clone', '-q', origin, clone);
            git(clone, 'config', 'user.email', 'gh@example.com'); git(clone, 'config', 'user.name', 'GH');
            git(clone, 'checkout', '-q', base);
            git(clone, 'merge', '--no-ff', '-q', '-m', `Merge PR ${m[1]}`, `origin/${head}`);
            git(clone, 'push', '-q', 'origin', base);
            return res.end(JSON.stringify({ merged: true, sha: git(clone, 'rev-parse', 'HEAD').trim() }));
        }
        res.statusCode = 404; res.end('{}');
    });
});

test.before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q'); git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
    fs.mkdirSync(path.join(repo, 'ui'));
    fs.writeFileSync(path.join(repo, 'ui', 'a.css'), 'a {}\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'start');
    git(dir, 'clone', '-q', '--bare', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'fetch', '-q', 'origin');
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    await new Promise((r) => fakeGitHub.listen(0, '127.0.0.1', r));
    const shipper = new Shipper({ token: 'tok', api: `http://127.0.0.1:${fakeGitHub.address().port}` });
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5, shipper });
    const port = 40000 + Math.floor(Math.random() * 20000);
    server = createApp(manager, { port }).listen(port, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
    fakeHarness.close(); fakeGitHub.close(); server.close();
    await require('../utils/powershellSession').closeAll();
});

async function change(appId, steps) {
    script = structuredClone(steps);
    return settle((await call('POST', `/apps/${appId}/changes`, { request: 'make it blue' })).body.id);
}
const pass = [{ calls: [['write_file', { path: 'ui/a.css', content: 'a { color: blue }\n' }]] }, { calls: [['finish', { summary: 'blue' }]] }, { calls: [['finish', { summary: 'PASS' }]] }];

test('a passing change ships as a merged pull request and is undone with a revert', async () => {
    const app = (await call('POST', '/apps', { name: 'UI', repo, editablePaths: ['ui/**'], testCommand: 'true', githubRepo: 'o/r', baseBranch: 'main' })).body;
    const run = await change(app.id, pass);
    const v = (await call('GET', `/runs/${run.id}/ship`)).body;
    assert.equal(v.canShip, true);
    assert.deepEqual(v.files, ['ui/a.css']);
    const shipped = await call('POST', `/runs/${run.id}/ship`);
    assert.equal(shipped.status, 201);
    assert.equal(shipped.body.pr, 1);
    assert.equal(shipped.body.base, 'main');
    assert.match(git(origin, 'show', 'main:ui/a.css'), /blue/);
    assert.equal((await call('POST', `/runs/${run.id}/ship`)).status, 409);
    assert.equal((await call('POST', `/runs/${run.id}/undo`)).status, 201);
    assert.doesNotMatch(git(origin, 'show', 'main:ui/a.css'), /blue/);
    assert.equal((await call('POST', `/runs/${run.id}/undo`)).status, 409);
    assert.deepEqual(ghLog.filter((l) => /merge/.test(l)).length, 2);
});

test('failing tests, files outside the paths and a missing token block shipping', async () => {
    const app = (await call('POST', '/apps', { name: 'T', repo, editablePaths: ['ui/**'], testCommand: 'false', githubRepo: 'o/r', baseBranch: 'main' })).body;
    const run = await change(app.id, pass);
    const v = (await call('GET', `/runs/${run.id}/ship`)).body;
    assert.equal(v.canShip, false);
    assert.match(v.blocked.join(' '), /tests fail/);
    const r = await call('POST', `/runs/${run.id}/ship`);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not shipping/);
    assert.equal((await call('POST', `/runs/${run.id}/undo`)).status, 409);
    await assert.rejects(new Shipper({ token: '' }).gh('GET', '/x'), /GITHUB_TOKEN/);
    assert.equal((await call('GET', `/runs/${(await call('POST', '/runs', { goal: 'x', repo })).body.id}/ship`)).status, 400);
});

test('a run with no commit cannot ship', async () => {
    const v = await verdict({ status: 'done', base: 'HEAD', result: { commit: null } }, repo);
    assert.equal(v.canShip, false);
});
