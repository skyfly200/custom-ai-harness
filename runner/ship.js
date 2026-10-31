// Ship and undo for an app's change: a verdict on the diff, then push the run's branch,
// open a pull request and merge it on GitHub (the app's own pipeline deploys after the
// merge), and later undo with a revert pull request. Git history is the audit trail.
// Needs GITHUB_TOKEN with Pull requests and Contents write. The GitHub address and the
// fetch are injectable so tests run against a fake.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { globToRegExp } = require('./apps');
const { authArgs } = require('./github');

const RISKY = ['**/auth*', '**/*auth/**', '**/login*', '**/*payment*', '**/*billing*', '**/migrations/**', '**/*.sql', '**/.env*', '**/*secret*', '**/*credential*', '**/package-lock.json', '.github/**', 'Dockerfile', 'docker-compose.yml'];
const RISKY_RES = RISKY.map(globToRegExp);
const BIG_FILES = 15;
const BIG_LINES = 400;

// token: a person's GitHub token for this one command on a shared server (never kept in the repo or its remote)
const git = (cwd, args, token = '') => new Promise((resolve, reject) => execFile('git', [...authArgs(token), ...args], { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(`git ${args[0]} failed: ${String(errOut || err.message).split(token || '\u0000').join('***').trim().slice(0, 300)}`)) : resolve(out))));

/** "owner/name" from an origin URL (https or ssh), or null. */
function parseRemote(url) {
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
    return m ? `${m[1]}/${m[2]}` : null;
}

/** Facts about a finished change, for the person deciding. Advice; the gate is `blocked`. */
async function verdict(run, repoDir) {
    const base = run.result?.commit ? await git(repoDir, ['merge-base', run.result.commit, run.base && run.base !== 'HEAD' ? run.base : 'HEAD']).then((s) => s.trim()).catch(() => null) : null;
    const files = [];
    let lines = 0;
    if (base) {
        const numstat = (await git(repoDir, ['diff', '--numstat', base, run.result.commit])).split('\n').filter(Boolean);
        for (const row of numstat) {
            const [a, d, ...f] = row.split('\t');
            files.push(f.join('\t'));
            lines += (Number(a) || 0) + (Number(d) || 0);
        }
    }
    const risky = files.filter((f) => RISKY_RES.some((r) => r.test(f)));
    const blocked = [];
    if (run.status !== 'done') blocked.push(`the change run ended ${run.status}, not done`);
    if (!run.result?.commit) blocked.push('it made no commit');
    if (run.result?.outside?.length) blocked.push(`it changed files outside the editable paths: ${run.result.outside.join(', ')}`);
    if (run.result?.tests && !run.result.tests.passed) blocked.push('the tests fail');
    const notes = [];
    if (!run.result?.tests) notes.push('no tests were run');
    if (files.length > BIG_FILES || lines > BIG_LINES) notes.push(`a large change (${files.length} files, ${lines} lines)`);
    if (risky.length) notes.push(`touches sensitive files: ${risky.join(', ')}`);
    return { files, lines, risky, tests: run.result?.tests ? run.result.tests.passed : null, blocked, notes, canShip: blocked.length === 0 };
}

class Shipper {
    constructor({ token = process.env.GITHUB_TOKEN, api = process.env.GITHUB_API_URL || 'https://api.github.com', fetchImpl = fetch } = {}) {
        this.token = token; this.api = api.replace(/\/$/, ''); this.fetch = fetchImpl;
    }

