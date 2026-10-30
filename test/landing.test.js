// Landing: a finished run's change can be left on its branch (default), merged into the branch
// it started from, or put straight onto it. Real git repos here; GitHub is a stub that records
// what would have been pushed and merged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const landing = require('../runner/landing');
const gitHub = require('../runner/github');
const { RunManager } = require('../runner/runs');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-landing-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A repo on `main` with a.js, and a harness branch one commit ahead of it that changes a.js. */
function makeRepo(name, { branchAhead = true } = {}) {
    const repo = path.join(dir, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.js'), 'exports.a = 1;\n');
    fs.writeFileSync(path.join(repo, 'b.js'), 'exports.b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    if (branchAhead) {
        git(repo, 'checkout', '-q', '-b', 'harness/r1');
        fs.writeFileSync(path.join(repo, 'a.js'), 'exports.a = 2;\n');
        git(repo, 'commit', '-q', '-am', 'change a');
        git(repo, 'checkout', '-q', 'main');
    }
    return repo;
}

test('the landing choices and the reasons a run may not land', () => {
    assert.equal(landing.cleanLanding(undefined), 'branch');
    assert.equal(landing.cleanLanding(''), 'branch');
    assert.equal(landing.cleanLanding('merge'), 'merge');
    assert.equal(landing.cleanLanding('main'), 'main');
    assert.throws(() => landing.cleanLanding('push-everything'), /landing must be one of branch, merge, main/);

    const done = { status: 'done', plan: false, result: { commit: 'abc', tests: null, outside: [] } };
    assert.equal(landing.landingBlock(done), null);
    assert.match(landing.landingBlock({ ...done, plan: true }), /plan changes nothing/);
    assert.match(landing.landingBlock({ ...done, status: 'failed' }), /ended failed/);
    assert.match(landing.landingBlock({ ...done, result: { commit: null } }), /no commit/);
    assert.match(landing.landingBlock({ ...done, result: { commit: 'abc', outside: ['x.js'] } }), /outside the editable paths: x.js/);
    assert.match(landing.landingBlock({ ...done, result: { commit: 'abc', tests: { passed: false } } }), /tests fail/);
});

test('merge puts the branch into the checked-out branch as a merge commit', async () => {
    const repo = makeRepo('merge');
    const sha = await landing.landLocal({ repo, branch: 'harness/r1', into: 'main', mode: 'merge', message: 'Merge harness/r1' });
    assert.equal(git(repo, 'rev-parse', 'HEAD'), sha);
    assert.equal(git(repo, 'show', 'HEAD:a.js'), 'exports.a = 2;', 'the change is on main');
    assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', sha).split(' ').length, 3, 'a merge commit, two parents');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the working tree follows');
});

