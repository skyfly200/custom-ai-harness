// ChatDev as an external tool: the run is set up and its output kept, with a stand-in
// sandbox that records the commands and files (nothing here installs or runs ChatDev).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chatdev-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
git(repo, 'init', '-q');
git(repo, 'checkout', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'start');

process.env.SPRITES_TOKEN = 'tok';
const sandboxes = require('../runner/sandbox');
const chatdev = require('../runner/chatdev');
const { RunManager } = require('../runner/runs');

test('the .env points ChatDev at the harness and refuses addresses a sandbox cannot reach', () => {
    assert.equal(chatdev.envFile({ harnessUrl: 'https://h.example.com/', apiKey: 'hk_1', model: 'm' }), 'BASE_URL=https://h.example.com/v1\nAPI_KEY=hk_1\nMODEL_NAME=m\n');
    assert.throws(() => chatdev.envFile({ harnessUrl: '', model: 'm' }), /CHATDEV_HARNESS_URL/);
    assert.throws(() => chatdev.envFile({ harnessUrl: 'http://localhost:3000', model: 'm' }), /cannot reach/);
    const body = JSON.parse(chatdev.requestBody({ id: 'r1', graph: 'g', goal: "it's \"quoted\"" }));
    assert.deepEqual(body, { session_name: 'r1', graph_content: 'g', task_prompt: "it's \"quoted\"" });
});

test('the example workflow keeps the harness settings as variables', () => {
    const yaml = fs.readFileSync(chatdev.DEFAULT_WORKFLOW, 'utf8');
    for (const v of ['${BASE_URL}', '${API_KEY}', '${MODEL_NAME}']) assert.ok(yaml.includes(v), v);
});

test('a ChatDev run defaults to a Sprite, refuses this machine, and cannot be continued', () => {
    const manager = new RunManager({ dir: path.join(root, 'runs'), roots: [root], sandbox: 'local' });
    manager.pump = () => {};
    const run = manager.create({ goal: 'make a snake game', repo, workflow: 'chatdev' });
    assert.equal(run.kind, 'chatdev');
    assert.equal(run.sandbox, 'sprites');
    assert.throws(() => manager.create({ goal: 'x', repo, workflow: 'chatdev', sandbox: 'local' }), /cloud sandbox/);
    run.status = 'incomplete';
    assert.throws(() => manager.continueRun(run.id), /cannot be continued/);
});

test('it installs, writes the env and request, runs the workflow and keeps the output', async () => {
    process.env.CHATDEV_HARNESS_URL = 'https://h.example.com';
    process.env.CHATDEV_API_KEY = 'hk_test';
    const written = {};
    const commands = [];
    const stub = {
        kind: 'sprites', id: 'sp-1', dir: '/home/sprite/work', base: 'abc',
        sandbox: { files: { write: async (p, d) => { written[p] = String(d); }, read: async (p) => written[p] || '' } },
        exec: async (cmd) => {
            commands.push(cmd);
            if (cmd.includes('/api/workflow/execute')) { written['/home/sprite/work/chatdev-output/r1/response.json'] = '{"status":"ok"}'; return { code: 0, output: '200', timedOut: false }; }
            return { code: 0, output: '', timedOut: false };
        },
        listDir: async () => ['game/', 'response.json', 'server.log'],
    };
    const original = sandboxes.createSandbox;
    sandboxes.createSandbox = async () => stub;
    const events = [];
    const manager = { dir: root, save() {}, event: (r, e) => events.push(e.text) };
    try {
        const run = { id: 'r1', goal: 'make a snake game', repo, branch: 'harness/r1', base: null, sandbox: 'sprites', maxMinutes: 30, model: null };
        const out = await chatdev.executeChatDev(manager, run, { stopped: false });
        assert.equal(out.status, 'finished');
        assert.match(out.summary, /chatdev-output\/r1\/ \(game\/\)/);
        assert.match(out.summary, /"status":"ok"/);
        assert.equal(run.sandboxId, 'sp-1');
        assert.equal(written['/home/sprite/chatdev/.env'], 'BASE_URL=https://h.example.com/v1\nAPI_KEY=hk_test\nMODEL_NAME=claude-sonnet-5-5\n');
        assert.equal(JSON.parse(written['/home/sprite/chatdev/request.json']).task_prompt, 'make a snake game');
        assert.ok(commands.some((c) => /git clone/.test(c) && c.includes('OpenBMB/ChatDev')));
        assert.ok(commands.some((c) => /uv sync/.test(c)));
        assert.ok(!commands.some((c) => c.includes('hk_test')), 'the key goes in a file, never on a command line');
    } finally {
        sandboxes.createSandbox = original;
    }
});

test('a failed ChatDev call fails the run with what it said', async () => {
    const stub = {
        kind: 'sprites', id: 'sp-2', dir: '/home/sprite/work', base: 'abc',
        sandbox: { files: { write: async () => {}, read: async () => '{"detail":"bad graph"}' } },
        exec: async (cmd) => (cmd.includes('/api/workflow/execute') ? { code: 0, output: '422', timedOut: false } : { code: 0, output: '', timedOut: false }),
        listDir: async () => [],
    };
    const original = sandboxes.createSandbox;
    sandboxes.createSandbox = async () => stub;
    try {
        const run = { id: 'r2', goal: 'g', repo, branch: 'harness/r2', base: null, sandbox: 'sprites', maxMinutes: 30, model: null };
        await assert.rejects(chatdev.executeChatDev({ dir: root, save() {}, event() {} }, run, { stopped: false }), /ChatDev answered 422: .*bad graph/);
    } finally {
        sandboxes.createSandbox = original;
    }
});
