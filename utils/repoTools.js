// Read-only tools over a git repository on this machine, for chats linked to
// a repo on the chat page. Every call runs git without a shell, and file paths
// must stay inside the repository.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// A hosted server (Fly, Docker with a database) has no folders of the person's own. Folder repos and the
// shell are for the harness running on their computer; HARNESS_LOCAL_REPOS=1 turns them back on.
function localFoldersAvailable(env = process.env) {
    if (/^(1|true|yes|on)$/i.test(env.HARNESS_LOCAL_REPOS || '')) return true;
    return !(env.HARNESS_SERVER === '1' || env.DATABASE_URL);
}

const HOSTED_MESSAGE = 'a folder repo is a folder on your own computer, and this is a hosted server, so it cannot reach it: unlink it and attach a GitHub repo instead (Options > Tools > Connect GitHub)';

// What a folder path from the page may be on this machine; throws a plain reason when it cannot be used here
function checkFolderPath(dir, { platform = process.platform, env = process.env } = {}) {
    if (!localFoldersAvailable(env)) throw new Error(HOSTED_MESSAGE);
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('give the path of a folder inside a git repository');
    const text = dir.trim();
    if (platform !== 'win32' && (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\'))) {
        throw new Error(`${text} is a Windows path, but the harness runs on ${platform} here and cannot open it`);
    }
    return text;
}

const MAX_OUTPUT = 60000;     // characters of git output handed to the model
const MAX_LINES = 2000;       // lines per read_file call
const GIT_TIMEOUT_MS = 30000;

function git(cwd, args, { allowFail = false } = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            if (err && !(allowFail && typeof err.code === 'number')) {
                const why = err.code === 'ENOENT' ? 'git is not installed or not on PATH' : (stderr || err.message).trim();
                return reject(new Error(why));
            }
            resolve({ stdout: String(stdout), code: err ? err.code : 0 });
        });
    });
}

function cap(text, max = MAX_OUTPUT) {
    return text.length > max ? `${text.slice(0, max)}\n[harness: cut at ${max} characters]` : text;
}

// A ref, commit or range from the model. Anything starting with "-" would be read as an option.
function checkRef(ref) {
    if (ref == null || ref === '') return null;
    const s = String(ref).trim();
    if (s.startsWith('-') || /[\s\0]/.test(s)) throw new Error(`not a valid ref: ${s}`);
    return s;
}

/** The repository holding `dir`: its top folder, name, branch and remote. */
async function inspect(dir) {
    const folder = path.resolve(checkFolderPath(dir).replace(/^~(?=$|[\\/])/, require('os').homedir()));
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`no folder at ${folder}`);
    let top;
    try {
        top = (await git(folder, ['rev-parse', '--show-toplevel'])).stdout.trim();
    } catch (err) {
        throw new Error(/not a git repository/i.test(err.message) ? `${folder} is not inside a git repository` : err.message);
    }
    top = path.resolve(top);
    const branch = (await git(top, ['branch', '--show-current'], { allowFail: true })).stdout.trim();
    const head = (await git(top, ['log', '-1', '--format=%h %s'], { allowFail: true })).stdout.trim();
    const remote = (await git(top, ['remote', 'get-url', 'origin'], { allowFail: true })).stdout.trim();
    const changed = (await git(top, ['status', '--porcelain'], { allowFail: true })).stdout.split('\n').filter(Boolean).length;
    return { path: top, name: path.basename(top), branch: branch || null, head: head || null, remote: remote || null, changed };
}

