// Batch roles: the OpenRouter batch client, the Interceptor's /v1/batch endpoints,
// and a workflow stage with canWait that the runner sends as a batch and waits for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-batch-')));
const wfDir = path.join(dir, 'wf');
fs.mkdirSync(wfDir);
fs.writeFileSync(path.join(wfDir, 'general.json'), JSON.stringify({ id: 'general', fallback: true, stages: [{ id: 'a', prompt: 'p' }] }));
fs.writeFileSync(path.join(wfDir, 'nightly.json'), JSON.stringify({ id: 'nightly', when: 'x', stages: [
    { id: 'work', role: 'Worker', tools: 'all', prompt: 'do it' },
    { id: 'critic', role: 'Critic', canWait: true, model: 'openai/gpt-x', diff: true, maxWaitMinutes: 1, prompt: 'Check the diff.' },
] }));
fs.writeFileSync(path.join(wfDir, 'overnight.json'), JSON.stringify({ id: 'overnight', stages: [
    { id: 'work', role: 'Worker', tools: 'all', prompt: 'do it' },
    { id: 'summary', role: 'Summariser', tools: 'none', model: 'openai/gpt-x', prompt: 'Summarise the work.' },
] }));
process.env.HARNESS_WORKFLOWS_DIR = wfDir;
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const { createBatchClient, parse } = require('../utils/openrouterBatch');
const workflows = require('../utils/workflows');
const guard = require('../utils/guard');
const { RunManager } = require('../runner/runs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => r(s)); });
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); });

test('a stage with canWait needs a model, and the fields are cleaned', () => {
    assert.throws(() => workflows.clean({ id: 'x', stages: [{ id: 'a', prompt: 'p', canWait: true }] }, 'f'), /needs a "model"/);
    const s = workflows.get('nightly').stages[1];
    assert.deepEqual([s.canWait, s.diff, s.maxWaitMinutes, s.model], [true, true, 1, 'openai/gpt-x']);
    assert.equal(workflows.get('nightly').stages[0].canWait, false);
});

test('the client sends top-level fields before requests and reads results by custom_id', async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => {
        seen.push({ url, method: opts.method, auth: opts.headers.authorization, body: opts.body });
        if (opts.method === 'POST') return { ok: true, status: 202, json: async () => ({ id: 'b1', status: 'validating' }) };
        return { ok: true, status: 200, json: async () => ({ status: 'completed', results: [
            { custom_id: 'r2', error: { message: 'boom' } },
            { custom_id: 'r1', response: { status_code: 200, body: { choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } } },
        ] }) };
    };
    const c = createBatchClient({ key: async () => 'k', base: 'https://or.test/api/v1/', fetchImpl });
    assert.equal(await c.submit('openai/gpt-x', [{ id: 'r1', body: { messages: [{ role: 'user', content: 'hi' }] } }]), 'b1');
    assert.equal(seen[0].url, 'https://or.test/api/v1/batches');
    assert.equal(seen[0].auth, 'Bearer k');
    assert.ok(seen[0].body.indexOf('"requests"') > seen[0].body.indexOf('"model"'), 'requests comes last');
    assert.deepEqual(JSON.parse(seen[0].body).requests[0], { custom_id: 'r1', body: { messages: [{ role: 'user', content: 'hi' }], model: 'openai/gpt-x' } });
    const got = await c.get('b1');
    assert.deepEqual([got.done, got.results.r1.text, got.results.r2.error], [true, 'hello', 'boom']);
    assert.deepEqual(parse({ custom_id: 'x', response: { choices: [{ message: { content: 'flat' } }] } }).text, 'flat');
    assert.match(parse({ custom_id: 'x', response: { status_code: 400, body: { error: { message: 'bad' } } } }).error, /bad/);
    await assert.rejects(createBatchClient({ key: async () => '', fetchImpl }).get('b'), /no OpenRouter key/);
});

