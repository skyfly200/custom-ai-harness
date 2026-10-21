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
    app.get('/runs/browse', (req, res) => {
        try { res.json(manager.browse(req.query.path)); } catch (err) { fail(res, err); }
    });
    app.post('/runs', (req, res) => {
        try { res.status(201).json(manager.create(req.body)); } catch (err) { fail(res, err); }
    });
    app.get('/runs/:id', (req, res) => {
        const run = manager.get(req.params.id);
        return run ? res.json(run) : fail(res, new Error('no such run'), 404);
    });
    app.get('/runs/:id/diff', async (req, res) => {
        if (!manager.get(req.params.id)) return fail(res, new Error('no such run'), 404);
        res.type('text/plain').send(await manager.diff(req.params.id));
    });
    app.post('/runs/:id/approve', (req, res) => {
        try { manager.approve(req.params.id, req.body?.allow === true); res.json({ ok: true }); } catch (err) { fail(res, err, 409); }
    });
    app.post('/runs/:id/stop', (req, res) => {
        try { manager.stop(req.params.id); res.json({ ok: true }); } catch (err) { fail(res, err, 409); }
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
    });
    createApp(manager, { token: process.env.RUNNER_TOKEN || '', port }).listen(port, process.env.RUNNER_HOST || '127.0.0.1', () => {
        console.log(`Task runner on port ${port}; repos in: ${manager.roots.join(', ')}`);
    });
}

module.exports = { createApp, defaultRoots };
