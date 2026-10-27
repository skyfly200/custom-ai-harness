// ChatDev as an external tool: a run with the workflow "ChatDev" starts a cloud
// sandbox (a Fly Sprite by default), installs ChatDev 2.0 (OpenBMB/ChatDev) in it,
// points its models at this harness (BASE_URL = the harness's /v1, so every call is
// routed, capped and logged like any other), runs one workflow through ChatDev's
// HTTP API and brings what it wrote back as a commit on the run's branch.
//
// The sandbox is the safety boundary: ChatDev's own agents run files and commands
// inside it, out of reach of the command guard. It never gets the harness's keys,
// only CHATDEV_API_KEY (an API key made for it under Users, see docs/logins.md).
'use strict';

const fs = require('fs');
const path = require('path');
const posix = path.posix;
const sandboxes = require('./sandbox');

const PORT = 6400;
const OUT_DIR = 'chatdev-output';
const DEFAULT_WORKFLOW = path.join(__dirname, '..', 'chatdev', 'dev-team.yaml');
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const SERVER_WAIT_MS = 180000;

/** The .env ChatDev reads: where its models are and the model name the workflow YAML uses (${MODEL_NAME}). */
function envFile({ harnessUrl, apiKey, model }) {
    const base = String(harnessUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new Error('ChatDev runs in the cloud, so it needs a public address for the harness: set CHATDEV_HARNESS_URL in .env (a Cloudflare tunnel, see docs/phone-and-app.md)');
    if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base)) throw new Error('CHATDEV_HARNESS_URL points at this machine, which the sandbox cannot reach; use the tunnel or server address');
    return `BASE_URL=${base}/v1\nAPI_KEY=${apiKey || 'none'}\nMODEL_NAME=${model}\n`;
}

/** The request ChatDev's POST /api/workflow/execute takes. */
function requestBody({ id, graph, goal }) {
    return JSON.stringify({ session_name: id, graph_content: graph, task_prompt: goal });
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function executeChatDev(manager, run, live) {
    const kind = run.sandbox && sandboxes.isCloud(run.sandbox) ? run.sandbox : 'sprites';
    const graphFile = process.env.CHATDEV_WORKFLOW || DEFAULT_WORKFLOW;
    const graph = fs.readFileSync(graphFile, 'utf8');
    const env = envFile({ harnessUrl: process.env.CHATDEV_HARNESS_URL, apiKey: process.env.CHATDEV_API_KEY, model: run.model || process.env.CHATDEV_MODEL || DEFAULT_MODEL });

    const sandbox = await sandboxes.createSandbox({ kind, repo: run.repo, dir: path.join(manager.dir, run.id, 'work'), branch: run.branch, base: run.base || 'HEAD' });
    live.sandbox = sandbox;
    run.base = sandbox.base;
    run.sandboxId = sandbox.id;
    manager.save(run);
    const home = posix.join(posix.dirname(sandbox.dir), 'chatdev');
    const out = posix.join(sandbox.dir, OUT_DIR, run.id);
    manager.event(run, { type: 'note', text: `ChatDev on branch ${run.branch} in ${kind === 'sprites' ? 'a Fly Sprite' : 'an E2B sandbox'} (${sandbox.id}); its models go through ${process.env.CHATDEV_HARNESS_URL}.` });

    const deadline = Date.now() + run.maxMinutes * 60000;
    const left = () => Math.max(1000, deadline - Date.now());
    const stopped = () => live.stopped;
    const sh = async (label, command, timeoutMs) => {
        manager.event(run, { type: 'note', text: label });
        const r = await sandbox.exec(`export PATH="$HOME/.local/bin:$PATH"; ${command}`, { timeoutMs: Math.min(timeoutMs, left()) });
        if (r.timedOut) throw new Error(`${label}: timed out`);
        if (r.code !== 0 && !stopped()) throw new Error(`${label} failed (exit ${r.code}):\n${r.output.slice(-1500)}`);
        return r;
    };

    const repoUrl = process.env.CHATDEV_REPO || 'https://github.com/OpenBMB/ChatDev';
    const ref = process.env.CHATDEV_REF;
    await sh('Installing ChatDev', `[ -d ${q(home)}/.git ] || git clone -q --depth 1 ${ref ? `--branch ${q(ref)} ` : ''}${q(repoUrl)} ${q(home)}`, 300000);
    if (stopped()) return { status: 'stopped', summary: 'Stopped before ChatDev started.' };
    await sh('Installing its dependencies (uv sync)', `command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; cd ${q(home)} && uv sync`, 1200000);
    if (stopped()) return { status: 'stopped', summary: 'Stopped before ChatDev started.' };

    const files = sandbox.sandbox.files;
    await files.write(posix.join(home, '.env'), env);
    await files.write(posix.join(home, 'request.json'), requestBody({ id: run.id, graph, goal: run.goal }));

    await sh('Starting ChatDev', `cd ${q(home)} && (nohup uv run python server_main.py --port ${PORT} > chatdev-server.log 2>&1 &) ; for i in $(seq 1 ${Math.ceil(SERVER_WAIT_MS / 2000)}); do curl -s -o /dev/null http://127.0.0.1:${PORT}/ && exit 0; sleep 2; done; tail -n 30 chatdev-server.log; exit 1`, SERVER_WAIT_MS + 30000);
    if (stopped()) return { status: 'stopped', summary: 'Stopped before the workflow ran.' };

    manager.event(run, { type: 'note', text: 'Running the workflow' });
    const call = await sandbox.exec(`cd ${q(home)} && mkdir -p ${q(out)} && curl -sS -X POST http://127.0.0.1:${PORT}/api/workflow/execute -H 'Content-Type: application/json' --data @request.json -o ${q(posix.join(out, 'response.json'))} -w '%{http_code}'`, { timeoutMs: left() });
    if (stopped()) return { status: 'stopped', summary: 'Stopped while ChatDev was working.' };
    if (call.timedOut) return { status: 'out_of_time', summary: 'ChatDev did not finish in the run\'s minutes.' };

    // what it wrote: its WareHouse folder entries newer than the request, plus its log, kept with the branch
    await sandbox.exec(`cd ${q(home)} && tail -n 200 chatdev-server.log > ${q(posix.join(out, 'server.log'))}; if [ -d WareHouse ]; then find WareHouse -mindepth 1 -maxdepth 1 -newer request.json -exec cp -r {} ${q(out)}/ \\; ; fi`, { timeoutMs: 120000 });
    let response = '';
    try { response = await files.read(posix.join(out, 'response.json')); } catch { /* nothing came back */ }
    const code = Number(String(call.output).trim().slice(-3));
    const written = (await sandbox.listDir(posix.join(OUT_DIR, run.id)).catch(() => [])).filter((f) => f !== 'response.json' && f !== 'server.log');
    if (code >= 400 || call.code !== 0) throw new Error(`ChatDev answered ${code || call.code}: ${(response || call.output).slice(0, 800)}`);
    return {
        status: 'finished',
        summary: `ChatDev finished. Output is in ${OUT_DIR}/${run.id}/${written.length ? ` (${written.join(', ')})` : ''} on branch ${run.branch}.\n\n${response.slice(0, 1500)}`,
    };
}

module.exports = { executeChatDev, envFile, requestBody, OUT_DIR, DEFAULT_WORKFLOW };
