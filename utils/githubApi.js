// A chat linked to a GitHub repo ("owner/name"): tools that read it through GitHub's API (no clone, so they
// work on a hosted server) and, only with the person's say-so for each one, change it (issue, comment,
// pull request). The token is the person's own (utils/userGithub.js); everything the model sends is checked
// before it goes into a URL. Tools return text for the model, like utils/repoTools.js.
'use strict';

const { globToRegExp } = require('./repoTools');

const API = () => String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const MAX_OUTPUT = 60000;
const MAX_LINES = 2000;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cap = (text, max = MAX_OUTPUT) => (text.length > max ? `${text.slice(0, max)}\n[harness: cut at ${max} characters]` : text);
const clampInt = (v, def, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : def));

/** "owner/name" (or a github.com URL) as { owner, name, full }; throws on anything else. */
function parseRepo(spec) {
    const m = REPO_RE.exec(String(spec || '').trim().replace(/^(?:github:|https:\/\/github\.com\/)/, '').replace(/(?:\.git)?\/?$/, ''));
    if (!m || m[2] === '.' || m[2] === '..') throw fail('name the repo as owner/name on GitHub, for example skyfly200/custom-ai-harness');
    return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

async function api(token, path, { method = 'GET', body, fetchFn = fetch, accept = 'application/vnd.github+json' } = {}) {
    let res;
    try {
        res = await fetchFn(`${API()}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'custom-ai-harness', ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(20000),
        });
    } catch (err) {
        throw fail(`GitHub did not answer: ${err.message}`, 502);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
        const why = json?.message || text.slice(0, 200);
        if (res.status === 401) throw fail('GitHub did not accept the connection: connect GitHub again', 401);
        if (res.status === 404) throw fail(`GitHub says not found (${why}). The repo, path or ref may not exist, or your connection may not reach it`, 404);
        if (res.status === 403 && /rate limit/i.test(why)) throw fail('GitHub rate limit reached: try again in a minute', 429);
        throw fail(`GitHub answered HTTP ${res.status}: ${why}`, res.status === 403 ? 403 : 502);
    }
    return json ?? text;
}

const seg = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const refQuery = (ref) => (ref ? `?ref=${encodeURIComponent(checkRef(ref))}` : '');
function checkRef(ref) {
    const s = String(ref ?? '').trim();
    if (!s || s.startsWith('-') || /[\s\0]/.test(s)) throw fail(`not a valid ref: ${s}`);
    return s;
}
function checkPath(p) {
    const s = String(p ?? '').trim().replace(/^\/+/, '');
    if (!s || s.split('/').some((x) => x === '..' || x === '.')) throw fail(`not a valid path: ${p}`);
    return s;
}

/** The repos a person's connection reaches, newest push first: [{ full, private, description, branch, pushed }]. */
async function listRepos(token, { fetchFn = fetch, appMode = false, limit = 200 } = {}) {
    const out = [];
    const take = (r) => out.push({ full: r.full_name, private: !!r.private, description: r.description || '', branch: r.default_branch || 'main', pushed: r.pushed_at || '' });
    if (appMode) {
        // A GitHub App reaches only the repos it is installed on
        const inst = await api(token, '/user/installations?per_page=50', { fetchFn });
        for (const i of inst.installations || []) {
            const list = await api(token, `/user/installations/${i.id}/repositories?per_page=100`, { fetchFn });
            (list.repositories || []).forEach(take);
        }
    } else {
        for (let page = 1; page <= 3 && out.length < limit; page++) {
            const list = await api(token, `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`, { fetchFn });
            list.forEach(take);
            if (list.length < 100) break;
        }
    }
    return out.sort((a, b) => String(b.pushed).localeCompare(String(a.pushed))).slice(0, limit);
}

const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
});

const READ = [
    fn('github_list_files', 'List files in the linked GitHub repository (default branch unless ref is given). Paths use forward slashes.', {
        pattern: { type: 'string', description: 'Optional glob such as "*.py" or "src/**/*.ts", or plain text the path must contain' },
        ref: { type: 'string', description: 'Branch, tag or commit (default the default branch)' },
        limit: { type: 'integer', description: 'Most paths to return (default 500)' },
    }),
    fn('github_read_file', 'Read a text file from the linked GitHub repository, with line numbers.', {
        path: { type: 'string', description: 'Path relative to the repository root' },
        ref: { type: 'string', description: 'Branch, tag or commit (default the default branch)' },
        start_line: { type: 'integer', description: 'First line to read (1-based, default 1)' },
        end_line: { type: 'integer', description: `Last line to read (default start_line + ${MAX_LINES - 1})` },
    }, ['path']),
    fn('github_search', 'Search file contents in the linked GitHub repository (GitHub code search, default branch only). Returns the files that match, with matching lines.', {
        query: { type: 'string', description: 'Words or "an exact phrase" to find' },
        path: { type: 'string', description: 'Optional folder or file to search in' },
    }, ['query']),
    fn('github_log', 'Show recent commits of the linked GitHub repository.', {
        limit: { type: 'integer', description: 'Number of commits (default 20)' },
        path: { type: 'string', description: 'Only commits touching this path' },
        ref: { type: 'string', description: 'Branch, tag or commit to log from' },
    }),
    fn('github_branches', 'List the branches of the linked GitHub repository.'),
    fn('github_list_issues', 'List issues or pull requests of the linked GitHub repository.', {
        kind: { type: 'string', enum: ['issues', 'pulls'], description: 'issues (default) or pulls' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open' },
        limit: { type: 'integer', description: 'Most to return (default 20)' },
    }),
    fn('github_get_issue', 'Read one issue or pull request of the linked GitHub repository: its text, labels and comments (a pull request also lists its changed files).', {
        number: { type: 'integer', description: 'The issue or pull request number' },
    }, ['number']),
];

// These change GitHub, so the page asks the person first and sends confirmed: true
const WRITE = [
    fn('github_create_issue', 'Open an issue in the linked GitHub repository. The person is asked to approve it first.', {
        title: { type: 'string' }, body: { type: 'string', description: 'Markdown' },
        labels: { type: 'array', items: { type: 'string' } },
    }, ['title']),
    fn('github_comment', 'Comment on an issue or pull request of the linked GitHub repository. The person is asked to approve it first.', {
        number: { type: 'integer' }, body: { type: 'string', description: 'Markdown' },
    }, ['number', 'body']),
    fn('github_create_pull_request', 'Open a pull request in the linked GitHub repository from a branch that already exists there (this tool cannot push code). The person is asked to approve it first.', {
        title: { type: 'string' }, head: { type: 'string', description: 'The branch with the changes' },
        base: { type: 'string', description: 'The branch to merge into (default the default branch)' },
        body: { type: 'string', description: 'Markdown' }, draft: { type: 'boolean' },
    }, ['title', 'head']),
];

const NAMES = new Set([...READ, ...WRITE].map((d) => d.function.name));
const WRITES = new Set(WRITE.map((d) => d.function.name));

/** One line the person reads before allowing a change. */
function describe(name, args = {}, repo = '') {
    const clip = (s, n = 400) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));
    switch (name) {
        case 'github_create_issue': return `Open an issue in ${repo}: “${clip(args.title, 120)}”${args.body ? `\n\n${clip(args.body)}` : ''}`;
        case 'github_comment': return `Comment on #${args.number} in ${repo}:\n\n${clip(args.body)}`;
        case 'github_create_pull_request': return `Open a ${args.draft ? 'draft ' : ''}pull request in ${repo}: “${clip(args.title, 120)}” (${args.head} → ${args.base || 'default branch'})${args.body ? `\n\n${clip(args.body)}` : ''}`;
        default: return name;
    }
}

const num = (v) => { const n = Math.trunc(Number(v)); if (!Number.isFinite(n) || n < 1) throw fail('number must be a positive whole number'); return n; };
const str = (v, what, max = 65000) => { const s = String(v ?? '').trim(); if (!s) throw fail(`${what} is required`); if (s.length > max) throw fail(`${what} is too long`); return s; };

/** Run one tool for `repo` ("owner/name") with `token`. Throws on any problem; the caller turns that into an answer for the model. */
async function call({ token, repo, name, args = {}, confirmed = false, fetchFn = fetch }) {
    if (!NAMES.has(name)) throw fail(`no GitHub tool named ${name}`);
    if (!token) throw fail('GitHub is not connected: press Connect GitHub in the chat Options (Tools)', 401);
    if (WRITES.has(name) && confirmed !== true) throw fail('this changes GitHub and needs the person\'s approval, but the page sent none');
    const { full } = parseRepo(repo);
    const get = (path, opts) => api(token, path, { fetchFn, ...opts });
    switch (name) {
        case 'github_list_files': {
            const meta = await get(`/repos/${full}`);
            const ref = args.ref ? checkRef(args.ref) : meta.default_branch;
            const tree = await get(`/repos/${full}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
            let files = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
            const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
            if (pattern) {
                const re = /[*?]/.test(pattern) ? globToRegExp(pattern) : null;
                files = files.filter((f) => (re ? re.test(f) : f.toLowerCase().includes(pattern.toLowerCase())));
            }
            const limit = clampInt(args.limit, 500, 1, 5000);
            return cap(`${full} @ ${ref}: ${files.length} file${files.length === 1 ? '' : 's'}${pattern ? ` matching ${pattern}` : ''}${files.length > limit ? `, first ${limit} shown` : ''}${tree.truncated ? ' (GitHub cut the list: the repo is very large)' : ''}\n${files.slice(0, limit).join('\n')}`);
        }
        case 'github_read_file': {
            const p = checkPath(args.path);
            const file = await get(`/repos/${full}/contents/${seg(p)}${refQuery(args.ref)}`);
            if (Array.isArray(file)) throw fail(`${p} is a folder; use github_list_files`);
            if (file.type !== 'file') throw fail(`${p} is a ${file.type}, not a file`);
            if (file.encoding !== 'base64' || typeof file.content !== 'string') throw fail(`${p} is too large to read through the API (${(file.size || 0).toLocaleString()} bytes)`);
            const buf = Buffer.from(file.content, 'base64');
            if (buf.subarray(0, 8000).includes(0)) return `${p} is a binary file (${buf.length.toLocaleString()} bytes)`;
            const lines = buf.toString('utf8').split(/\r?\n/);
            if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
            const start = clampInt(args.start_line, 1, 1, Math.max(1, lines.length));
            const end = clampInt(args.end_line, start + MAX_LINES - 1, start, Math.min(lines.length, start + MAX_LINES - 1));
            const width = String(end).length;
            const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}  ${l}`).join('\n');
            return cap(`${p} (${lines.length} lines${start > 1 || end < lines.length ? `, lines ${start}-${end} shown` : ''})\n${body}`);
        }
        case 'github_search': {
            const query = str(args.query, 'query', 256);
            const scope = args.path ? ` path:${checkPath(args.path).replace(/\s/g, '')}` : '';
            const r = await get(`/search/code?per_page=20&q=${encodeURIComponent(`${query} repo:${full}${scope}`)}`, { accept: 'application/vnd.github.text-match+json' });
            if (!r.items?.length) return `no files match “${query}” in ${full}`;
            return cap(`${r.total_count} file${r.total_count === 1 ? '' : 's'} match${r.total_count === 1 ? 'es' : ''}${r.total_count > r.items.length ? ` (first ${r.items.length})` : ''}\n` + r.items.map((it) =>
                `${it.path}\n${(it.text_matches || []).slice(0, 3).map((m) => m.fragment.split('\n').map((l) => `  ${l}`).join('\n')).join('\n  ...\n')}`).join('\n\n'));
        }
        case 'github_log': {
            const q = new URLSearchParams({ per_page: String(clampInt(args.limit, 20, 1, 100)) });
            if (args.ref) q.set('sha', checkRef(args.ref));
            if (args.path) q.set('path', checkPath(args.path));
            const list = await get(`/repos/${full}/commits?${q}`);
            return cap(list.map((c) => `${c.sha.slice(0, 7)} ${String(c.commit.author?.date || '').slice(0, 10)} ${c.commit.author?.name || ''}: ${String(c.commit.message).split('\n')[0]}`).join('\n') || '(no commits)');
        }
        case 'github_branches': {
            const list = await get(`/repos/${full}/branches?per_page=100`);
            return list.map((b) => `${b.name}${b.protected ? ' (protected)' : ''}`).join('\n') || '(no branches)';
        }
        case 'github_list_issues': {
            const pulls = args.kind === 'pulls';
            const state = ['open', 'closed', 'all'].includes(args.state) ? args.state : 'open';
            const list = await get(`/repos/${full}/${pulls ? 'pulls' : 'issues'}?state=${state}&per_page=${clampInt(args.limit, 20, 1, 100)}`);
            const rows = (pulls ? list : list.filter((i) => !i.pull_request));
            return cap(rows.map((i) => `#${i.number} [${i.state}] ${i.title}${i.user ? ` (${i.user.login})` : ''}`).join('\n') || `(no ${state} ${pulls ? 'pull requests' : 'issues'})`);
        }
        case 'github_get_issue': {
            const n = num(args.number);
            const issue = await get(`/repos/${full}/issues/${n}`);
            const comments = await get(`/repos/${full}/issues/${n}/comments?per_page=30`);
            let out = `#${issue.number} [${issue.state}] ${issue.title}${issue.pull_request ? ' (pull request)' : ''}\nby ${issue.user?.login || '?'}${issue.labels?.length ? `, labels: ${issue.labels.map((l) => l.name).join(', ')}` : ''}\n\n${issue.body || '(no description)'}`;
            if (issue.pull_request) {
                const files = await get(`/repos/${full}/pulls/${n}/files?per_page=100`);
                out += `\n\nChanged files:\n${files.map((f) => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})`).join('\n')}`;
            }
            if (comments.length) out += `\n\nComments:\n${comments.map((c) => `--- ${c.user?.login || '?'}\n${c.body}`).join('\n')}`;
            return cap(out);
        }
        case 'github_create_issue': {
            const body = { title: str(args.title, 'title', 256), body: String(args.body || ''), ...(Array.isArray(args.labels) && args.labels.length ? { labels: args.labels.map(String).slice(0, 10) } : {}) };
            const r = await get(`/repos/${full}/issues`, { method: 'POST', body });
            return `opened issue #${r.number}: ${r.html_url}`;
        }
        case 'github_comment': {
            const r = await get(`/repos/${full}/issues/${num(args.number)}/comments`, { method: 'POST', body: { body: str(args.body, 'body') } });
            return `commented: ${r.html_url}`;
        }
        case 'github_create_pull_request': {
            const meta = args.base ? null : await get(`/repos/${full}`);
            const body = { title: str(args.title, 'title', 256), head: checkRef(args.head), base: args.base ? checkRef(args.base) : meta.default_branch, body: String(args.body || ''), draft: args.draft === true };
            const r = await get(`/repos/${full}/pulls`, { method: 'POST', body });
            return `opened pull request #${r.number}: ${r.html_url}`;
        }
    }
}

module.exports = { parseRepo, listRepos, call, describe, definitions: () => [...READ, ...WRITE], isGithubTool: (n) => NAMES.has(n), isWrite: (n) => WRITES.has(n) };
