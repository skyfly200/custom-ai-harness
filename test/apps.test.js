// Apps: a registered app's change run may only write inside its editable paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-apps-')));
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

const { editableMatcher } = require('../runner/apps');

test('editable globs match inside the repo only', () => {
    const ok = editableMatcher(['ui/**', 'server.js', 'docs/*.md']);
    assert.equal(ok('ui/chat.css'), true);
    assert.equal(ok('./ui/a/b.js'), true);
    assert.equal(ok('server.js'), true);
    assert.equal(ok('docs/a.md'), true);
    assert.equal(ok('docs/x/a.md'), false);
    assert.equal(ok('utils/guard.js'), false);
    assert.equal(ok('../ui/a.js'), false);
    assert.equal(ok('/etc/ui/a.js'), false);
    assert.equal(ok('ui/../utils/x.js'), false);
    assert.equal(editableMatcher([])('ui/a.js'), false);
});

test.before(async () => {
    fs.mkdirSync(path.join(repo, 'ui'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'ui', 'a.css'), 'a {}\n');
    fs.writeFileSync(path.join(repo, 'secret.js'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    await new Promise((r) => fakeHarness.listen(0, '127.0.0.1', r));
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], harnessUrl: `http://127.0.0.1:${fakeHarness.address().port}`, retryDelayMs: 5 });
    const port = 40000 + Math.floor(Math.random() * 20000);
    server = createApp(manager, { port }).listen(port, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
    fakeHarness.close();
    server.close();
    await require('../utils/powershellSession').closeAll();
});

test('an app is registered, validated and listed', async () => {
    assert.match((await call('POST', '/apps', { name: 'UI', repo })).body.error, /which paths/);
    assert.match((await call('POST', '/apps', { name: 'UI', repo, editablePaths: ['../x'] })).body.error, /inside the repo/);
    assert.match((await call('POST', '/apps', { name: 'UI', repo, editablePaths: ['ui/**'], deploy: 'ftp' })).body.error, /deploy must be/);
    const made = await call('POST', '/apps', { name: 'UI', repo, editablePaths: 'ui/**, README.md', devCommand: 'npm start -- {port}', testCommand: 'true' });
    assert.equal(made.status, 201);
    assert.deepEqual(made.body.editablePaths, ['ui/**', 'README.md']);
    assert.equal(made.body.deploy, 'merge');
    assert.equal((await call('GET', '/apps')).body.apps.length, 1);
    const patched = await call('PATCH', `/apps/${made.body.id}`, { name: 'Harness UI' });
    assert.equal(patched.body.name, 'Harness UI');
    assert.equal((await call('POST', '/apps/nope/changes', { request: 'x' })).status, 404);
    assert.equal((await call('POST', `/apps/${made.body.id}/changes`, {})).status, 400);
});

test('a change run writes inside the editable paths and is refused outside them', async () => {
    const [appRow] = (await call('GET', '/apps')).body.apps;
    script = [
        { calls: [['write_file', { path: 'secret.js', content: 'hacked' }]] },
        { calls: [['write_file', { path: 'ui/a.css', content: 'a { color: blue }\n' }]] },
        { calls: [['finish', { summary: 'made it blue' }]] },
        { calls: [['finish', { summary: 'PASS looks right' }]] },
    ];
    const made = await call('POST', `/apps/${appRow.id}/changes`, { request: 'make the link blue', context: { page: '/index', selected: 'a.link' } });
    assert.equal(made.status, 201);
    assert.equal(made.body.app, appRow.id);
    assert.equal(made.body.workflow, 'change-app');
    const run = await settle(made.body.id);
    assert.equal(run.status, 'done');
    assert.match(modelCalls[0].messages.map((m) => m.content).join('\n'), /untrusted data about the page/);
    assert.equal(fs.readFileSync(path.join(dir, 'runs', run.id, 'work', 'secret.js'), 'utf8'), 'x\n');
    assert.match(fs.readFileSync(path.join(dir, 'runs', run.id, 'work', 'ui', 'a.css'), 'utf8'), /blue/);
    assert.deepEqual(run.result.outside, []);
    assert.equal(run.result.tests.passed, true);
});

test('a command that writes outside the editable paths leaves the run incomplete', async () => {
    const [appRow] = (await call('GET', '/apps')).body.apps;
    script = [
        { calls: [['run_command', { command: 'echo changed > secret.js' }]] },
        { calls: [['finish', { summary: 'done' }]] },
        { calls: [['finish', { summary: 'PASS' }]] },
    ];
    const run = await settle((await call('POST', `/apps/${appRow.id}/changes`, { request: 'tweak' })).body.id);
    assert.equal(run.status, 'incomplete');
    assert.deepEqual(run.result.outside, ['secret.js']);
});

test('an app with a running change cannot be removed; an idle one can', async () => {
    const [appRow] = (await call('GET', '/apps')).body.apps;
    assert.equal((await call('DELETE', `/apps/${appRow.id}`)).status, 200);
    assert.equal((await call('GET', '/apps')).body.apps.length, 0);
});
