// Apps: a registered app that people can ask to change itself. An app is a repo
// plus how to run it (dev server, tests) and which files an agent may touch. A
// change is a run on the `change-app` workflow, limited to the app's editable
// paths. One JSON file per app in <runs dir>/_apps, like agents.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hosting = require('./hosting');

const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const DEPLOYS = new Set(['merge', 'hook']);

/** "ui/**" -> a RegExp over repo-relative paths with forward slashes. * stays in one folder, ** crosses folders. */
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

/** A path as the repo sees it, or null when it points outside the repo. */
function repoPath(p) {
    const n = path.posix.normalize(String(p ?? '').replace(/\\/g, '/'));
    return !n || n === '.' || n === '..' || n.startsWith('../') || n.startsWith('/') || /^[a-z]:/i.test(n) ? null : n.replace(/^\.\//, '');
}

/** isEditable(path) for a list of globs; an empty list allows nothing. */
function editableMatcher(globs) {
    const res = (globs || []).map(globToRegExp);
    return (p) => {
        const n = repoPath(p);
        return n !== null && res.some((r) => r.test(n));
    };
}

class AppStore {
    constructor(dir) {
        this.dir = dir;
        this.apps = new Map();
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            try { const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (a?.id) this.apps.set(a.id, a); } catch { /* not an app file */ }
        }
    }

    save(app) {
        const file = path.join(this.dir, `${app.id}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(app, null, 2));
        fs.renameSync(`${file}.tmp`, file);
    }

    list() { return [...this.apps.values()].sort((a, b) => a.created.localeCompare(b.created)); }
    get(id) { return this.apps.get(id) || null; }

    static fields(cfg, current = {}) {
        const out = {};
        const has = (k) => cfg[k] !== undefined;
        if (has('name')) { out.name = clean(cfg.name, 60); if (!out.name) throw new Error('an app needs a name'); }
        for (const [k, n] of [['installCommand', 500], ['devCommand', 500], ['testCommand', 500], ['deployHook', 500], ['githubRepo', 100], ['baseBranch', 100]]) {
            if (has(k)) out[k] = clean(cfg[k], n) || null;
        }
        if (has('deployHook') && out.deployHook && !/^https?:\/\//i.test(out.deployHook)) throw new Error('deployHook must be an http(s) URL');
        if (out.githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(out.githubRepo)) throw new Error('GitHub repo must look like owner/name');
        if (out.baseBranch && !/^[\w./-]+$/.test(out.baseBranch)) throw new Error('base branch has odd characters');
        if (has('deployTarget')) out.deployTarget = hosting.targetId(cfg.deployTarget);
        if (has('database')) out.database = hosting.databaseId(cfg.database);
        if (has('deploy')) {
            if (!DEPLOYS.has(cfg.deploy)) throw new Error(`deploy must be one of ${[...DEPLOYS].join(', ')}`);
            out.deploy = cfg.deploy;
        }
        if (has('editablePaths')) {
            const list = (Array.isArray(cfg.editablePaths) ? cfg.editablePaths : String(cfg.editablePaths || '').split(/[\n,]/)).map((s) => clean(s, 200)).filter(Boolean);
            for (const g of list) if (repoPath(g.replace(/\*+/g, 'x')) === null) throw new Error(`editable path ${g} must stay inside the repo`);
            out.editablePaths = list.slice(0, 50);
        }
        if (has('previewPort')) {
            const n = cfg.previewPort === null || cfg.previewPort === '' ? null : Math.floor(Number(cfg.previewPort));
            if (n !== null && !(n >= 1024 && n <= 65535)) throw new Error('previewPort must be between 1024 and 65535');
            out.previewPort = n;
        }
        return { ...current, ...out };
    }

    create(cfg, repo) {
        const base = AppStore.fields(cfg);
        if (!base.name) throw new Error('an app needs a name');
        if (!base.editablePaths?.length) throw new Error('say which paths the agent may edit, for example ui/**');
        const now = new Date().toISOString();
        const app = {
            installCommand: null, devCommand: null, testCommand: null, deploy: 'merge', deployHook: null, githubRepo: null, baseBranch: null, previewPort: null, deployTarget: 'none', database: 'none',
            ...base, id: `p${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, repo, created: now, updated: now,
        };
        this.apps.set(app.id, app);
        this.save(app);
        return app;
    }

    update(id, cfg, repo) {
        const app = this.get(id);
        if (!app) throw new Error('no such app');
        const next = AppStore.fields(cfg, app);
        if (!next.editablePaths?.length) throw new Error('say which paths the agent may edit');
        if (repo) next.repo = repo;
        Object.assign(app, next, { updated: new Date().toISOString() });
        this.save(app);
        return app;
    }

    remove(id) {
        this.apps.delete(id);
        fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    }
}

module.exports = { AppStore, editableMatcher, globToRegExp, repoPath };
