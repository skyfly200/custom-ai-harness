// A hosted server has no folders of the person's own: the folder repo and shell tools are not offered,
// a Windows path is never run (or joined onto the server's folder), and the error says what to do instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoTools = require('../utils/repoTools');

const WINDOWS = 'C:\\Users\\skyfl\\Documents\\GitHub\\custom-ai-harness';

test('folders are available locally and not on a hosted server', () => {
    assert.equal(repoTools.localFoldersAvailable({}), true);
    assert.equal(repoTools.localFoldersAvailable({ HARNESS_SERVER: '1' }), false);
    assert.equal(repoTools.localFoldersAvailable({ DATABASE_URL: 'postgres://x' }), false);
    assert.equal(repoTools.localFoldersAvailable({ HARNESS_SERVER: '1', HARNESS_LOCAL_REPOS: '1' }), true);
});

test('a Windows path is refused on Linux with its own words, not resolved against the server folder', () => {
    assert.throws(() => repoTools.checkFolderPath(WINDOWS, { platform: 'linux', env: {} }), /Windows path/);
    assert.throws(() => repoTools.checkFolderPath('\\\\pc\\share', { platform: 'linux', env: {} }), /Windows path/);
    assert.equal(repoTools.checkFolderPath(WINDOWS, { platform: 'win32', env: {} }), WINDOWS);
    assert.equal(repoTools.checkFolderPath('/srv/repo', { platform: 'linux', env: {} }), '/srv/repo');
});

test('a hosted server refuses any folder and points at GitHub', async () => {
    assert.throws(() => repoTools.checkFolderPath('/srv/repo', { platform: 'linux', env: { HARNESS_SERVER: '1' } }), /attach a GitHub repo/);
    const before = process.env.HARNESS_SERVER;
    process.env.HARNESS_SERVER = '1';
    try {
        await assert.rejects(repoTools.inspect('/tmp'), /attach a GitHub repo/);
        await assert.rejects(require('../utils/chatWorktrees').create('/tmp', 'chat-1'), /attach a GitHub repo/);
    } finally {
        if (before === undefined) delete process.env.HARNESS_SERVER; else process.env.HARNESS_SERVER = before;
    }
});

test('over HTTP a hosted server lists no repo or shell tools and refuses their calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hosted-repo-'));
    process.env.MCP_CONFIG = path.join(dir, 'mcp.json');
    fs.writeFileSync(process.env.MCP_CONFIG, JSON.stringify({ mcpServers: {} }));
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    const { app, mcp } = require('../server');
    const harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    const base = `http://127.0.0.1:${harness.address().port}`;
    const before = process.env.HARNESS_LOCAL_REPOS;
    try {
        const local = await (await fetch(`${base}/ui/api/tools`)).json();
        assert.equal(local.localRepos, true);
        assert.ok(local.repoDefinitions.length > 0);

        process.env.HARNESS_SERVER = '1';
        const hosted = await (await fetch(`${base}/ui/api/tools`)).json();
        assert.equal(hosted.localRepos, false);
        assert.deepEqual(hosted.repoDefinitions, []);
        assert.deepEqual(hosted.shellDefinitions, []);

        const call = await (await fetch(`${base}/ui/api/tools/call`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'repo_git_status', repo: WINDOWS, chatId: 'chat-1' }),
        })).json();
        assert.equal(call.isError, true);
        assert.match(call.text, /attach a GitHub repo/);
        assert.doesNotMatch(call.text, /ENOENT|\/app\//);
    } finally {
        delete process.env.HARNESS_SERVER;
        if (before !== undefined) process.env.HARNESS_LOCAL_REPOS = before;
        harness.close();
        await mcp.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the chat page ignores a folder repo on a hosted server and does not sync it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');
    assert.match(src, /const reposOf = \(c\) => \{[\s\S]*hostedNoFolders\(\) \? all\.filter\(Repos\.isGithub\) : all/);
    assert.match(src, /const repoOf = \(c\) => Repos\.defaultOf\(reposOf\(c\), 'local'\);/);
    assert.match(src, /const \{ messages, syncVersion, repo: _folder, repos: _repos, \.\.\.chatMeta \} = c;/);
    assert.match(src, /chatMeta\.repos = synced/);
});
