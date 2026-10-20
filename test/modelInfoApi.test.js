// /ui/api/model-info against a fake Gateway that lists 0 prices for a model
// it doesn't know (as LiteLLM does) and a fake OpenRouter price list
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

const gateway = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1/model/info')) {
        return res.end(JSON.stringify({ data: [
            { model_name: 'or-claude-sonnet-5.5', litellm_params: { model: 'openrouter/anthropic/claude-sonnet-5.5' }, model_info: { input_cost_per_token: 0, output_cost_per_token: 0, max_input_tokens: null } },
            { model_name: 'fallback-openrouter-tools', litellm_params: { model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' }, model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
        ] }));
    }
    // a chat reply from a model the Gateway's price list leaves out
    res.setHeader('x-litellm-model-group', 'or-unlisted');
    res.end(JSON.stringify({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
});
// OPENROUTER_DOWN=1 runs the same checks with OpenRouter failing (see the end)
let openrouterUp = !process.env.OPENROUTER_DOWN;
const openrouter = http.createServer((req, res) => {
    if (!openrouterUp) { res.writeHead(503); return res.end('down'); }
    res.setHeader('content-type', 'application/json');
    // prices as OpenRouter lists them: strings, dollars per token
    res.end(JSON.stringify({ data: [
        { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', context_length: 1000000, architecture: { output_modalities: ['text'] },
          pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001', input_cache_write: '0.0000025' } },
        { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', architecture: { output_modalities: ['text'] },
          pricing: { prompt: '0.000004', completion: '0.00002' } },
        { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', architecture: { output_modalities: ['text'] },
          pricing: { prompt: '0.0000001', completion: '0.0000005' } },
    ] }));
});

let base;
let harness;
test.before(async () => {
    process.env.GATEWAY_URL = await listen(gateway);
    process.env.OPENROUTER_URL = await listen(openrouter);
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mi-'));
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    // an old usage row: no provider model kept, just its name and service
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(process.env.HARNESS_USAGE_FILE, JSON.stringify({ since: null, rows: { old: {
        day, client: 'Chat page', route: 'Chosen by client', model: 'or-claude-haiku-5.5', servedBy: 'or-claude-haiku-5.5', provider: 'OpenRouter',
        requests: 1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, estimated: 0 } } }));
    // a model only config.yaml names (the Gateway's list leaves it out)
    process.env.GATEWAY_CONFIG = path.join(dir, 'config.yaml');
    fs.writeFileSync(process.env.GATEWAY_CONFIG, 'model_list:\n  - model_name: or-haiku\n    litellm_params:\n      model: openrouter/anthropic/claude-haiku-5.5\n');
    const { app } = require('../server');
    harness = http.createServer(app);
    base = await listen(harness);
});
test.after(() => { harness?.close(); gateway.close(); openrouter.close(); });

const modelInfo = async () => (await fetch(`${base}/ui/api/model-info`)).json();

test("OpenRouter's price list prices Claude Sonnet 5.5, and :free models stay free", { skip: !openrouterUp }, async () => {
    const body = await modelInfo();
    const m = body.models['or-claude-sonnet-5.5'];
    assert.deepEqual([m.free, m.inputCost, m.outputCost, m.cacheReadCost, m.priceFrom], [false, 2e-6, 1e-5, 1e-7, 'openrouter']);
    assert.equal(body.openrouter.ok, true);
    assert.equal(body.models['fallback-openrouter-tools'].free, true);
    // config.yaml fills in what the Gateway's list leaves out
    assert.equal(body.models['or-haiku'].inputCost, 1e-7);
});

test('a model neither list names is priced by the model its replies reported', { skip: !openrouterUp }, async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-harness-model': 'or-unlisted' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const m = (await modelInfo()).models['or-unlisted'];
    assert.deepEqual([m.free, m.inputCost, m.outputCost, m.upstream], [false, 4e-6, 2e-5, 'openrouter/anthropic/claude-opus-5.5']);
});

test('rows saved before replies were kept are matched by name', { skip: !openrouterUp }, async () => {
    const m = (await modelInfo()).models['or-claude-haiku-5.5'];
    assert.deepEqual([m.inputCost, m.upstream], [1e-7, 'openrouter/anthropic/claude-haiku-5.5']);
});

test('with OpenRouter down a paid model has no price, not free, and the page is told why', { skip: openrouterUp }, async () => {
    const body = await modelInfo();
    const m = body.models['or-claude-sonnet-5.5'];
    assert.deepEqual([m.free, m.inputCost], [false, null]);
    assert.equal(body.openrouter.ok, false);
    assert.match(body.openrouter.error, /503/);
});
