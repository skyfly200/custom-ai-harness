'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gh = require('../utils/githubApi');

const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
// A fake GitHub: routes by "METHOD path" substring
function fake(routes) {
    const seen = [];
    const fetchFn = async (url, init = {}) => {
        const u = new URL(url);
        const key = `${init.method || 'GET'} ${u.pathname}${u.search}`;
        seen.push({ key, init, body: init.body ? JSON.parse(init.body) : null });
        for (const [k, v] of Object.entries(routes)) if (key.startsWith(k)) return typeof v === 'function' ? v(key, init) : v.clone();
        return json({ message: 'Not Found' }, 404);
    };
    return { fetchFn, seen };
}
const b64 = (t) => Buffer.from(t).toString('base64');
const run = (f, name, args, extra = {}) => gh.call({ token: 'ghu_t', repo: 'skyfly200/custom-ai-harness', name, args, fetchFn: f.fetchFn, ...extra });

test('parseRepo takes owner/name, github: and URLs, and nothing else', () => {
    assert.equal(gh.parseRepo('skyfly200/custom-ai-harness').full, 'skyfly200/custom-ai-harness');
    assert.equal(gh.parseRepo('https://github.com/a/b.git').full, 'a/b');
    assert.equal(gh.parseRepo('github:a/b').full, 'a/b');
    for (const bad of ['', 'a', 'a/b/c', '../x', 'a/..', 'a/b?x=1', 'a b/c']) assert.throws(() => gh.parseRepo(bad), /owner\/name/, bad);
});

test('list files uses the default branch, filters by glob, and says when GitHub cut the list', async () => {
    const f = fake({
        'GET /repos/skyfly200/custom-ai-harness/git/trees/main': json({ truncated: false, tree: [{ type: 'blob', path: 'a.js' }, { type: 'tree', path: 'src' }, { type: 'blob', path: 'src/b.ts' }, { type: 'blob', path: 'src/c.js' }] }),
        'GET /repos/skyfly200/custom-ai-harness': json({ default_branch: 'main' }),
    });
    const all = await run(f, 'github_list_files', {});
    assert.match(all, /@ main: 3 files/);
    const js = await run(f, 'github_list_files', { pattern: '*.js' });
    assert.match(js, /2 files matching \*\.js/);
    assert.ok(js.includes('src/c.js') && !js.includes('b.ts'));
    assert.equal(f.seen[0].init.headers.authorization, 'Bearer ghu_t');
});

test('read file decodes, numbers lines, takes a range, and refuses folders and binaries', async () => {
    const f = fake({
        'GET /repos/skyfly200/custom-ai-harness/contents/docs/a.md?ref=dev': json({ type: 'file', encoding: 'base64', content: b64('one\ntwo\nthree\n') }),
        'GET /repos/skyfly200/custom-ai-harness/contents/bin': json({ type: 'file', encoding: 'base64', content: Buffer.from([1, 0, 2]).toString('base64') }),
        'GET /repos/skyfly200/custom-ai-harness/contents/docs': json([{ name: 'a.md' }]),
    });
    const out = await run(f, 'github_read_file', { path: 'docs/a.md', ref: 'dev', start_line: 2, end_line: 3 });
    assert.match(out, /docs\/a\.md \(3 lines, lines 2-3 shown\)\n2  two\n3  three$/);
    assert.match(await run(f, 'github_read_file', { path: 'bin' }), /binary file/);
    await assert.rejects(run(f, 'github_read_file', { path: 'docs' }), /is a folder/);
});

test('paths and refs from the model cannot climb out or become options', async () => {
    const f = fake({});
    await assert.rejects(run(f, 'github_read_file', { path: '../../etc/passwd' }), /not a valid path/);
    await assert.rejects(run(f, 'github_read_file', { path: 'a', ref: '--upload-pack=x' }), /not a valid ref/);
    await assert.rejects(run(f, 'github_log', { ref: 'a b' }), /not a valid ref/);
    assert.equal(f.seen.length, 0);
});

test('search scopes the query to the repo and shows matching lines', async () => {
    const f = fake({ 'GET /search/code': json({ total_count: 1, items: [{ path: 'server.js', text_matches: [{ fragment: 'const app = express();' }] }] }) });
    const out = await run(f, 'github_search', { query: 'express', path: 'server.js' });
    assert.match(out, /1 file matches/);
    assert.ok(out.includes('server.js') && out.includes('const app = express();'));
    const q = new URL(`https://x${f.seen[0].key.split(' ')[1]}`).searchParams.get('q');
    assert.equal(q, 'express repo:skyfly200/custom-ai-harness path:server.js');
});