test('main fast-forwards the branch, with no merge commit', async () => {
    const repo = makeRepo('ff');
    const sha = await landing.landLocal({ repo, branch: 'harness/r1', into: 'main', mode: 'main', message: 'x' });
    assert.equal(git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', 'harness/r1'));
    assert.equal(sha, git(repo, 'rev-parse', 'main'));
    assert.equal(git(repo, 'show', 'main:a.js'), 'exports.a = 2;');
});

test('a branch that is not checked out is moved without touching the working tree', async () => {
    const repo = makeRepo('other');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'mine\n');
    const before = git(repo, 'rev-parse', 'main');
    await landing.landLocal({ repo, branch: 'harness/r1', into: 'main', mode: 'main', message: 'x' });
    assert.equal(git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', 'harness/r1'));
    assert.notEqual(git(repo, 'rev-parse', 'main'), before);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
    assert.equal(fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8'), 'mine\n', 'the person’s work is untouched');
});

test('uncommitted changes on the branch stop the merge, and nothing is changed', async () => {
    const repo = makeRepo('dirty');
    fs.writeFileSync(path.join(repo, 'b.js'), 'exports.b = 99;\n');
    const before = git(repo, 'rev-parse', 'main');
    await assert.rejects(landing.landLocal({ repo, branch: 'harness/r1', into: 'main', mode: 'merge', message: 'x' }), /uncommitted changes/);
    assert.equal(git(repo, 'rev-parse', 'main'), before);
});

test('a main that moved on is not fast-forwarded: it fails and the branch stays', async () => {
    const repo = makeRepo('moved');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'b.js'), 'exports.b = 2;\n');
    git(repo, 'commit', '-q', '-am', 'someone else');
    const before = git(repo, 'rev-parse', 'main');
    await assert.rejects(landing.landLocal({ repo, branch: 'harness/r1', into: 'main', mode: 'main', message: 'x' }), /git merge failed/);
    assert.equal(git(repo, 'rev-parse', 'main'), before);
    assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('a merge conflict is aborted, leaving the repo as it was', async () => {
    const repo = makeRepo('conflict');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.js'), 'exports.a = 3;\n');
    git(repo, 'commit', '-q', '-am', 'a differently');
    const before = git(repo, 'rev-parse', 'main');
    await assert.rejects(landing.landLocal({ repo, branch: 'harness/r1', into: 'main', mode: 'merge', message: 'x' }));
    assert.equal(git(repo, 'rev-parse', 'main'), before);
    assert.equal(git(repo, 'status', '--porcelain'), '', 'no conflict markers are left');
});

test('a run lands through the manager, and a blocked one is kept on its branch', async () => {
    const repo = makeRepo('manager');
    const manager = new RunManager({ dir: path.join(dir, 'runs-manager'), roots: [dir], maxRuns: 0 });
    const run = { id: 'r1', goal: 'Change a', repo, branch: 'harness/r1', landOn: 'main', landing: 'merge', plan: false, status: 'done', result: { commit: git(repo, 'rev-parse', 'harness/r1'), outside: [], tests: null }, events: [] };
    await manager.land(run);
    assert.equal(run.landed.ok, true);
    assert.equal(run.landed.into, 'main');
    assert.equal(git(repo, 'show', 'main:a.js'), 'exports.a = 2;');

    const blocked = { ...run, id: 'r2', status: 'failed', landed: null, events: [] };
    await manager.land(blocked);
    assert.equal(blocked.landed.ok, false);
    assert.match(blocked.landed.reason, /ended failed/);
    assert.match(blocked.events.at(-1).text, /still on harness\/r1/);
});

test('create refuses a landing it cannot honour, before any run starts', () => {
    const repo = makeRepo('create');
    const manager = new RunManager({ dir: path.join(dir, 'runs-create'), roots: [dir], maxRuns: 0 });
    assert.throws(() => manager.create({ goal: 'x', repo, landing: 'main', plan: '1' }), /nothing to land/);
    assert.throws(() => manager.create({ goal: 'x', repo, landing: 'nope' }), /landing must be one of/);
    git(repo, 'checkout', '-q', '--detach');
    assert.throws(() => manager.create({ goal: 'x', repo, landing: 'merge' }), /check out a branch/);
});

test('a hosted run needs a GitHub connection to land', () => {
    const repo = makeRepo('hosted');
    const manager = new RunManager({ dir: path.join(dir, 'runs-hosted'), roots: [dir], maxRuns: 0, hosted: true });
    const was = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = 'test-key'; // the sandbox must be configured for the run to get as far as landing
    try {
        assert.throws(() => manager.create({ goal: 'x', repo, landing: 'merge', sandbox: 'e2b', owner: 'u1' }), /connect GitHub/);
    } finally {
        if (was === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = was;
    }
});

test('landing on GitHub: main pushes the commit onto the branch, merge opens and merges a pull request', async () => {
    const repo = makeRepo('github');
    const pushes = [];
    const requests = [];
    const realGit = (args, { cwd } = {}) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const stubGit = async (args, opts) => {
        if (args[0] === 'remote') return 'https://github.com/acme/app.git\n';
        if (args[0] === 'push') { pushes.push(args); return ''; }
        return realGit(args, opts);
    };
    const fetchImpl = async (url, opts) => {
        requests.push({ url, method: opts.method });
        const body = url.endsWith('/pulls') ? { number: 7, html_url: 'https://github.com/acme/app/pull/7' } : { merged: true, sha: 'merged123' };
        return { ok: true, status: 200, json: async () => body };
    };
    const out = await gitHub.landRemote({ dir: repo, branch: 'harness/r1', into: 'main', mode: 'merge', title: 'Merge', token: 't', git: stubGit, fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(out.sha, 'merged123');
    assert.equal(out.pr, 7);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url.replace('https://api.test', '')}`), ['POST /repos/acme/app/pulls', 'PUT /repos/acme/app/pulls/7/merge']);
    assert.ok(pushes.some((p) => p.includes('refs/heads/harness/r1:refs/heads/harness/r1')), 'the branch is pushed first');

    pushes.length = 0;
    const main = await gitHub.landRemote({ dir: repo, branch: 'harness/r1', into: 'main', mode: 'main', title: 'x', token: 't', git: stubGit, fetchImpl, apiUrl: 'https://api.test' });
    assert.match(main.url, /commits\/main$/);
    assert.ok(pushes.some((p) => p.at(-1) === `${git(repo, 'rev-parse', 'refs/heads/harness/r1')}:refs/heads/main`), 'the commit goes straight onto main');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('an agent keeps its landing, and refuses one it does not know', () => {
    const { AgentStore } = require('../runner/agents');
    assert.equal(AgentStore.fields({ name: 'Docs', repo: 'r', landing: 'merge' }).landing, 'merge');
    assert.equal(AgentStore.fields({ landing: 'main' }, { landing: 'branch' }).landing, 'main');
    assert.equal(AgentStore.fields({ landing: '' }).landing, 'branch');
    assert.throws(() => AgentStore.fields({ landing: 'push' }), /landing must be one of/);
});
