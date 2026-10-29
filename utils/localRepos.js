// Git repos on this machine, for the repo fields (chat Git repo, project repo, Agents repo) when the harness runs
// on the person's own computer. Never used on a hosted server: it must not list the server's own disk.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { localFoldersAvailable } = require('./repoTools');

const SKIP = new Set(['node_modules', 'venv', '.venv', 'dist', 'build', 'target', 'vendor', '__pycache__', 'AppData', 'Library', 'Applications']);
const COMMON = ['code', 'projects', 'dev', 'src', 'repos', 'source/repos', 'Documents/GitHub', 'Documents/code', 'GitHub', 'git', 'workspace'];
const MAX_DEPTH = 3;
const MAX_REPOS = 200;
const MAX_DIRS = 5000;
const TTL_MS = 60000;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Folders to look in: REPO_SCAN_ROOTS, else the folders the harness already works in, else common code folders in the home folder. */
function roots(env = process.env, { home = os.homedir(), cwd = process.cwd() } = {}) {
    const list = (v) => String(v || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
    let out = list(env.REPO_SCAN_ROOTS);
    if (!out.length) out = [...list(env.RUNNER_ROOTS), ...list(env.HARNESS_FILE_ROOTS)];
    if (!out.length) out = [path.dirname(cwd), ...COMMON.map((d) => path.join(home, d))];
    return [...new Set(out.map((r) => path.resolve(r.replace(/^~(?=$|[\\/])/, home))))].filter(isDir);
}

/** Git repos under the roots, at most MAX_DEPTH folders down. A repo is listed, not searched inside. */
function scan(rootList, { maxDepth = MAX_DEPTH, maxRepos = MAX_REPOS, maxDirs = MAX_DIRS } = {}) {
    const found = new Map();
    let seen = 0;
    const walk = (dir, depth) => {
        if (found.size >= maxRepos || seen++ >= maxDirs) return;
        if (fs.existsSync(path.join(dir, '.git'))) { found.set(dir, { path: dir, name: path.basename(dir) || dir }); return; }
        if (depth >= maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
            walk(path.join(dir, e.name), depth + 1);
        }
    };
    for (const r of rootList) walk(r, 0);
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path));
}

let cache = null;

/** { repos: [{ path, name }], roots, hosted }. A hosted server answers with nothing and never reads its disk. */
function list(env = process.env, opts = {}) {
    if (!localFoldersAvailable(env)) return { repos: [], roots: [], hosted: true };
    const key = JSON.stringify([env.REPO_SCAN_ROOTS, env.RUNNER_ROOTS, env.HARNESS_FILE_ROOTS]);
    if (!opts.fresh && cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;
    const r = roots(env, opts);
    const value = { repos: scan(r), roots: r, hosted: false };
    cache = { key, at: Date.now(), value };
    return value;
}

module.exports = { list, roots, scan };