test('log, branches, issues and one issue read as plain text; issues leave out pull requests', async () => {
    const f = fake({
        'GET /repos/skyfly200/custom-ai-harness/commits': json([{ sha: 'abcdef1234', commit: { message: 'Fix it\n\nlong', author: { name: 'Sky', date: '2026-10-01T00:00:00Z' } } }]),
        'GET /repos/skyfly200/custom-ai-harness/branches': json([{ name: 'main', protected: true }, { name: 'dev' }]),
        'GET /repos/skyfly200/custom-ai-harness/issues/7/comments': json([{ user: { login: 'bob' }, body: 'me too' }]),
        'GET /repos/skyfly200/custom-ai-harness/issues/7': json({ number: 7, state: 'open', title: 'Crash', body: 'It breaks', user: { login: 'amy' }, labels: [{ name: 'bug' }] }),
        'GET /repos/skyfly200/custom-ai-harness/issues?': json([{ number: 7, state: 'open', title: 'Crash', user: { login: 'amy' } }, { number: 8, state: 'open', title: 'A PR', pull_request: {} }]),
    });
    assert.equal(await run(f, 'github_log', {}), 'abcdef1 2026-10-01 Sky: Fix it');
    assert.equal(await run(f, 'github_branches', {}), 'main (protected)\ndev');
    assert.equal(await run(f, 'github_list_issues', {}), '#7 [open] Crash (amy)');
    const one = await run(f, 'github_get_issue', { number: 7 });
    assert.ok(one.includes('Crash') && one.includes('labels: bug') && one.includes('me too'));
});

