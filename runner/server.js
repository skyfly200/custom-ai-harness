// The task runner: a separate process from the Interceptor (ADR 0002 keeps the
// Model Layer stateless), listening on 127.0.0.1:3100. The Interceptor proxies
// /ui/api/runs to it after its own login check. It reaches the models and the
// command guard through the Interceptor like any other client.
//
// Because it runs commands, it only answers requests that (1) came to a
// loopback Host name (so a web page can't reach it by DNS rebinding), (2) carry
// RUNNER_TOKEN when one is set (npm run all sets one, shared with the
// Interceptor), and (3) are JSON for anything that changes something.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { RunManager } = require('./runs');
const { listDrivers } = require('./sandbox');
const ticketFiles = require('./ticketFiles');
const github = require('./github');

const ROOT = path.join(__dirname, '..');

function defaultRoots(env) {
    const extra = (env.RUNNER_ROOTS || '').split(path.delimiter).filter(Boolean);
    return extra.length ? extra : [path.join(ROOT, 'repos'), '/repos'];
}

// hosted: a runner shared by several people (RUNNER_HOSTED=1). Every request names its owner (x-runner-owner, set by the
// Interceptor after its own login check), a person only sees their own runs and agents, repos are GitHub repos cloned per
// person under reposBase (never a path on this machine), and the person's GitHub token arrives per request and is not kept.
function createApp(manager, { token = '', port = 3100, hosted = false, reposBase = '', git = github } = {}) {
    const app = express();
    const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...(process.env.RUNNER_ALLOWED_HOSTS || '').split(',').filter(Boolean)]);
    const want = token && crypto.createHash('sha256').update(token).digest();
    app.use((req, res, next) => {
        if (!hosts.has(req.headers.host)) return res.status(403).json({ error: 'unknown host' });
        if (want) {
            const got = crypto.createHash('sha256').update(String(req.headers['x-runner-token'] || '')).digest();
            if (!crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'runner token required' });
        }
        if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
        next();
    });
    app.use(express.json({ limit: '1mb' }));

    const fail = (res, err, status = 400) => res.status(status).json({ error: err.message });
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => fail(res, err, err.status || (/no such/.test(err.message) ? 404 : 400)));

    if (hosted) {
        app.use((req, res, next) => {
            req.owner = String(req.headers['x-runner-owner'] || '');
            req.githubToken = String(req.headers['x-runner-github-token'] || '');
            if (!req.owner) return res.status(400).json({ error: 'x-runner-owner is required on a hosted runner' });
            next();
        });
        // these work on paths of this machine or on the local sandbox, which a shared server doesn't offer
        app.use(['/runs/browse', '/tickets', '/apps'], (req, res) => res.status(404).json({ error: 'not available on a shared server' }));
        app.use('/runs/:id/preview', (req, res) => res.status(404).json({ error: 'previews are not available on a shared server' }));
        // a run or agent that is not yours does not exist
        app.param('id', (req, res, next, id) => {
            const rec = req.path.startsWith('/agents') ? manager.agents.get(id) : manager.get(id);
            return rec && rec.owner === req.owner ? next() : res.status(404).json({ error: req.path.startsWith('/agents') ? 'no such agent' : 'no such run' });
        });
    }
    // The body a person may send: in a hosted runner the owner is who is asking, and the repo is a GitHub repo, cloned for them
    const prepare = async (req, { repo = true } = {}) => {
        const body = { ...(req.body || {}) };
        delete body.owner;
        if (hosted) {
            body.owner = req.owner;
            if (repo && body.repo !== undefined && body.repo !== null && body.repo !== '') body.repo = await git.ensureClone({ base: reposBase, person: req.owner, spec: body.repo, token: req.githubToken });
            else if (repo && body.repo !== undefined) delete body.repo;
        }
        return body;
    };

    app.get('/runs', (req, res) => res.json({ runs: manager.list(hosted ? req.owner : undefined) }));
    app.get('/runs/repos', (req, res) => res.json(hosted ? { repos: git.listClones(reposBase, req.owner), roots: [], hosted: true } : { repos: manager.repos(), roots: manager.roots, hosted: false }));
    // the sandbox drivers a run can pick, and whether each one's key is set
    app.get('/runs/sandboxes', (req, res) => res.json({ default: manager.sandboxKind, drivers: listDrivers() }));
    app.get('/runs/browse', (req, res) => {
        try { res.json(manager.browse(req.query.path)); } catch (err) { fail(res, err); }
    });
    app.post('/runs', wrap(async (req, res) => { res.status(201).json(manager.create(await prepare(req))); }));
    // Push a finished run's branch to the person's GitHub repo (hosted only: a local run's branch is yours to push)
    app.post('/runs/:id/push', wrap(async (req, res) => {
        if (!hosted) return fail(res, new Error('push the branch from your own checkout'), 404);
        const run = manager.get(req.params.id);
        if (!run.result?.commit || ['queued', 'running', 'waiting'].includes(run.status)) return fail(res, new Error('this run has no finished changes to push'), 409);
        const out = await git.pushBranch({ dir: run.repo, branch: run.branch, token: req.githubToken });
        run.pushed = { ...out, at: new Date().toISOString() };
        manager.save(run);
        res.json(out);
    }));
    // Push the branch (if it is not yet) and open a pull request for it (hosted only)
    app.post('/runs/:id/pr', wrap(async (req, res) => {
        if (!hosted) return fail(res, new Error('open the pull request from your own checkout'), 404);
        const run = manager.get(req.params.id);
        if (!run.result?.commit || ['queued', 'running', 'waiting'].includes(run.status)) return fail(res, new Error('this run has no finished changes to open a pull request for'), 409);
        const title = String(req.body?.title || '').trim() || run.goal.split('\n')[0].slice(0, 100);
        const body = `${String(req.body?.body || '').trim() || (run.result.summary || '').slice(0, 3000)}\n\n_Written by an agent (run ${run.id}) and opened by its owner._`;
        const out = await git.openPullRequest({ dir: run.repo, branch: run.branch, token: req.githubToken, title, body, base: String(req.body?.base || ''), draft: req.body?.draft === true });
        run.pushed = { ...out.pushed, at: new Date().toISOString() };
        run.pr = { number: out.number, url: out.url, base: out.base, at: run.pushed.at };
        manager.save(run);
        res.json(run.pr);
    }));
    // Write a ticket draft as wayfinder markdown files in the repo. Without confirm: true it
    // only says what would be written, so a page can show it and ask first.
    app.post('/tickets/files', (req, res) => {
        try {
            const { tickets, repo, confirm } = req.body || {};
            const dir = manager.checkRepo(repo);
            const plan = ticketFiles.plan(tickets);
            if (confirm !== true) return res.json({ repo: dir, folder: `${ticketFiles.ROOT}/${plan.folder}`, files: plan.files.map((f) => ({ name: f.name, title: f.title })) });
            res.status(201).json(ticketFiles.writeFiles(tickets, dir));
        } catch (err) { fail(res, err); }
    });
    // Read a wayfinder folder (relative to the repo) back into a ticket draft
    app.post('/tickets/read', (req, res) => {
        try {
            const dir = manager.checkRepo(req.body?.repo);
            const target = path.resolve(dir, String(req.body?.folder || ''));
            if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('the folder must be inside the repo');
            res.json(ticketFiles.readTicketFiles(target));
        } catch (err) { fail(res, err); }
    });
    // Agents: named, long-lived; their tasks are runs
    app.get('/agents', (req, res) => res.json({ agents: manager.listAgents(hosted ? req.owner : undefined) }));
    app.post('/agents', wrap(async (req, res) => { res.status(201).json(manager.createAgent(await prepare(req))); }));
    app.get('/agents/:id', (req, res) => {
        const agent = manager.getAgent(req.params.id);
        return agent ? res.json(agent) : fail(res, new Error('no such agent'), 404);
    });
    app.patch('/agents/:id', wrap(async (req, res) => { res.json(manager.updateAgent(req.params.id, await prepare(req))); }));
    app.delete('/agents/:id', (req, res) => {
        try { manager.removeAgent(req.params.id); res.json({ ok: true }); } catch (err) { fail(res, err, /no such/.test(err.message) ? 404 : 409); }
    });
    app.post('/agents/:id/tasks', (req, res) => {
        try { res.status(201).json(manager.assign(req.params.id, req.body)); } catch (err) { fail(res, err, /no such agent/.test(err.message) ? 404 : 400); }
    });
    // Apps: registered apps whose own agent changes them, limited to editable paths
    app.get('/apps', (req, res) => res.json({ apps: manager.listApps() }));
    app.post('/apps', (req, res) => {
        try { res.status(201).json(manager.createApp(req.body)); } catch (err) { fail(res, err); }
    });
    app.get('/apps/:id', (req, res) => {
        const a = manager.getApp(req.params.id);
        return a ? res.json(a) : fail(res, new Error('no such app'), 404);
    });
    app.patch('/apps/:id', (req, res) => {
        try { res.json(manager.updateApp(req.params.id, req.body)); } catch (err) { fail(res, err, /no such/.test(err.message) ? 404 : 400); }
    });
    app.delete('/apps/:id', (req, res) => {
        try { manager.removeApp(req.params.id); res.json({ ok: true }); } catch (err) { fail(res, err, /no such/.test(err.message) ? 404 : 409); }
    });
    app.post('/apps/:id/changes', (req, res) => {
        try { res.status(201).json(manager.askChange(req.params.id, req.body)); } catch (err) { fail(res, err, /no such app/.test(err.message) ? 404 : 400); }
    });
    // Ship and undo a change to an app (merge on GitHub; undo is a revert pull request)
    app.get('/runs/:id/ship', async (req, res) => {
        try { res.json(await manager.shipStatus(req.params.id)); } catch (err) { fail(res, err, /no such run/.test(err.message) ? 404 : 400); }
    });
    app.post('/runs/:id/ship', async (req, res) => {
        try { res.status(201).json(await manager.shipChange(req.params.id)); } catch (err) { fail(res, err, /no such run/.test(err.message) ? 404 : 409); }
    });
    app.post('/runs/:id/undo', async (req, res) => {
        try { res.status(201).json(await manager.undoChange(req.params.id)); } catch (err) { fail(res, err, /no such run/.test(err.message) ? 404 : 409); }
    });
    app.post('/apps/:id/proposals', (req, res) => {
        try { res.status(201).json(manager.askProposal(req.params.id, req.body)); } catch (err) { fail(res, err, /no such app/.test(err.message) ? 404 : /already|at most/.test(err.message) ? 429 : 400); }
    });
    app.get('/runs/:id', (req, res) => {
        const run = manager.get(req.params.id);
        return run ? res.json(run) : fail(res, new Error('no such run'), 404);
    });
    // The change as a patch file: git apply it, or open it in an editor
    app.get('/runs/:id/patch', async (req, res) => {
        const run = manager.get(req.params.id);
        if (!run) return fail(res, new Error('no such run'), 404);
        res.type('text/plain').send(await manager.patch(req.params.id));
    });
    app.get('/runs/:id/diff', async (req, res) => {
        if (!manager.get(req.params.id)) return fail(res, new Error('no such run'), 404);
        res.type('text/plain').send(await manager.diff(req.params.id));
    });
    // Preview: the run's dev server, so its work can be looked at (local runs)
    app.post('/runs/:id/preview', async (req, res) => {
        try { res.status(201).json(await manager.startPreview(req.params.id, req.body)); } catch (err) {
            if (err.needsApproval) return res.status(409).json({ error: err.message, needsApproval: true });
            fail(res, err, /no such run/.test(err.message) ? 404 : 400);
        }
    });
    app.get('/runs/:id/preview', (req, res) => (manager.get(req.params.id) ? res.json(manager.previewStatus(req.params.id)) : fail(res, new Error('no such run'), 404)));
    app.delete('/runs/:id/preview', (req, res) => { manager.stopPreview(req.params.id); res.json({ ok: true }); });
    app.post('/runs/:id/approve', (req, res) => {
        try { manager.approve(req.params.id, req.body?.allow === true); res.json({ ok: true }); } catch (err) { fail(res, err, 409); }
    });
    app.post('/runs/:id/stop', (req, res) => {
        try { manager.stop(req.params.id); res.json({ ok: true }); } catch (err) { fail(res, err, 409); }
    });
    // The same task again on a fresh branch; debug: told what went wrong last time
    app.post('/runs/:id/retry', (req, res) => {
        try { res.status(201).json(manager.retry(req.params.id, { debug: req.body?.debug === true })); } catch (err) {
            fail(res, err, /no such run/.test(err.message) ? 404 : 409);
        }
    });
    // The same run carried on after it ran out of steps or time: same id, same branch,
    // not a new run (Retry is for a run that failed)
    app.post('/runs/:id/continue', (req, res) => {
        try { res.status(201).json(manager.continueRun(req.params.id, { message: req.body?.message })); } catch (err) {
            fail(res, err, /no such run/.test(err.message) ? 404 : 409);
        }
    });
    app.delete('/runs/:id', async (req, res) => {
        try { await manager.remove(req.params.id); res.json({ ok: true }); } catch (err) { fail(res, err, 409); }
    });
    return app;
}

