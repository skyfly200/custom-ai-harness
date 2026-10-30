// Pull request state for runs: whether the PR is open, a draft, merged or closed, whether it has merge conflicts,
// and what its checks say. The runner asks GitHub (with the person's token on a hosted server, GITHUB_TOKEN or no
// token locally) and keeps the answer on the run, so the run and agent lists can show it without a request each.
'use strict';

const { findPulls } = require('./prBrief');

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** The pull request a run is about: the one it opened (run.pr), else the one its task named (run.prTarget), or null. */
function prRefOf(run) {
    if (run?.pr?.url) {
        const m = findPulls(run.pr.url)[0];
        if (m) return m;
    }
    const t = run?.prTarget;
    return t && t.owner && t.name && t.number ? { owner: t.owner, name: t.name, number: t.number } : null;
}

/**
 * The PR's state from GitHub. `conflict` is true (GitHub says the branch cannot merge cleanly), false, or null while
 * GitHub is still working it out (it computes this lazily, so the next check usually has it). `checks` is
 * 'passing', 'failing', 'pending' or 'none' for the head commit. Never throws: a failed call comes back as
 * { status: 'unknown', error }. `fetchImpl` and `apiUrl` are injectable for tests.
 */
async function fetchPullState({ owner, name, number }, { token = '', fetchImpl = fetch, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com' } = {}) {
    const checkedAt = new Date().toISOString();
    const api = async (route) => {
        const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${route}`, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'harness-runner', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            signal: AbortSignal.timeout(20000),
        });
        return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    };
    const base = `/repos/${owner}/${name}`;
    const pr = await api(`${base}/pulls/${number}`).catch((err) => ({ ok: false, status: 0, data: { message: err.message } }));
    if (!pr.ok) {
        const why = pr.status === 404 ? 'not found (it may be private: connect GitHub first)' : pr.status ? `GitHub answered ${pr.status}` : String(pr.data.message || 'no answer');
        return { status: 'unknown', conflict: null, checks: 'none', error: `${owner}/${name}#${number}: ${why}`, number, owner, name, checkedAt };
    }
    const d = pr.data;
    const status = d.merged_at || d.merged ? 'merged' : d.state === 'closed' ? 'closed' : d.draft ? 'draft' : 'open';
    const conflict = d.mergeable_state === 'dirty' || d.mergeable === false ? true : (d.mergeable === null || d.mergeable_state === 'unknown' || !d.mergeable_state ? null : false);
    let checks = 'none';
    let checkCounts = { total: 0, failing: 0, pending: 0 };
    if (status === 'open' || status === 'draft') {
        const sha = d.head?.sha;
        const list = sha ? await api(`${base}/commits/${sha}/check-runs?per_page=100`).catch(() => null) : null;
        const runs = list?.ok && Array.isArray(list.data.check_runs) ? list.data.check_runs : [];
        checkCounts = { total: runs.length, failing: runs.filter((c) => c.status === 'completed' && FAILED.has(c.conclusion)).length, pending: runs.filter((c) => c.status !== 'completed').length };
        checks = !runs.length ? 'none' : checkCounts.failing ? 'failing' : checkCounts.pending ? 'pending' : 'passing';
    }
    return {
        status, conflict, checks, checkCounts, error: null, number, owner, name, checkedAt,
        title: String(d.title || '').slice(0, 200), url: d.html_url || `https://github.com/${owner}/${name}/pull/${number}`,
        base: d.base?.ref || null, head: d.head?.ref || null, headSha: d.head?.sha || null, mergeableState: d.mergeable_state || null,
    };
}

module.exports = { prRefOf, fetchPullState };
