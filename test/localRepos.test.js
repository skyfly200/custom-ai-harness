// The repo fields' suggestions: git repos found under chosen folders on this machine, and nothing at all on a hosted server
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const localRepos = require('../utils/localRepos');

function tree() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-'));
    const mk = (...p) => fs.mkdirSync(path.join(base, ...p), { recursive: true });
    mk('code', 'alpha', '.git');
    mk('code', 'group', 'beta', '.git');
    mk('code', 'alpha', 'nested', '.git');        // inside a repo: not listed
    mk('code', 'node_modules', 'dep', '.git');    // skipped folder
    mk('code', '.hidden', 'gamma', '.git');       // hidden folder
    mk('code', 'a', 'b', 'c', 'deep', '.git');    // deeper than 3
    mk('code', 'plain');                          // no repo
    return base;
}

test('finds repos under the roots, not inside repos, skipped or too deep', () => {
    const base = tree();
    const names = localRepos.scan([path.join(base, 'code')]).map((r) => path.relative(base, r.path).split(path.sep).join('/'));
    assert.deepEqual(names, ['code/alpha', 'code/group/beta']);
});

test('REPO_SCAN_ROOTS wins, then RUNNER_ROOTS and HARNESS_FILE_ROOTS; missing folders are dropped', () => {
    const base = tree();
    const code = path.join(base, 'code');
    const sep = path.delimiter;
    assert.deepEqual(localRepos.roots({ REPO_SCAN_ROOTS: `${code}${sep}${base}/nope`, RUNNER_ROOTS: '/x' }), [code]);
    assert.deepEqual(localRepos.roots({ RUNNER_ROOTS: code, HARNESS_FILE_ROOTS: `${code}${sep}${base}` }), [code, base]);
    // nothing set: the harness's parent folder and common code folders in the home folder
    const r = localRepos.roots({}, { home: base, cwd: path.join(base, 'code', 'alpha') });
    assert.deepEqual(r, [path.join(base, 'code')]);
});

test('list scans locally and answers empty without touching the disk on a hosted server', () => {
    const base = tree();
    const env = { REPO_SCAN_ROOTS: path.join(base, 'code') };
    const local = localRepos.list(env, { fresh: true });
    assert.equal(local.hosted, false);
    assert.deepEqual(local.repos.map((r) => r.name), ['alpha', 'beta']);
    for (const hosted of [{ HARNESS_SERVER: '1' }, { DATABASE_URL: 'postgres://x' }]) {
        assert.deepEqual(localRepos.list({ ...env, ...hosted }, { fresh: true }), { repos: [], roots: [], hosted: true });
    }
});
