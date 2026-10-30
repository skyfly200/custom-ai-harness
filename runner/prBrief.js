// A task that names a pull request ("update the pr to fix the merge conflict <url>") is told,
// before the first step, where that PR's code is and what to do with it. Without this the agent
// starts on the default branch with no way to see the PR, and spends its steps finding out
// (gh that is not installed, guessing branch names, a `reset --hard` that waits for approval).
'use strict';

const { execFile } = require('child_process');

const PULL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/pull\/(\d+)/gi;
const REMOTE = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** The pull requests a task names, as { owner, name, number }, first mention first, without repeats. */
function findPulls(text) {
    const seen = new Set();
    const out = [];
    for (const m of String(text || '').matchAll(PULL)) {
        const key = `${m[1]}/${m[2]}#${m[3]}`.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push({ owner: m[1], name: m[2], number: Number(m[3]) }); }
    }
    return out;
}

/** The origin URL of a git directory, as configured (before any insteadOf rewriting), or ''. */
function originOf(git) { return git(['config', '--get', 'remote.origin.url']).then((t) => t.trim(), () => ''); }

/**
 * Fetch the first named pull request's head, and the repo's current default branch, into the sandbox and, for a
 * local sandbox, check the PR out on the run's branch (the run's diff then starts from the PR, not the default
 * branch). Resolves the text to add to the agent's first message, or '' when the task names no pull request.
 * A cloud sandbox is made from a bundle and has no remote, so the repo is named by URL there; whether the PR
 * belongs to the run's repository is judged from the run's own repo, which does have one. Never throws.
 */
async function prepare({ sandbox, run, local, note = () => {} }) {
    const pr = findPulls(run.goal)[0];
    if (!pr) return '';
    const label = `${pr.owner}/${pr.name}#${pr.number}`;
    try {
        const origin = (await originOf((a) => (run.repo ? new Promise((res, rej) => execFile('git', ['-C', run.repo, ...a], { timeout: 15000 }, (e, o) => (e ? rej(e) : res(o)))) : sandbox.git(a))));
        const here = REMOTE.exec(origin);
        if (!here || here[1].toLowerCase() !== pr.owner.toLowerCase() || here[2].toLowerCase() !== pr.name.toLowerCase()) {
            const mine = here ? `${here[1]}/${here[2]}` : origin || 'an unnamed repository';
            note(`This task names a pull request in ${pr.owner}/${pr.name}, but the run's repository is ${mine}.`);
            return `STOP. The task names pull request ${label}, but this workspace is a different repository (${mine}), so that pull request is not here and cannot be fetched into it. Do not explore, search or try to find it. Call finish right now and say: the run was started with ${mine} selected but the task is about ${pr.owner}/${pr.name}, so start it again with ${pr.owner}/${pr.name} selected.`;
        }
        const remote = local ? 'origin' : `https://github.com/${pr.owner}/${pr.name}.git`;
        const ref = `refs/remotes/pr/${pr.number}`;
        await sandbox.git(['fetch', '--quiet', remote, `pull/${pr.number}/head:${ref}`]);
        // the default branch as it is now, which may be ahead of the checkout this run was made from
        const baseRef = 'refs/remotes/pr/base';
        await sandbox.git(['fetch', '--quiet', remote, `HEAD:${baseRef}`]).catch(() => {});
        const hasBase = await sandbox.git(['rev-parse', '--verify', '--quiet', baseRef]).then(() => true, () => false);
        const sha = (await sandbox.git(['rev-parse', ref])).trim();
        let where = `The pull request's code is fetched as ${ref} (commit ${sha.slice(0, 10)}), but your branch is still the default branch. Start with \`git merge --ff-only ${ref}\` so you are on the pull request's code.`;
        if (local && sandbox.dir) {
            await sandbox.git(['reset', '--hard', '--quiet', sha]);
            sandbox.base = sha;
            run.base = sha;
            where = `The pull request's head (commit ${sha.slice(0, 10)}) is already checked out on your branch, so the work you do is on top of it.`;
        }
        note(`Fetched ${label} (${sha.slice(0, 10)})${local ? ' and checked it out on the run branch' : ''}.`);
        const base = hasBase ? baseRef : 'origin/master';
        return `${where}
This task is about pull request ${label}. Go straight to it, no exploring first:
1. Bring in its base, already fetched and current: \`git merge ${base}\`. The output lists the conflicted files. If it merges cleanly there is nothing to resolve: say so in finish.
2. \`git diff --name-only --diff-filter=U\` lists what is conflicted. For each file, find the markers with \`grep -n '^<<<<<<<\\|^=======\\|^>>>>>>>' FILE\`, read only those lines and a few around them, and edit so the result keeps what both sides meant. Do not take one side wholesale unless the other side's change is already contained in it.
3. \`grep -rn '^<<<<<<< ' .\` must find nothing. Run the project's tests. Then \`git add -A\` and \`git commit --no-edit\`.
4. Call finish at once: which files conflicted, how you resolved each, and the test result. Do not re-check the merge afterwards, and do not go looking for a newer base: the base above is current.
You cannot push and there is no GitHub login, token or gh here. Do not look for one, in the environment, the sandbox's own files or any gateway: it does not exist and it is not your job. Your branch holds the merge; the person pushes it to the pull request.`;
    } catch (err) {
        note(`Could not fetch ${label}: ${err.message.split('\n')[0]}`);
        return `The task names pull request ${label}, but fetching it failed (${err.message.split('\n')[0].slice(0, 200)}). It may be private or the number may be wrong. Do not search for it: say in finish that the pull request could not be fetched.`;
    }
}

module.exports = { findPulls, prepare };