if (require.main === module) {
    require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
    const port = Number(process.env.RUNNER_PORT) || 3100;
    const hosted = /^(1|true|yes|on)$/i.test(process.env.RUNNER_HOSTED || '');
    if (hosted && !process.env.RUNNER_TOKEN) throw new Error('RUNNER_HOSTED needs RUNNER_TOKEN: the runner trusts the Interceptor\'s word about whose request it is. Refusing to start.');
    const reposBase = process.env.RUNNER_REPOS_DIR || path.join(process.env.HARNESS_DATA_DIR || ROOT, 'repos');
    if (hosted) fs.mkdirSync(reposBase, { recursive: true });
    const manager = new RunManager({
        dir: process.env.RUNNER_DIR || path.join(ROOT, 'runs'),
        roots: hosted ? [reposBase] : defaultRoots(process.env),
        hosted,
        token: process.env.RUNNER_TOKEN || '',
        limits: {
            perUser: Number(process.env.RUNNER_USER_MAX_RUNS) || 2,
            monthlyMinutes: Number(process.env.RUNNER_USER_MONTHLY_MINUTES) || 0,
            maxMinutes: Number(process.env.RUNNER_USER_MAX_MINUTES) || 30,
            defaultCost: Number(process.env.RUNNER_USER_MAX_COST) || 2,
        },
        harnessUrl: process.env.HARNESS_URL || 'http://localhost:3000',
        password: process.env.HARNESS_PASSWORD || '',
        maxRuns: Number(process.env.RUNNER_MAX_RUNS) || 2,
        autoDebug: /^(1|true|yes|on)$/i.test(process.env.RUNNER_AUTO_DEBUG || ''),
        // The default for runs that pick none. local: a git worktree on this machine. e2b: an E2B
        // cloud sandbox (E2B_API_KEY). sprites: a Fly Sprite (SPRITES_TOKEN).
        sandbox: process.env.RUNNER_SANDBOX || (hosted ? (process.env.SPRITES_TOKEN ? 'sprites' : 'e2b') : 'local'),
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { manager.previews.stopAll(); process.exit(0); });
    createApp(manager, { token: process.env.RUNNER_TOKEN || '', port, hosted, reposBase }).listen(port, process.env.RUNNER_HOST || '127.0.0.1', () => {
        console.log(`Task runner on port ${port}; repos in: ${manager.roots.join(', ')}; sandbox: ${manager.sandboxKind}`);
    });
}

module.exports = { createApp, defaultRoots };
