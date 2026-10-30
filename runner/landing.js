// Where a finished run's change goes. Its own branch (the default) is left for you to review.
// Merge puts it into the branch the run started from, as a merge commit, once it passes.
// Main puts it straight onto that branch, fast-forward only, with no review step. Both
// land only a run that finished, made a commit, stayed inside its editable paths and
// passed its tests. A plan changes nothing, so it has nothing to land.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LANDINGS = {
    branch: 'Leave it on its own branch, for you to review (default)',
    merge: 'Merge it into the branch it started from, when it passes',
    main: 'Put it straight onto the branch it started from, with no review',
};
const LANDING_IDS = Object.keys(LANDINGS);
const IDENTITY = ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost'];

/** The landing a person asked for; blank is the default (its own branch). Throws on anything else. */
function cleanLanding(v) {
    if (v === undefined || v === null || v === '') return 'branch';
    if (!LANDING_IDS.includes(v)) throw new Error(`landing must be one of ${LANDING_IDS.join(', ')}`);
    return v;
}

/** Why a finished run may not land, or null when it may. */
function landingBlock(run) {
    if (run.plan) return 'a plan changes nothing, so there is nothing to land';
    if (run.status !== 'done') return `the run ended ${run.status}, not done`;
    if (!run.result?.commit) return 'it made no commit';
    if (run.result.outside?.length) return `it changed files outside the editable paths: ${run.result.outside.join(', ')}`;
    if (run.result.tests && !run.result.tests.passed) return 'its tests fail';
    return null;
}

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(`git ${args.find((a, i) => a !== '-c' && args[i - 1] !== '-c')} failed: ${String(errOut || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)) : resolve(out))));

/**
 * Land a branch on the repo on this machine. When the repo has the target branch checked out, merge
 * there, so its files follow (only when nothing is uncommitted). Otherwise work on a detached copy
 * of the branch and move its ref, checked against the old commit. Resolves the commit now on the branch.
 */
async function landLocal({ repo, branch, into, mode, message }) {
    const merge = mode === 'main' ? ['merge', '--ff-only', branch] : ['merge', '--no-ff', '-m', message, branch];
    const head = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (head === into) {
        if ((await git(repo, ['status', '--porcelain'])).trim()) throw new Error(`${into} has uncommitted changes in the repo, so ${branch} was not merged: merge it yourself`);
        await git(repo, [...IDENTITY, ...merge]).catch(async (err) => { await git(repo, ['merge', '--abort']).catch(() => {}); throw err; });
        return (await git(repo, ['rev-parse', 'HEAD'])).trim();
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-land-'));
    const work = path.join(tmp, 'w');
    try {
        const before = (await git(repo, ['rev-parse', `refs/heads/${into}`])).trim();
        await git(repo, ['worktree', 'add', '-q', '--detach', work, before]);
        await git(work, [...IDENTITY, ...merge]);
        const after = (await git(work, ['rev-parse', 'HEAD'])).trim();
        await git(repo, ['update-ref', `refs/heads/${into}`, after, before]);
        return after;
    } finally {
        await git(repo, ['worktree', 'remove', '--force', work]).catch(() => {});
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

module.exports = { LANDINGS, cleanLanding, landingBlock, landLocal };
