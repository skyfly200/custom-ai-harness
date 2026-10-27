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

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { RunManager } = require('./runs');
const { listDrivers } = require('./sandbox');
const ticketFiles = require('./ticketFiles');

const ROOT = path.join(__dirname, '..');

function defaultRoots(env) {
    const extra = (env.RUNNER_ROOTS || '').split(path.delimiter).filter(Boolean);
    return extra.length ? extra : [path.join(ROOT, 'repos'), '/repos'];
}

function createApp(manager, { token = '', port = 3100 } = {}) {
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

    app.get('/runs', (req, res) => res.json({ runs: manager.list() }));
    app.get('/runs/repos', (req, res) => res.json({ repos: manager.repos(), roots: manager.roots }));
    // the sandbox drivers a run can pick, and whether each one's key is set
    app.get('/runs/sandboxes', (req, res) => res.json({ default: manager.sandboxKind, drivers: listDrivers() }));
    app.get('/runs/browse', (req, res) => {
        try { res.json(manager.browse(req.query.path)); } catch (err) { fail(res, err); }
    });
    app.post('/runs', (req, res) => {
        try { res.status(201).json(manager.create(req.body)); } catch (err) { fail(res, err); }
    });
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
    app.get('/agents', (req, res) => res.json({ agents: manager.listAgents() }));
    app.post('/agents', (req, res) => {
        try { res.status(201).json(manager.createAgent(req.body)); } catch (err) { fail(res, err); }
    });
    app.get('/agents/:id', (req, res) => {
        const agent = manager.getAgent(req.params.id);
        return agent ? res.json(agent) : fail(res, new Error('no such agent'), 404);
    });
    app.patch('/agents/:id', (req, res) => {
        try { res.json(manager.updateAgent(req.params.id, req.body)); } catch (err) { fail(res, err, /no such/.test(err.message) ? 404 : 400); }
    });
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
    app.get('/runs/:id', (req, res) => {
        const run = manager.get(req.params.id);
        return run ? res.json(run) : fail(res, new Error('no such run'), 404);
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
        try { res.status(201).json(manager.continueRun(req.params.id)); } catch (err) {
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
    const manager = new RunManager({
        dir: process.env.RUNNER_DIR || path.join(ROOT, 'runs'),
        roots: defaultRoots(process.env),
        harnessUrl: process.env.HARNESS_URL || 'http://localhost:3000',
        password: process.env.HARNESS_PASSWORD || '',
        maxRuns: Number(process.env.RUNNER_MAX_RUNS) || 2,
        autoDebug: /^(1|true|yes|on)$/i.test(process.env.RUNNER_AUTO_DEBUG || ''),
        // The default for runs that pick none. local: a git worktree on this machine. e2b: an E2B
        // cloud sandbox (E2B_API_KEY). sprites: a Fly Sprite (SPRITES_TOKEN).
        sandbox: process.env.RUNNER_SANDBOX || 'local',
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { manager.previews.stopAll(); process.exit(0); });
    createApp(manager, { token: process.env.RUNNER_TOKEN || '', port }).listen(port, process.env.RUNNER_HOST || '127.0.0.1', () => {
        console.log(`Task runner on port ${port}; repos in: ${manager.roots.join(', ')}; sandbox: ${manager.sandboxKind}`);
    });
}

module.exports = { createApp, defaultRoots };
