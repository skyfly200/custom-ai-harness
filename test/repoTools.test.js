// Read-only git tools for chats linked to a repo
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const repoTools = require('../utils/repoTools');

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repo-')));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outside-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

test.before(() => {
    git('init', '-q');
    git('checkout', '-q', '-b', 'main'); // -b on init needs git 2.28; this works on older ones too
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Tester');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'const answer = 42;\nfunction hello() {\n  return "Hello";\n}\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n');
    fs.writeFileSync(path.join(repo, 'secret.txt'), 'hidden');
    git('add', '.');
    git('commit', '-q', '-m', 'First commit');
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'const answer = 43;\nfunction hello() {\n  return "Hello";\n}\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked hello\n');
    fs.writeFileSync(path.join(outside, 'private.txt'), 'nope');
});

test('inspect finds the repository from a subfolder', async () => {
    const info = await repoTools.inspect(path.join(repo, 'src'));
    assert.equal(info.path, repo);
    assert.equal(info.branch, 'main');
    assert.match(info.head, /First commit/);
    assert.equal(info.changed, 2);
    await assert.rejects(repoTools.inspect(outside), /not inside a git repository/);
    await assert.rejects(repoTools.inspect(path.join(outside, 'missing')), /no folder/);
});

test('list_files skips ignored files and filters by glob or text', async () => {
    const all = await repoTools.call(repo, 'repo_list_files', {});
    assert.match(all, /src\/app\.js/);
    assert.match(all, /notes\.txt/);
    assert.doesNotMatch(all, /secret\.txt/);
    const js = await repoTools.call(repo, 'repo_list_files', { pattern: '*.js' });
    assert.match(js, /^1 file matching/);
    assert.match(await repoTools.call(repo, 'repo_list_files', { pattern: 'readme' }), /README\.md/);
});

test('read_file numbers lines and reads ranges', async () => {
    const text = await repoTools.call(repo, 'repo_read_file', { path: 'src/app.js', start_line: 2, end_line: 3 });
    assert.match(text, /^src\/app\.js \(4 lines\)/);
    assert.match(text, /2  function hello/);
    assert.doesNotMatch(text, /answer/);
    assert.match(text, /start_line 4/);
});

test('read_file refuses paths outside the repository and .git', async () => {
    await assert.rejects(repoTools.call(repo, 'repo_read_file', { path: '../' + path.basename(outside) + '/private.txt' }), /outside the repository/);
    await assert.rejects(repoTools.call(repo, 'repo_read_file', { path: path.join(outside, 'private.txt') }), /outside the repository/);
    await assert.rejects(repoTools.call(repo, 'repo_read_file', { path: '.git/config' }), /\.git folder/);
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(outside, 'private.txt'), path.join(repo, 'link.txt'));
        await assert.rejects(repoTools.call(repo, 'repo_read_file', { path: 'link.txt' }), /links outside/);
        fs.unlinkSync(path.join(repo, 'link.txt'));
    }
});

test('search finds tracked and untracked text', async () => {
    const hits = await repoTools.call(repo, 'repo_search', { query: 'hello' });
    assert.match(hits, /src\/app\.js:2:function hello/);
    assert.match(hits, /notes\.txt:1:untracked hello/);
    assert.match(await repoTools.call(repo, 'repo_search', { query: 'zzz-none' }), /No matches/);
    assert.match(await repoTools.call(repo, 'repo_search', { query: 'answer = 4[0-9]', regex: true }), /app\.js:1/);
});

test('git status, log, diff and show', async () => {
    assert.match(await repoTools.call(repo, 'repo_git_status', {}), /## main[\s\S]*M src\/app\.js/);
    assert.match(await repoTools.call(repo, 'repo_git_log', {}), /Tester: First commit/);
    assert.match(await repoTools.call(repo, 'repo_git_diff', {}), /-const answer = 42;\n\+const answer = 43;/);
    assert.match(await repoTools.call(repo, 'repo_git_show', {}), /First commit/);
});

test('refs that look like options are refused', async () => {
    await assert.rejects(repoTools.call(repo, 'repo_git_show', { ref: '--output=/tmp/x' }), /not a valid ref/);
    await assert.rejects(repoTools.call(repo, 'repo_git_diff', { ref: '-p' }), /not a valid ref/);
});

test('globs', () => {
    assert.ok(repoTools.globToRegExp('*.js').test('src/app.js'));
    assert.ok(repoTools.globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
    assert.ok(!repoTools.globToRegExp('src/*.ts').test('src/a/c.ts'));
});
