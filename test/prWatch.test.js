// Pull request state for runs: GitHub's answer becomes open, draft, merged, closed, a conflict flag and checks.
// Auto-fix starts one fix run per conflict, within its tries and cost, and never while one is still working.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prwatch-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');

const prWatch = require('../runner/prWatch');
const { RunManager } = require('../runner/runs');

/** A fake GitHub: answers the pull and its check runs from the given objects. */
function fakeGithub({ pull, checks = [] } = {}) {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(String(url));
        const body = /\/check-runs/.test(url) ? { check_runs: checks } : pull;
        if (!body) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
        return { ok: true, status: 200, json: async () => body };
    };
    return { fetchImpl, calls };
}
const openPull = { number: 7, title: 'Add thing', state: 'open', draft: false, merged_at: null, mergeable: false, mergeable_state: 'dirty', html_url: 'https://github.com/o/n/pull/7', base: { ref: 'master' }, head: { ref: 'feature', sha: 'b'.repeat(40) } };

test('a PR with a dirty merge state is open with conflicts, and its failing checks show', async () => {
    const gh = fakeGithub({ pull: openPull, checks: [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }] });
    const s = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: gh.fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(s.status, 'open');
    assert.equal(s.conflict, true);
    assert.equal(s.checks, 'failing');
    assert.deepEqual(s.checkCounts, { total: 2, failing: 1, pending: 1 });
    assert.equal(s.base, 'master');
    assert.match(gh.calls[1], /commits\/b+\/check-runs/);
});

test('a clean PR has no conflict; GitHub still computing gives null', async () => {
    const clean = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: fakeGithub({ pull: { ...openPull, mergeable: true, mergeable_state: 'clean' } }).fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(clean.conflict, false);
    const unknown = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: fakeGithub({ pull: { ...openPull, mergeable: null, mergeable_state: 'unknown' } }).fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(unknown.conflict, null);
});

test('merged, closed and draft come from the PR; merged PRs skip the check call', async () => {
    const merged = fakeGithub({ pull: { ...openPull, state: 'closed', merged_at: '2026-10-30T00:00:00Z' } });
    const m = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: merged.fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(m.status, 'merged');
    assert.equal(merged.calls.length, 1);
    const closed = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: fakeGithub({ pull: { ...openPull, state: 'closed' } }).fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(closed.status, 'closed');
    const draft = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: fakeGithub({ pull: { ...openPull, draft: true } }).fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(draft.status, 'draft');
});

test('a PR GitHub cannot show is unknown, with the reason, and never throws', async () => {
    const s = await prWatch.fetchPullState({ owner: 'o', name: 'n', number: 7 }, { fetchImpl: fakeGithub({ pull: null }).fetchImpl, apiUrl: 'https://api.test' });
    assert.equal(s.status, 'unknown');
    assert.match(s.error, /not found/);
});

test('the PR a run is about comes from the PR it opened, else the one its task named', () => {
    assert.deepEqual(prWatch.prRefOf({ pr: { url: 'https://github.com/o/n/pull/9' } }), { owner: 'o', name: 'n', number: 9 });
    assert.deepEqual(prWatch.prRefOf({ prTarget: { owner: 'o', name: 'n', number: 4 } }), { owner: 'o', name: 'n', number: 4 });
    assert.equal(prWatch.prRefOf({}), null);
});

test('auto-fix starts one fix run for a conflict, waits while it works, and stops at its tries', async () => {
    const reposDir = path.join(dir, 'repos');
    const repo = path.join(reposDir, 'demo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    const manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir], maxRuns: 0, sandbox: 'local' });
    const root = manager.create({ goal: 'Update https://github.com/o/n/pull/7 with the change', repo, autoFixConflicts: true, autoFixMax: 1 });
    const run = manager.runs.get(root.id);
    run.status = 'done';
    run.result = { commit: 'c'.repeat(40), summary: '' };
    const original = prWatch.fetchPullState;
    prWatch.fetchPullState = async (ref) => ({ status: 'open', conflict: true, checks: 'none', checkCounts: { total: 0, failing: 0, pending: 0 }, error: null, ...ref, checkedAt: 'now' });
    try {
        await manager.refreshPr(root.id, { token: '' });
        const fixes = [...manager.runs.values()].filter((r) => r.fixOf === root.id);
        assert.equal(fixes.length, 1);
        assert.equal(fixes[0].autoPush, true);
        assert.match(fixes[0].goal, /pull\/7/);
        assert.equal(fixes[0].prTarget.number, 7, 'the fix run is pointed at the PR so its branch starts from it');
        assert.equal(manager.fixBlock(run, { manual: false }), 'a fix is already running');
        fixes[0].status = 'failed';
        assert.match(manager.fixBlock(run, { manual: false }), /already tried 1 time/);
        await manager.refreshPr(root.id, { token: '' });
        assert.equal([...manager.runs.values()].filter((r) => r.fixOf === root.id).length, 1, 'no second fix past the tries');
        // a person pressing Fix conflicts is not held to the auto-fix tries, only to a fix that is still running
        const manual = manager.startFix(root.id, { auto: false });
        assert.equal(manager.runs.get(manual.id).autoPush, false);
        assert.throws(() => manager.startFix(root.id, { auto: false }), /a fix is already running/);
    } finally {
        prWatch.fetchPullState = original;
    }
});

test('a PR that is merged gets no fix, and a manual Fix conflicts starts one without auto-push', async () => {
    const reposDir = path.join(dir, 'repos');
    const repo = path.join(reposDir, 'demo');
    const manager = new RunManager({ dir: path.join(dir, 'runs2'), roots: [reposDir], maxRuns: 0, sandbox: 'local' });
    const root = manager.create({ goal: 'Update https://github.com/o/n/pull/8 again', repo });
    const run = manager.runs.get(root.id);
    run.status = 'done';
    run.result = { commit: 'd'.repeat(40), summary: '' };
    run.prState = { status: 'merged' };
    assert.equal(manager.fixBlock(run, { manual: false }), 'its pull request is closed');
    run.prState = { status: 'open' };
    const fix = manager.startFix(root.id, { auto: false });
    assert.equal(fix.fixOf, root.id);
    assert.equal(manager.runs.get(fix.id).autoPush, false);
});