    // token: the person's own on a shared server ('' when they have not connected GitHub); otherwise GITHUB_TOKEN
    async gh(method, route, body, token = this.token) {
        if (!token) throw new Error('connect GitHub to ship changes, or set GITHUB_TOKEN in .env (Pull requests and Contents write)');
        const res = await this.fetch(`${this.api}${route}`, {
            method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'harness-runner' },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${String(data.message || '').slice(0, 200)}`);
        return data;
    }

    async repoOf(app, repoDir) {
        const slug = app.githubRepo || parseRemote(await git(repoDir, ['remote', 'get-url', 'origin']).catch(() => ''));
        if (!slug) throw new Error('could not tell which GitHub repo this is; set "GitHub repo" (owner/name) on the app');
        return slug;
    }

    /** Push `branch`, open a PR into `base`, merge it. Returns { pr, url, mergeCommit }. */
    async pushAndMerge({ repoDir, slug, branch, base, title, body, token }) {
        await git(repoDir, ['push', 'origin', `${branch}:refs/heads/${branch}`], token);
        const pr = await this.gh('POST', `/repos/${slug}/pulls`, { title, head: branch, base, body }, token);
        const merged = await this.gh('PUT', `/repos/${slug}/pulls/${pr.number}/merge`, { merge_method: 'merge' }, token);
        if (!merged.merged) throw new Error(`GitHub did not merge pull request ${pr.number}: ${merged.message || 'unknown'}`);
        return { pr: pr.number, url: pr.html_url, mergeCommit: merged.sha };
    }

    /** Push the branch and open a pull request, without merging. A draft when it touches sensitive files. */
    async openPr({ run, app, repoDir, base, draft = false, token }) {
        const slug = await this.repoOf(app, repoDir);
        await git(repoDir, ['push', 'origin', `${run.branch}:refs/heads/${run.branch}`], token);
        const kind = run.proposal?.kind === 'error' ? 'Fix' : 'Improve';
        const pr = await this.gh('POST', `/repos/${slug}/pulls`, {
            title: `${kind}: ${app.name} (proposed by the in-app agent)`, head: run.branch, base, draft,
            body: `Proposed from inside ${app.name} (run ${run.id}); nobody asked for this change in so many words, so it needs a person's review and is never merged or deployed automatically.\n\n${run.result?.summary || ''}`,
        }, token);
        return { pr: pr.number, url: pr.html_url, slug };
    }

    async ship({ run, app, repoDir, base, token }) {
        const slug = await this.repoOf(app, repoDir);
        const title = `${app.name}: ${run.goal.split('\n')[0].replace(/^Change the app "[^"]*": /, '').slice(0, 70)}`;
        const body = `Requested from inside ${app.name}, written by an agent (run ${run.id}).\n\n${run.result?.summary || ''}\n\nUndo with a revert pull request from the Agents page.`;
        const out = await this.pushAndMerge({ repoDir, slug, branch: run.branch, base, title, body, token });
        return { ...out, slug, base, at: new Date().toISOString() };
    }

    /** A revert pull request for a shipped change, merged the same way. */
    async undo({ run, app, repoDir, token }) {
        const { slug, base, mergeCommit } = run.ship;
        const branch = `harness/revert-${run.id}`;
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-revert-'));
        const work = path.join(tmp, 'w');
        try {
            await git(repoDir, ['fetch', 'origin', base], token);
            await git(repoDir, ['worktree', 'add', '-q', '-B', branch, work, `origin/${base}`]);
            const parents = (await git(work, ['rev-list', '--parents', '-n', '1', mergeCommit])).trim().split(' ').length - 1;
            await git(work, ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost', 'revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), mergeCommit]);
            const out = await this.pushAndMerge({ repoDir: work, slug, branch, base, title: `Revert: ${app.name} change ${run.id}`, body: `Undo of pull request ${run.ship.pr}, from the Agents page.`, token });
            return { ...out, at: new Date().toISOString() };
        } finally {
            await git(repoDir, ['worktree', 'remove', '--force', work]).catch(() => {});
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    /** Tell the app's deploy hook a merge happened (deploy: 'hook'). Never throws. */
    async deploy(app) {
        if (app.deploy !== 'hook' || !app.deployHook) return { deploy: 'merge' };
        try {
            const res = await this.fetch(app.deployHook, { method: 'POST', signal: AbortSignal.timeout(15000) });
            return { deploy: 'hook', hookStatus: res.status };
        } catch (err) { return { deploy: 'hook', hookError: err.message }; }
    }
}

module.exports = { Shipper, verdict, parseRemote };