test('changes need the confirmation, then post exactly what was approved', async () => {
    const f = fake({
        'POST /repos/skyfly200/custom-ai-harness/issues/3/comments': json({ html_url: 'https://github.com/x/1' }),
        'POST /repos/skyfly200/custom-ai-harness/issues': json({ number: 9, html_url: 'https://github.com/x/9' }),
        'POST /repos/skyfly200/custom-ai-harness/pulls': json({ number: 10, html_url: 'https://github.com/x/pull/10' }),
        'GET /repos/skyfly200/custom-ai-harness': json({ default_branch: 'main' }),
    });
    for (const [name, args] of [['github_create_issue', { title: 'T' }], ['github_comment', { number: 3, body: 'B' }], ['github_create_pull_request', { title: 'T', head: 'fix' }]]) {
        await assert.rejects(run(f, name, args), /needs the person's approval/);
        await assert.rejects(run(f, name, args, { confirmed: 'yes' }), /needs the person's approval/);
    }
    assert.equal(f.seen.length, 0, 'nothing reached GitHub unconfirmed');
    assert.match(await run(f, 'github_create_issue', { title: 'Bug', body: 'text', labels: ['bug'] }, { confirmed: true }), /issue #9/);
    assert.deepEqual(f.seen[0].body, { title: 'Bug', body: 'text', labels: ['bug'] });
    assert.match(await run(f, 'github_comment', { number: 3, body: 'hi' }, { confirmed: true }), /commented/);
    assert.match(await run(f, 'github_create_pull_request', { title: 'PR', head: 'fix', draft: true }, { confirmed: true }), /pull request #10/);
    const pr = f.seen.find((s) => s.key.startsWith('POST') && s.key.endsWith('/pulls'));
    assert.deepEqual(pr.body, { title: 'PR', head: 'fix', base: 'main', body: '', draft: true });
    assert.equal(gh.isWrite('github_comment'), true);
    assert.equal(gh.isWrite('github_log'), false);
    assert.match(gh.describe('github_create_pull_request', { title: 'PR', head: 'fix' }, 'a/b'), /pull request in a\/b: “PR” \(fix → default branch\)/);
});

test('no token, bad token, missing repo and rate limits each say what to do', async () => {
    await assert.rejects(gh.call({ token: null, repo: 'a/b', name: 'github_branches' }), /Connect GitHub/);
    await assert.rejects(gh.call({ token: 't', repo: 'a/b', name: 'github_nope' }), /no GitHub tool/);
    await assert.rejects(run(fake({ 'GET': json({ message: 'Bad credentials' }, 401) }), 'github_branches', {}), /connect GitHub again/);
    await assert.rejects(run(fake({}), 'github_branches', {}), /not found/);
    await assert.rejects(run(fake({ 'GET': json({ message: 'API rate limit exceeded' }, 403) }), 'github_branches', {}), /rate limit/);
});

test('listRepos: an OAuth/token connection lists /user/repos; a GitHub App lists its installations, newest first', async () => {
    const repo = (n, pushed, priv = false) => ({ full_name: n, private: priv, default_branch: 'main', pushed_at: pushed, description: null });
    const a = fake({ 'GET /user/repos': json([repo('a/old', '2026-01-01'), repo('a/new', '2026-10-01', true)]) });
    const list = await gh.listRepos('t', { fetchFn: a.fetchFn });
    assert.deepEqual(list.map((r) => [r.full, r.private]), [['a/new', true], ['a/old', false]]);
    const b = fake({
        'GET /user/installations/5/repositories': json({ repositories: [repo('o/x', '2026-05-01')] }),
        'GET /user/installations?': json({ installations: [{ id: 5 }] }),
    });
    assert.deepEqual((await gh.listRepos('t', { fetchFn: b.fetchFn, appMode: true })).map((r) => r.full), ['o/x']);
});

test('Actions: workflows, runs, one run with its failing step, and the tail of a job log', async () => {
    const f = fake({
        'GET /repos/skyfly200/custom-ai-harness/actions/workflows?': json({ workflows: [{ id: 5, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }),
        'GET /repos/skyfly200/custom-ai-harness/actions/workflows/ci.yml/runs?': json({ workflow_runs: [{ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', created_at: '2026-10-28T10:00:00Z' }] }),
        'GET /repos/skyfly200/custom-ai-harness/actions/runs/9/jobs': json({ jobs: [{ id: 42, name: 'test', status: 'completed', conclusion: 'failure', steps: [{ number: 1, name: 'Run tests', conclusion: 'failure' }] }] }),
        'GET /repos/skyfly200/custom-ai-harness/actions/runs/9': json({ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'abcdef123', html_url: 'https://github.com/x/actions/runs/9' }),
        'GET /repos/skyfly200/custom-ai-harness/actions/jobs/42/logs': new Response(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')),
    });
    assert.equal(await run(f, 'github_list_workflows', {}), 'ci.yml (id 5, active): CI');
    assert.match(await run(f, 'github_list_runs', { workflow: 'ci.yml' }), /^#9 CI \[failure\] main 2026-10-28 10:00$/);
    const one = await run(f, 'github_get_run', { run_id: 9 });
    assert.ok(one.includes('job 42 test [failure]') && one.includes('1. Run tests [failure]'));
    const log = await run(f, 'github_job_logs', { job_id: 42, tail_lines: 5 });
    assert.match(log, /^\[last 5 of 300 lines\]\nline 296\n.*line 300$/s);
});

test('Actions changes need the confirmation and send what was approved', async () => {
    const f = fake({
        'POST /repos/skyfly200/custom-ai-harness/actions/workflows/deploy.yml/dispatches': new Response(null, { status: 204 }),
        'POST /repos/skyfly200/custom-ai-harness/actions/runs/9/rerun-failed-jobs': new Response('{}', { status: 201 }),
        'POST /repos/skyfly200/custom-ai-harness/actions/runs/9/cancel': new Response('{}', { status: 202 }),
        'GET /repos/skyfly200/custom-ai-harness': json({ default_branch: 'main' }),
    });
    for (const [name, args] of [['github_run_workflow', { workflow: 'deploy.yml' }], ['github_rerun', { run_id: 9 }], ['github_cancel_run', { run_id: 9 }]]) {
        assert.equal(gh.isWrite(name), true);
        await assert.rejects(run(f, name, args), /needs the person's approval/);
    }
    assert.equal(f.seen.length, 0);
    assert.match(await run(f, 'github_run_workflow', { workflow: 'deploy.yml', inputs: { env: 'prod', n: 2 } }, { confirmed: true }), /started deploy\.yml on main/);
    assert.deepEqual(f.seen.at(-1).body, { ref: 'main', inputs: { env: 'prod', n: '2' } });
    assert.match(await run(f, 'github_rerun', { run_id: 9, failed_only: true }, { confirmed: true }), /run #9 started again/);
    assert.match(await run(f, 'github_cancel_run', { run_id: 9 }, { confirmed: true }), /cancel requested/);
    assert.match(gh.describe('github_run_workflow', { workflow: 'deploy.yml', ref: 'dev', inputs: { a: '1' } }, 'a/b'), /Run workflow deploy\.yml in a\/b on dev\n\nInputs: \{"a":"1"\}/);
    await assert.rejects(run(f, 'github_run_workflow', { workflow: '' }, { confirmed: true }), /workflow is required/);
});
