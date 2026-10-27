// A live preview of a run's work: the app's dev server started inside the run's
// worktree, so you can look at what the agent changed while it is still a branch.
// Local runs only for now (the preview is http://localhost:PORT on this machine);
// cloud sandboxes will get their public URL later. One preview per run, stopped
// with the run's removal or when the runner exits. Starting a preview runs a command
// of your choosing, so the caller passes it through the guard first.
'use strict';

const net = require('net');
const { spawn, execFile } = require('child_process');

const FIRST_PORT = 5200;
const READY_MS = 60000;
const LOG_LINES = 80;
const ENV_ALLOW = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'SHELL', 'TERM', 'NODE_ENV'];

const freePort = (port) => new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
});
const accepting = (port) => new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1').once('connect', () => { c.destroy(); resolve(true); }).once('error', () => resolve(false));
});

class PreviewManager {
    constructor({ readyMs = READY_MS } = {}) {
        this.readyMs = readyMs;
        this.previews = new Map(); // run id -> { child, port, url, command, log, ready, exited, started }
    }

    async pickPort(want) {
        const taken = new Set([...this.previews.values()].map((p) => p.port));
        if (want) {
            if (taken.has(want) || !(await freePort(want))) throw new Error(`port ${want} is in use`);
            return want;
        }
        for (let p = FIRST_PORT; p < FIRST_PORT + 200; p++) if (!taken.has(p) && await freePort(p)) return p;
        throw new Error('no free port for a preview');
    }

    /**
     * Start `command` in `dir`. `{port}` in the command is replaced by the port, which is also
     * set as PORT. Resolves the preview's status once the port answers or readyMs pass.
     */
    async start(id, dir, command, { port } = {}) {
        if (this.previews.has(id) && !this.previews.get(id).exited) throw new Error('this run already has a preview; stop it first');
        const text = String(command || '').trim();
        if (!text) throw new Error('give the command that starts the app, for example: npm run dev -- --port {port}');
        if (text.length > 500) throw new Error('the command is too long');
        const chosen = await this.pickPort(port ? Number(port) : 0);
        const full = text.replaceAll('{port}', String(chosen));
        const env = Object.fromEntries(ENV_ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
        const child = spawn(full, { cwd: dir, env: { ...env, PORT: String(chosen) }, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        const p = { child, port: chosen, url: `http://localhost:${chosen}`, command: full, log: [], ready: false, exited: null, started: new Date().toISOString() };
        const add = (d) => { p.log.push(...String(d).split('\n').filter(Boolean)); if (p.log.length > LOG_LINES) p.log.splice(0, p.log.length - LOG_LINES); };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        child.on('error', (err) => { add(`could not start: ${err.message}`); p.exited = -1; });
        child.on('close', (code) => { p.exited = code ?? -1; });
        this.previews.set(id, p);
        const until = Date.now() + this.readyMs;
        while (Date.now() < until && p.exited === null && !p.ready) {
            p.ready = await accepting(chosen);
            if (!p.ready) await new Promise((r) => setTimeout(r, 250));
        }
        return this.status(id);
    }

    status(id) {
        const p = this.previews.get(id);
        if (!p) return { running: false };
        return { running: p.exited === null, ready: p.ready, url: p.url, port: p.port, command: p.command, started: p.started, exited: p.exited, log: p.log.slice(-30) };
    }

    stop(id) {
        const p = this.previews.get(id);
        if (!p) return;
        this.previews.delete(id);
        if (p.exited !== null || !p.child.pid) return;
        if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], () => {});
        else { try { process.kill(-p.child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    }

    stopAll() { for (const id of [...this.previews.keys()]) this.stop(id); }
}

module.exports = { PreviewManager, FIRST_PORT };
