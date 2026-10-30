// Repos for hosted Runs: a person names a GitHub repo ("owner/name"), the runner keeps a clone of it for them,
// and a finished run's branch can be pushed back. The token (the person's own, from the Interceptor, for one
// request) goes to git as an Authorization header on that one command: it is not in the clone's remote URL,
// not on disk and not in a sandbox. Clones live in <base>/<person>/<owner>__<name>, so one person's runs can
// never be pointed at another's files.
'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SPEC = /^(?:github:|https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const BRANCH = /^harness\/[A-Za-z0-9._-]{1,80}$/;

/** { owner, name } from "owner/name", "github:owner/name" or a github.com URL; throws on anything else. */
function parse(spec) {
    const m = SPEC.exec(String(spec || '').trim());
    if (!m || m[2] === '.' || m[2] === '..') throw new Error('name the repo as owner/name on GitHub, for example skyfly200/custom-ai-harness');
    return { owner: m[1], name: m[2] };
}

const personDir = (base, person) => path.join(base, `${String(person).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40)}-${crypto.createHash('sha1').update(String(person)).digest('hex').slice(0, 8)}`);
const cloneDir = (base, person, { owner, name }) => path.join(personDir(base, person), `${owner}__${name}`);

function run(args, { cwd, token, timeoutMs = 120000 } = {}) {
    const auth = token ? ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
    return new Promise((resolve, reject) => {
        execFile('git', [...auth, ...args], { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' } }, (err, stdout, stderr) => {
            if (!err) return resolve(stdout);
            // never repeat a token, even though it is only on the command line
            const text = `${stderr || err.message}`.split(token || '\u0000').join('***').trim().split('\n').slice(-3).join(' ');
            reject(new Error(/Authentication failed|could not read Username|not found|403|401/i.test(text)
                ? `GitHub would not let the runner in (${token ? 'check the token can read this repo' : 'it may be private: connect a GitHub token first'})`
                : `git failed: ${text}`));
        });
    });
}

/** The person's clone of the repo, made or brought up to date. Resolves its path. */
async function ensureClone({ base, person, spec, token, git = run }) {
    const repo = parse(spec);
    const dir = cloneDir(base, person, repo);
    if (fs.existsSync(path.join(dir, '.git'))) {
        await git(['fetch', '--quiet', '--prune', '--no-tags', 'origin'], { cwd: dir, token });
        // move the checked-out branch along when that is a plain fast-forward; a person's own commits stay
        await git(['merge', '--quiet', '--ff-only', '@{u}'], { cwd: dir, token }).catch(() => {});
        return dir;
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
        await git(['clone', '--quiet', `https://github.com/${repo.owner}/${repo.name}.git`, dir], { token, timeoutMs: 600000 });
    } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
    }
    return dir;
}

/** Push a run's branch (harness/<id>) from the clone to GitHub. Resolves { branch, url }. */
async function pushBranch({ dir, branch, token, git = run }) {
    if (!BRANCH.test(branch)) throw new Error('only harness/ branches are pushed');
    if (!token) throw new Error('connect a GitHub token first (it needs Contents: read and write on this repo)');
    const remote = (await git(['remote', 'get-url', 'origin'], { cwd: dir })).trim();
    const repo = parse(remote);
    await git(['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: dir, token });
    return { branch, url: `https://github.com/${repo.owner}/${repo.name}/tree/${branch}`, compare: `https://github.com/${repo.owner}/${repo.name}/compare/${branch}?expand=1` };
}

/**
 * Open a pull request from a pushed run branch (pushing it first). `base` defaults to the repo's default
 * branch. A pull request that is already open for the branch is returned instead of failing.
 * Resolves { number, url, existed }. `fetchImpl` and `apiUrl` are injectable for tests.
 */
async function openPullRequest({ dir, branch, token, title, body = '', base = '', draft = false, git = run, fetchImpl = fetch, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com' }) {
    const pushed = await pushBranch({ dir, branch, token, git });
    const { owner, name } = parse((await git(['remote', 'get-url', 'origin'], { cwd: dir })).trim());
    const api = async (method, route, payload) => {
        const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${route}`, {
            method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'harness-runner' },
            ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000),
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    };
    const target = base || (await api('GET', `/repos/${owner}/${name}`)).data.default_branch || 'main';
    const made = await api('POST', `/repos/${owner}/${name}/pulls`, { title: String(title).slice(0, 200), head: branch, base: target, body, draft });
    if (made.ok) return { number: made.data.number, url: made.data.html_url, base: target, existed: false, pushed };
    if (made.status === 422) {
        const open = await api('GET', `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
        if (open.ok && open.data[0]) return { number: open.data[0].number, url: open.data[0].html_url, base: open.data[0].base?.ref || target, existed: true, pushed };
    }
    if (made.status === 401 || made.status === 403 || made.status === 404) throw new Error(`GitHub would not open the pull request (${made.status}): the token needs Pull requests: write on ${owner}/${name}`);
    throw new Error(`GitHub answered ${made.status}: ${String(made.data.message || '').slice(0, 200)}`);
}

/** The person's clones, as paths, for the repo picker. */
function listClones(base, person) {
    const dir = personDir(base, person);
    try { return fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((d) => fs.existsSync(path.join(d, '.git'))); } catch { return []; }
}

module.exports = { parse, ensureClone, pushBranch, openPullRequest, listClones, personDir, cloneDir, BRANCH };
