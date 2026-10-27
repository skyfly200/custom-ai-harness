// A run's live preview: the dev server starts in the run's worktree on a free port,
// is checked by the command guard, and stops with the run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-preview-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');
const { PreviewManager } = require('../runner/preview');
const { createApp } = require('../runner/server');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((resolve, reject) => http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject));

// the "dev server": answers with the folder it was started in
const SERVER = `node -e "require('http').createServer((q,s)=>s.end(process.cwd()+' port '+process.env.PORT)).listen(Number(process.argv[1]))" {port}`;

test('the dev server starts on a free port, answers, and stops', async () => {
    const pm = new PreviewManager({ readyMs: 10000 });
    const st = await pm.start('r1', dir, SERVER);
    try {
        assert.equal(st.ready, true);
        assert.match(st.url, /^http:\/\/localhost:5\d{3}$/);
        assert.equal(await get(st.url), `${dir} port ${st.port}`);
        await assert.rejects(pm.start('r1', dir, SERVER), /already has a preview/);
        const second = await pm.start('r2', dir, SERVER);
        assert.notEqual(second.port, st.port);
    } finally { pm.stopAll(); }
    await sleep(200);
    await assert.rejects(get(st.url));
    assert.deepEqual(pm.status('r1'), { running: false });
});

test('a command that exits is reported with its log, and bad input is refused', async () => {
    const pm = new PreviewManager({ readyMs: 5000 });
    const st = await pm.start('x', dir, 'echo boom && exit 3');
    assert.equal(st.running, false);
    assert.equal(st.exited, 3);
    assert.match(st.log.join('\n'), /boom/);
    await assert.rejects(pm.start('y', dir, '   '), /give the command/);
    await assert.rejects(pm.start('z', dir, 'x'.repeat(501)), /too long/);
});

test('a run previews its worktree, and the guard and run state are checked', async () => {
    const repo = path.join(dir, 'repos', 'demo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.js'), '1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    const fake = await new Promise((r) => { const s = http.createServer((req, res) => {
        let d = '';
        req.on('data', (c) => { d += c; });
        req.on('end', async () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/ui/api/model-info') return res.end('{"models":{}}');
            if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(JSON.parse(d), { jev: false })));
            res.end(JSON.stringify({ model: 'f', usage: {}, choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] } }] }));
        });
    }).listen(0, '127.0.0.1', () => r(s)); });
    const manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fake.address().port}`, retryDelayMs: 1 });
    try {
        const { id } = manager.create({ goal: 'x', repo, workflow: 'quick-answer' });
        for (let i = 0; i < 300 && manager.get(id).status !== 'done'; i++) await sleep(20);
        assert.equal(manager.get(id).status, 'done');
        const st = await manager.startPreview(id, { command: SERVER });
        assert.equal(await get(st.url), `${path.join(dir, 'runs', id, 'work')} port ${st.port}`);
        assert.equal(manager.previewStatus(id).running, true);
        // a rule-blocked command never starts
        await assert.rejects(manager.startPreview('nope', { command: 'x' }), /no such run/);
        manager.stopPreview(id);
        await assert.rejects(manager.startPreview(id, { command: 'rm -rf /' }), /guard blocked/);
        // deleting the run stops its preview
        await manager.startPreview(id, { command: SERVER });
        await manager.remove(id);
        assert.equal(manager.previewStatus(id).running, false);
    } finally { manager.previews.stopAll(); fake.close(); }
});

test('the runner API starts, reads and stops a preview', async () => {
    const calls = [];
    const stub = { get: (id) => (id === 'r' ? { id } : null), startPreview: async (id, b) => { calls.push(b); if (b.command === 'risky') throw Object.assign(new Error('asks'), { needsApproval: true }); return { running: true, url: 'http://localhost:5200' }; }, previewStatus: () => ({ running: true }), stopPreview: () => calls.push('stop') };
    let handler;
    const server = await new Promise((r) => { const s = http.createServer((q, a) => handler(q, a)).listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    handler = createApp(stub, { port });
    const call = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
        assert.equal((await call('POST', '/runs/r/preview', { command: 'npm run dev' })).status, 201);
        const asked = await call('POST', '/runs/r/preview', { command: 'risky' });
        assert.equal(asked.status, 409);
        assert.equal((await asked.json()).needsApproval, true);
        assert.deepEqual(await (await call('GET', '/runs/r/preview')).json(), { running: true });
        assert.equal((await call('GET', '/runs/zz/preview')).status, 404);
        assert.equal((await call('DELETE', '/runs/r/preview', {})).status, 200);
        assert.ok(calls.includes('stop'));
    } finally { server.close(); }
});