// A path the model gave, resolved inside the repository (symlinks included)
function insideRepo(repo, file) {
    if (typeof file !== 'string' || !file.trim()) throw new Error('path is required');
    const full = path.resolve(repo, file.trim());
    const rel = path.relative(repo, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside the repository`);
    if (fs.existsSync(full)) {
        const real = fs.realpathSync(full);
        const realRel = path.relative(fs.realpathSync(repo), real);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error(`${file} links outside the repository`);
    }
    if (rel.split(path.sep)[0] === '.git') throw new Error('the .git folder is not readable through this tool');
    return full;
}

// "*.js", "src/**/*.ts" -> RegExp over forward-slash paths
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i');
}

const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
});

const DEFINITIONS = [
    fn('repo_list_files', 'List files in the linked git repository (tracked and untracked, minus ignored ones). Paths use forward slashes.', {
        pattern: { type: 'string', description: 'Optional glob such as "*.py" or "src/**/*.ts", or plain text the path must contain' },
        limit: { type: 'integer', description: 'Most paths to return (default 500)' },
    }),
    fn('repo_read_file', 'Read a text file from the linked git repository, with line numbers.', {
        path: { type: 'string', description: 'Path relative to the repository root' },
        start_line: { type: 'integer', description: 'First line to read (1-based, default 1)' },
        end_line: { type: 'integer', description: `Last line to read (default start_line + ${MAX_LINES - 1})` },
    }, ['path']),
    fn('repo_search', 'Search file contents in the linked git repository (git grep). Returns matching lines as path:line:text.', {
        query: { type: 'string', description: 'Text to find' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression (default false: plain text)' },
        ignore_case: { type: 'boolean', description: 'Ignore case (default true)' },
        path: { type: 'string', description: 'Optional folder or file to search in' },
    }, ['query']),
    fn('repo_git_status', 'Show the current branch and uncommitted changes in the linked git repository.'),
    fn('repo_git_log', 'Show recent commits in the linked git repository.', {
        limit: { type: 'integer', description: 'Number of commits (default 20)' },
        path: { type: 'string', description: 'Only commits touching this path' },
        ref: { type: 'string', description: 'Branch, tag or range to log (default the current branch)' },
    }),
    fn('repo_git_diff', 'Show changes in the linked git repository: uncommitted changes by default, or against a ref or range.', {
        ref: { type: 'string', description: 'Optional ref or range such as "main", "HEAD~3" or "main...feature"' },
        staged: { type: 'boolean', description: 'Show only staged changes' },
        path: { type: 'string', description: 'Optional path to limit the diff to' },
    }),
    fn('repo_git_show', 'Show one commit (message and patch) from the linked git repository.', {
        ref: { type: 'string', description: 'Commit hash, branch or tag (default HEAD)' },
    }),
];

const NAMES = new Set(DEFINITIONS.map(d => d.function.name));
const clampInt = (v, def, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : def));
const rel = (repo, full) => path.relative(repo, full).split(path.sep).join('/') || '.';

async function call(repoDir, name, args = {}) {
    if (!NAMES.has(name)) throw new Error(`no repo tool named ${name}`);
    const { path: repo } = await inspect(repoDir);
    switch (name) {
        case 'repo_list_files': {
            const out = (await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean);
            let files = [...new Set(out)];
            const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
            if (pattern) {
                const re = /[*?]/.test(pattern) ? globToRegExp(pattern) : null;
                files = files.filter(f => (re ? re.test(f) : f.toLowerCase().includes(pattern.toLowerCase())));
            }
            const limit = clampInt(args.limit, 500, 1, 5000);
            const shown = files.slice(0, limit);
            return `${files.length} file${files.length === 1 ? '' : 's'}${pattern ? ` matching ${pattern}` : ''}${files.length > limit ? `, first ${limit} shown` : ''}\n${shown.join('\n')}`;
        }
        case 'repo_read_file': {
            const full = insideRepo(repo, args.path);
            if (!fs.existsSync(full)) throw new Error(`no file at ${rel(repo, full)}`);
            if (fs.statSync(full).isDirectory()) throw new Error(`${rel(repo, full)} is a folder; use repo_list_files`);
            const buf = fs.readFileSync(full);
            if (buf.subarray(0, 8000).includes(0)) return `${rel(repo, full)} is a binary file (${buf.length.toLocaleString()} bytes)`;
            const lines = buf.toString('utf8').split(/\r?\n/);
            if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // the file's final newline
            const start = clampInt(args.start_line, 1, 1, Math.max(1, lines.length));
            const end = clampInt(args.end_line, start + MAX_LINES - 1, start, Math.min(lines.length, start + MAX_LINES - 1));
            const width = String(end).length;
            const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}  ${l}`).join('\n');
            const more = end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}; ask for start_line ${end + 1} to read on]` : '';
            return cap(`${rel(repo, full)} (${lines.length} lines)\n${body}${more}`);
        }
        case 'repo_search': {
            if (typeof args.query !== 'string' || !args.query) throw new Error('query is required');
            const flags = ['grep', '-n', '-I', '--untracked', '--no-color', args.regex ? '-E' : '-F'];
            if (args.ignore_case !== false) flags.push('-i');
            flags.push('-e', args.query, '--');
            if (args.path) flags.push(rel(repo, insideRepo(repo, args.path)));
            const { stdout, code } = await git(repo, flags, { allowFail: true });
            if (code === 1 || !stdout.trim()) return `No matches for ${JSON.stringify(args.query)}.`;
            const lines = stdout.split('\n').filter(Boolean);
            const shown = lines.slice(0, 300).map(l => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
            return cap(`${lines.length} matching line${lines.length === 1 ? '' : 's'}${lines.length > 300 ? ', first 300 shown' : ''}\n${shown.join('\n')}`);
        }
        case 'repo_git_status':
            return (await git(repo, ['status', '--short', '--branch'])).stdout.trim() || 'Clean.';
        case 'repo_git_log': {
            const flags = ['log', `-n${clampInt(args.limit, 20, 1, 200)}`, '--date=short', '--format=%h %ad %an: %s'];
            const ref = checkRef(args.ref);
            if (ref) flags.push(ref);
            flags.push('--');
            if (args.path) flags.push(rel(repo, insideRepo(repo, args.path)));
            return (await git(repo, flags)).stdout.trim() || 'No commits.';
        }
        case 'repo_git_diff': {
            const flags = ['diff', '--no-color', '--stat', '--patch'];
            if (args.staged) flags.push('--staged');
            const ref = checkRef(args.ref);
            if (ref) flags.push(ref);
            flags.push('--');
            if (args.path) flags.push(rel(repo, insideRepo(repo, args.path)));
            return cap((await git(repo, flags)).stdout.trim() || 'No changes.');
        }
        case 'repo_git_show': {
            const ref = checkRef(args.ref) || 'HEAD';
            return cap((await git(repo, ['show', '--no-color', '--stat', '--patch', ref, '--'])).stdout.trim());
        }
    }
}

module.exports = { inspect, localFoldersAvailable, checkFolderPath, HOSTED_MESSAGE, call, definitions: () => DEFINITIONS, isRepoTool: (name) => NAMES.has(name), globToRegExp, insideRepo };
