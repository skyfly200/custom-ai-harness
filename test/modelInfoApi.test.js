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
    res.end(JSON.stringify({ data: [
        { model_name: 'or-claude-sonnet-5.5', litellm_params: { model: 'openrouter/anthropic/claude-sonnet-5.5' }, model_info: { input_cost_per_token: 0, output_cost_per_token: 0, max_input_tokens: null } },
        { model_name: 'fallback-openrouter-tools', litellm_params: { model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' }, model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
    ] }));
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
    ] }));
});

let base;
let harness;
test.before(async () => {
    process.env.GATEWAY_URL = await listen(gateway);
    process.env.OPENROUTER_URL = await listen(openrouter);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mi-'));
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    const { app } = require('../server');
    harness = http.createServer(app);
    base = await listen(harness);
});
test.after(() => { harness?.close(); gateway.close(); openrouter.close(); });

test("OpenRouter's price list prices Claude Sonnet 5.5, and :free models stay free", { skip: !openrouterUp }, async () => {
    const body = await (await fetch(`${base}/ui/api/model-info`)).json();
    const m = body.models['or-claude-sonnet-5.5'];
    assert.deepEqual([m.free, m.inputCost, m.outputCost, m.cacheReadCost, m.priceFrom], [false, 2e-6, 1e-5, 1e-7, 'openrouter']);
    assert.equal(body.openrouter.ok, true);
    assert.equal(body.models['fallback-openrouter-tools'].free, true);
});

test('with OpenRouter down a paid model has no price, not free, and the page is told why', { skip: openrouterUp }, async () => {
    const body = await (await fetch(`${base}/ui/api/model-info`)).json();
    const m = body.models['or-claude-sonnet-5.5'];
    assert.deepEqual([m.free, m.inputCost], [false, null]);
    assert.equal(body.openrouter.ok, false);
    assert.match(body.openrouter.error, /503/);
});