test('the Interceptor starts and polls a batch, and refuses models not listed as batch models', async () => {
    const calls = [];
    const or = await listen(async (req, res) => {
        const body = await readBody(req);
        calls.push({ method: req.method, url: req.url });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') return res.writeHead(202).end(JSON.stringify({ id: 'bX' }));
        res.end(JSON.stringify({ status: 'completed', results: [{ custom_id: 'r1', response: { body: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } } }] }));
    });
    process.env.OPENROUTER_BATCH_URL = `http://127.0.0.1:${or.address().port}`;
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.HARNESS_BATCH_MODELS_FILE = path.join(dir, 'batch.json');
    fs.writeFileSync(process.env.HARNESS_BATCH_MODELS_FILE, JSON.stringify({ models: ['openai/*'] }));
    const { app } = require('../server');
    const harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    const base = `http://127.0.0.1:${harness.address().port}`;
    try {
        const send = (model) => fetch(`${base}/v1/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
        const no = await send('local-engine');
        assert.equal(no.status, 400);
        assert.match((await no.json()).error, /not listed/);
        const yes = await send('openai/gpt-x');
        assert.equal(yes.status, 202);
        assert.deepEqual(await yes.json(), { id: 'bX' });
        const polled = await (await fetch(`${base}/v1/batch/bX`)).json();
        assert.deepEqual([polled.done, polled.result.text], [true, 'ok']);
    } finally { harness.close(); or.close(); }
});

// The runner against a fake harness that scripts the worker and runs the batch
let batchMode = 'ok';
let batchPolls = 0;
let chats = [];
let fake;
let manager;
const repo = path.join(dir, 'repos', 'demo');
test.before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    fake = await listen(async (req, res) => {
        const data = JSON.parse((await readBody(req)) || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: { 'openai/gpt-x': { inputCost: 1e-5, outputCost: 1e-5 } } }));
        if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(data, { jev: false })));
        if (req.url === '/v1/batch') {
            if (batchMode === 'refuse') return res.writeHead(400).end(JSON.stringify({ error: 'not a batch model' }));
            chats.push({ batch: data });
            return res.writeHead(202).end(JSON.stringify({ id: 'b1' }));
        }
        if (req.url === '/v1/batch/b1') {
            batchPolls++;
            if (batchPolls < 2) return res.end(JSON.stringify({ status: 'in_progress', done: false, result: null }));
            return res.end(JSON.stringify({ status: 'completed', done: true, result: { text: 'PASS: looks fine', usage: { prompt_tokens: 1000, completion_tokens: 0 } } }));
        }
        chats.push({ chat: data, model: req.headers['x-harness-model'] });
        const calls = data.tools?.length ? [{ id: 'f', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'Worked.' }) } }] : undefined;
        res.end(JSON.stringify({ model: 'openai/gpt-x', usage: { prompt_tokens: 1000, completion_tokens: 0 }, choices: [{ message: { role: 'assistant', content: calls ? '' : 'PASS: asked normally', tool_calls: calls } }] }));
    });
    manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [path.join(dir, 'repos')], harnessUrl: `http://127.0.0.1:${fake.address().port}`, retryDelayMs: 1, batchPollMs: 5 });
});
test.after(() => fake?.close());

async function settle(id) {
    for (let i = 0; i < 600; i++) {
        const run = manager.get(id);
        if (['done', 'failed', 'incomplete', 'stopped'].includes(run.status)) return run;
        await sleep(20);
    }
    throw new Error('run did not settle');
}

test('a canWait stage is sent as a batch, waited for, and costed at half price', async () => {
    batchMode = 'ok'; batchPolls = 0; chats = [];
    const run = await settle(manager.create({ goal: 'x', repo, workflow: 'nightly' }).id);
    assert.equal(run.status, 'done', run.error);
    assert.match(run.result.summary, /Critic: PASS: looks fine/);
    const sent = chats.find((c) => c.batch).batch;
    assert.equal(sent.model, 'openai/gpt-x');
    assert.match(sent.messages[0].content, /You are the Critic/);
    assert.match(sent.messages[1].content, /Worked\./); // the worker's summary was handed on
    assert.equal(chats.filter((c) => c.chat).length, 1, 'only the worker made an ordinary call');
    // the worker's call: 1000 tokens at 1e-5 = 0.01; the batch's: 1000 at half = 0.005
    assert.ok(Math.abs(run.cost - 0.015) < 1e-9, `cost ${run.cost}`);
    assert.ok(Math.abs(run.batchSaved - 0.005) < 1e-9);
    assert.equal(run.batchRequests, 1);
    assert.ok(run.events.some((e) => /half-price batch/.test(e.text || '')));
});

test('a model that cannot be batched is asked normally, with no tools', async () => {
    batchMode = 'refuse'; chats = [];
    const run = await settle(manager.create({ goal: 'x', repo, workflow: 'nightly' }).id);
    assert.equal(run.status, 'done', run.error);
    assert.match(run.result.summary, /Critic: PASS: asked normally/);
    const normal = chats.filter((c) => c.chat);
    assert.equal(normal.length, 2);
    assert.equal(normal[1].model, 'openai/gpt-x');
    assert.equal(normal[1].chat.tools, undefined);
    assert.ok(run.events.some((e) => /could not be batched \(not a batch model\); asking openai\/gpt-x normally/.test(e.text || '')));
});

test('an overnight run batches its tool-less steps and runs the rest as it goes', async () => {
    batchMode = 'ok'; batchPolls = 0; chats = [];
    const run = await settle(manager.create({ goal: 'x', repo, workflow: 'overnight', speed: 'batch' }).id);
    assert.equal(run.status, 'done', run.error);
    assert.equal(run.speed, 'batch');
    const sent = chats.filter((c) => c.batch);
    assert.equal(sent.length, 1);
    assert.match(sent[0].batch.messages[0].content, /You are the Summariser/);
    assert.equal(chats.filter((c) => c.chat).length, 1, 'only the worker, which has tools, made an ordinary call');
    assert.ok(run.events.some((e) => /Overnight run: 1 step with no tools/.test(e.text || '')));
});

test('a fast run, or an overnight run with no batchable step, sends nothing to a batch', async () => {
    batchMode = 'ok'; batchPolls = 0; chats = [];
    const fast = await settle(manager.create({ goal: 'x', repo, workflow: 'overnight' }).id);
    assert.equal(fast.speed, 'fast');
    assert.equal(chats.filter((c) => c.batch).length, 0);
    assert.equal(chats.filter((c) => c.chat).length, 2, 'both stages ask normally, one call each');
    chats = [];
    const general = await settle(manager.create({ goal: 'x', repo, workflow: 'general', speed: 'batch' }).id);
    assert.equal(general.status, 'done', general.error);
    assert.equal(chats.filter((c) => c.batch).length, 0);
    assert.ok(general.events.some((e) => /no step here can wait for a batch/.test(e.text || '')));
    assert.throws(() => manager.create({ goal: 'x', repo, workflow: 'general', speed: 'slow' }), /speed must be one of/);
});

test('the shipped one-shot workflow has a single tool-less step on a batch model, and Overnight batches it', () => {
    const shipped = workflows.load(path.join(__dirname, '..', 'workflows')).list.find((w) => w.id === 'one-shot');
    assert.deepEqual(shipped.stages.map((st) => [st.tools, st.model]), [['none', 'anthropic/claude-sonnet-5.5']]);
    assert.ok(require('../utils/batchModels').isBatch(shipped.stages[0].model, require('../utils/batchModels').load()));
});
