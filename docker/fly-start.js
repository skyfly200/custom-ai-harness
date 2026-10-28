#!/usr/bin/env node
/**
 * Fly launcher: Gateway, Router and Interceptor in one Machine (see Dockerfile.fly, docs/fly.md).
 *
 * With HARNESS_RUNS=1 a fourth process, the task runner, is started for the Runs page (hosted mode, loopback only, cloud sandboxes only).
 * The Gateway and Router listen on 127.0.0.1 only; the Interceptor on :3000 is the one Fly publishes.
 * The files an admin edits in the app (config.yaml, routellm-config.yaml) live on the volume at
 * HARNESS_DATA_DIR (default /app/data) so a deploy doesn't undo the Routing page. They are copied
 * from the image the first time; when a later image carries a different copy, it is saved beside
 * the volume's as <name>.new and the volume's copy is left alone.
 *
 * If any of the three stops, the rest are stopped and this exits non-zero, so Fly restarts the Machine.
 * The Interceptor stops the Machine on purpose (the Stop button, or HARNESS_IDLE_STOP_MIN idle minutes) by sending
 * this process SIGTERM: everything is stopped and this exits 0, which the Machine's "on-failure" restart policy leaves stopped.
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const DATA = process.env.HARNESS_DATA_DIR || '/app/data';
const SEEDED = ['config.yaml', 'routellm-config.yaml'];

/** Copy the image's copy of each file onto the volume once; note a changed one as <name>.new. Returns the log lines. */
function seed(appDir = APP, dataDir = DATA) {
    fs.mkdirSync(dataDir, { recursive: true });
    const notes = [];
    for (const name of SEEDED) {
        const from = path.join(appDir, name);
        const to = path.join(dataDir, name);
        if (!fs.existsSync(from)) continue;
        if (!fs.existsSync(to)) {
            fs.copyFileSync(from, to);
            notes.push(`${name}: copied to ${to}`);
        } else if (!fs.readFileSync(from).equals(fs.readFileSync(to))) {
            fs.copyFileSync(from, `${to}.new`);
            notes.push(`${name}: this version ships a different copy; saved as ${to}.new, yours is unchanged`);
        }
    }
    return notes;
}

/** The processes: Gateway, Router, Interceptor, and (HARNESS_RUNS=1) the task runner for Runs. */
function commands(dataDir = DATA, env = process.env) {
    const runs = /^(1|true|yes|on)$/i.test(env.HARNESS_RUNS || '');
    // Shared by the Interceptor and the runner for this boot only: the runner trusts the Interceptor's word about
    // whose request it is, and the Interceptor trusts the runner's calls on a run owner's behalf.
    const runnerToken = env.RUNNER_TOKEN || crypto.randomBytes(24).toString('hex');
    const config = path.join(dataDir, 'config.yaml');
    const shared = {
        PYTHONUTF8: '1',
        HARNESS_GATEWAY_CONFIG: config,
        GATEWAY_CONFIG: config,
        HARNESS_SETTINGS_FILE: path.join(dataDir, 'harness-settings.json'),
        HARNESS_PROFILES_FILE: path.join(dataDir, 'routing-profiles.json'),
        HARNESS_USAGE_FILE: path.join(dataDir, 'harness-usage.json'),
        HARNESS_USERS_FILE: path.join(dataDir, 'users.json'),
        MCP_CONFIG: path.join(dataDir, 'mcp-servers.json'),
    };
    const list = [
        { name: 'gateway', cmd: 'python', args: ['docker/gateway-start.py'],
          env: { GATEWAY_SOURCE: config, GATEWAY_TARGET: '/tmp/config.yaml', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '4000' } },
        { name: 'router', cmd: 'python', args: ['router.py', '--config', path.join(dataDir, 'routellm-config.yaml'), '--host', '127.0.0.1', '--port', '6060'], env: {} },
        { name: 'interceptor', cmd: 'node', args: ['server.js'],
          env: { GATEWAY_URL: 'http://127.0.0.1:4000', ROUTER_URL: 'http://127.0.0.1:6060', OPENROUTER_PROXY_URL: 'http://127.0.0.1:3000',
                 HARNESS_STOP_VIA_PARENT: '1',
                 ...(runs ? { HARNESS_HOSTED_RUNS: '1', RUNNER_TOKEN: runnerToken, RUNNER_URL: 'http://127.0.0.1:3100' } : {}) } },
        ...(runs ? [{ name: 'runner', cmd: 'node', args: ['runner/server.js'],
          env: { RUNNER_HOSTED: '1', RUNNER_TOKEN: runnerToken, RUNNER_PORT: '3100', HARNESS_URL: 'http://127.0.0.1:3000',
                 RUNNER_DIR: path.join(dataDir, 'runs'), RUNNER_REPOS_DIR: path.join(dataDir, 'repos') } }] : []),
    ];
    return list.map((c) => ({ ...c, env: { ...env, ...shared, ...c.env } }));
}

function main() {
    process.chdir(APP);
    for (const line of seed()) console.log(`[fly-start] ${line}`);
    const children = [];
    let stopping = false;
    const stopAll = (code) => {
        if (stopping) return;
        stopping = true;
        for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
        setTimeout(() => process.exit(code), 5000).unref();
        Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))))).then(() => process.exit(code));
    };
    for (const c of commands()) {
        const child = spawn(c.cmd, c.args, { cwd: APP, env: c.env, stdio: 'inherit' });
        children.push(child);
        child.on('exit', (code, signal) => {
            if (!stopping) console.error(`[fly-start] ${c.name} stopped (${signal || code}); stopping the rest`);
            stopAll(stopping ? 0 : 1);
        });
        child.on('error', (err) => { console.error(`[fly-start] ${c.name}: ${err.message}`); stopAll(1); });
    }
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
}

if (require.main === module) main();

module.exports = { seed, commands };
