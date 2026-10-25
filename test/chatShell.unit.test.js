// utils/chatShell.js on its own: the command runs in the folder it is given,
// the environment is trimmed so no API key can be printed, and a folder that is
// not a repository is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const chatShell = require('../utils/chatShell');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shell-'));
const repo = path.join(dir, 'repo');
const plain = path.join(dir, 'plain');
fs.mkdirSync(repo);
fs.mkdirSync(plain);
execFileSync('git', ['init', '-q'], { cwd: repo });

test('one run_command tool, with a required command', () => {
    const [def] = chatShell.definitions();
    assert.equal(def.function.name, 'run_command');
    assert.deepEqual(def.function.parameters.required, ['command']);
    assert.ok(chatShell.isShellTool('run_command'));
    assert.ok(!chatShell.isShellTool('repo_read_file'));
});

test('runs in the folder it is given and returns the exit code and output', async () => {
    const r = await chatShell.exec(repo, 'echo hello-from-chat');
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /hello-from-chat/);
});

test('a failing command reports its exit code instead of throwing', async () => {
    const r = await chatShell.exec(repo, process.platform === 'win32' ? 'exit 3' : 'exit 3');
    assert.equal(r.code, 3);
});

test('a command that runs too long is killed and said to have timed out', async () => {
    const sleeper = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20';
    const r = await chatShell.exec(repo, sleeper, { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.ok(r.ms < 15000, `took ${r.ms} ms`);
});

test('the environment is trimmed, so a command cannot print an API key', async () => {
    process.env.HARNESS_TEST_KEY = 'sk-must-not-appear';
    try {
        const r = await chatShell.exec(repo, process.platform === 'win32' ? 'Write-Output $env:HARNESS_TEST_KEY' : 'echo "$HARNESS_TEST_KEY"');
        assert.doesNotMatch(r.output, /sk-must-not-appear/);
        assert.ok(!chatShell.ENV_ALLOW.includes('HARNESS_TEST_KEY'));
    } finally {
        delete process.env.HARNESS_TEST_KEY;
    }
});

test('repoRoot accepts a repository and refuses anything else', () => {
    assert.equal(chatShell.repoRoot(repo), fs.realpathSync(repo));
    assert.throws(() => chatShell.repoRoot(plain), /git repository/);
    assert.throws(() => chatShell.repoRoot(''), /not linked/);
});
