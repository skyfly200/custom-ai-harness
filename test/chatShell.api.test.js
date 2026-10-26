// The chat's shell over HTTP: the tool is offered when the setting is on, the
// command guard runs before anything runs, "ask" needs the page's confirmation,
// and a folder that is not a repo is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shell-api-'));
const repo = path.join(dir, 'repo');
const plain = path.join(dir, 'plain');
let harness, base, settings;

test.before(async () => {
    fs.mkdirSync(repo);
    fs.mkdirSync(plain);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'source.txt'), 'original\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'start'], { cwd: repo });
    process.env.MCP_CONFIG = path.join(dir, 'mcp.json');
    fs.writeFileSync(process.env.MCP_CONFIG, JSON.stringify({ mcpServers: {} }));
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    process.env.HARNESS_GUARD_RULES = path.join(dir, 'guard-rules.json');
    process.env.CHAT_WORKTREES_DIR = path.join(dir, 'chat-worktrees');
    // Jev off (no model needed here) and one deny rule to prove a blocked command never runs
    fs.writeFileSync(process.env.HARNESS_GUARD_RULES, JSON.stringify({
        bash: [{ id: 'no-blocked', decision: 'deny', pattern: 'blocked-cmd' }, { id: 'ask-write', decision: 'ask', pattern: '>' }],
        write: [],
        safe: ['echo', 'pwd'],
    }));
    settings = require('../utils/settings');
    settings.update({ guardJev: false });
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});

test('each chat shell runs in a persistent worktree isolated from the source and other chats', async () => {
    const first = await shell({ arguments: { command: 'pwd' }, chatId: 'chat-one' });
    const second = await shell({ arguments: { command: 'pwd' }, chatId: 'chat-two' });
    const again = await shell({ arguments: { command: 'pwd' }, chatId: 'chat-one' });
    assert.equal(first.isError, false);
    assert.equal(second.isError, false);
    const firstPath = first.text.split('\n').at(-1);
    const secondPath = second.text.split('\n').at(-1);
    assert.notEqual(firstPath, repo);
    assert.notEqual(firstPath, secondPath);
    assert.match(firstPath, /chat-worktrees/);
    assert.equal(again.text.split('\n').at(-1), firstPath);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
});

test.after(async () => {
    harness?.close();
    await require('../utils/chatShell').closePowerShellSessions();
    await require('../server').mcp.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const shell = (body) => post('/ui/api/tools/call', { name: 'run_command', repo, ...body }).then((r) => r.json());

test('the tool list offers run_command while the setting is on', async () => {
    assert.equal(settings.get().shellInRepo, true, 'on by default');
    const j = await (await fetch(`${base}/ui/api/tools`)).json();
    assert.ok(j.shellDefinitions.some((d) => d.function.name === 'run_command'));
});

test('an allowed command runs in the linked repo and its output comes back', async () => {
    const j = await shell({ arguments: { command: 'echo hi-from-repo' } });
    assert.equal(j.isError, false);
    assert.match(j.text, /exit code 0/);
    assert.match(j.text, /hi-from-repo/);
});

test('a denied command never runs, even when the page says it was confirmed', async () => {
    const j = await shell({ arguments: { command: 'echo blocked-cmd' }, confirmed: true });
    assert.equal(j.isError, true);
    assert.match(j.text, /refused/);
});

test('a command the guard wants a person to allow runs only when confirmed', async () => {
    const command = 'echo written > out.txt';
    const check = await (await post('/ui/api/tools/shell/check', { command })).json();
    assert.equal(check.decision, 'ask');
    const refused = await shell({ arguments: { command } });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /approval/);
    assert.ok(!fs.existsSync(path.join(repo, 'out.txt')), 'the unconfirmed command did not run');
    const allowed = await shell({ arguments: { command }, confirmed: true });
    assert.equal(allowed.isError, false);
    assert.ok(fs.existsSync(path.join(repo, 'out.txt')));
});

test('a folder that is not a repository is refused', async () => {
    const j = await post('/ui/api/tools/call', { name: 'run_command', arguments: { command: 'echo x' }, repo: plain }).then((r) => r.json());
    assert.equal(j.isError, true);
    assert.match(j.text, /git repository/);
});

test('with the setting off there is no tool and no run', async () => {
    settings.update({ shellInRepo: false });
    try {
        assert.deepEqual((await (await fetch(`${base}/ui/api/tools`)).json()).shellDefinitions, []);
        const j = await shell({ arguments: { command: 'echo x' } });
        assert.equal(j.isError, true);
        assert.match(j.text, /off/);
    } finally {
        settings.update({ shellInRepo: true });
    }
});
