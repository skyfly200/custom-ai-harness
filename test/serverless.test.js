// The serverless harness (serverless/core.mjs, Netlify and Vercel adapters): access, model
// choice, streaming pass-through, limits and upstream errors. The OpenRouter call is a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', file)).href);

const ENV = {
    OPENROUTER_API_KEY: 'or-test-key',
    SERVERLESS_API_KEY: 'access-test-key',
    OPENROUTER_URL: 'https://openrouter.test/api/v1',
};

// A fake OpenRouter: records each call and answers with a small JSON body.
function fakeOpenRouter(reply = { status: 200, body: '{"id":"x","choices":[]}', type: 'application/json' }) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return new Response(reply.body, { status: reply.status, headers: { 'content-type': reply.type } });
    };
    return { calls, fetchImpl };
}

const chat = (body, headers = {}) => new Request('https://app.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ENV.SERVERLESS_API_KEY}`, ...headers },
    body: JSON.stringify(body),
});

const short = { messages: [{ role: 'user', content: 'hi' }] };

test('without SERVERLESS_API_KEY or OPENROUTER_API_KEY the deployment refuses to serve', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const res = await handle(chat(short), { OPENROUTER_API_KEY: 'x' }, { fetchImpl });
    assert.equal(res.status, 503);
    const res2 = await handle(chat(short), { SERVERLESS_API_KEY: 'x' }, { fetchImpl });
    assert.equal(res2.status, 503);
    assert.equal(calls.length, 0, 'nothing is sent upstream');
});

test('a wrong or missing key gets 401 and nothing is sent upstream', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const wrong = await handle(chat(short, { authorization: 'Bearer nope' }), ENV, { fetchImpl });
    assert.equal(wrong.status, 401);
    const none = new Request('https://app.test/v1/chat/completions', { method: 'POST', body: JSON.stringify(short) });
    assert.equal((await handle(none, ENV, { fetchImpl })).status, 401);
    assert.equal(calls.length, 0);
});

test('x-api-key works as well as a Bearer token', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl } = fakeOpenRouter();
    const req = new Request('https://app.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'x-api-key': ENV.SERVERLESS_API_KEY },
        body: JSON.stringify(short),
    });
    assert.equal((await handle(req, ENV, { fetchImpl })).status, 200);
});

test('a short plain request goes to the weak model, with the OpenRouter key', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const res = await handle(chat(short), ENV, { fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-harness-model'), 'anthropic/claude-haiku-5.5');
    assert.equal(res.headers.get('x-harness-route'), 'short');
    assert.equal(calls[0].url, 'https://openrouter.test/api/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer or-test-key');
    assert.equal(calls[0].body.model, 'anthropic/claude-haiku-5.5');
    // caveman is on by default: its line goes into a system message; the user's text is untouched
    assert.equal(calls[0].body.messages[0].role, 'system');
    assert.match(calls[0].body.messages[0].content, /Be terse/);
    assert.deepEqual(calls[0].body.messages.slice(1), short.messages);
});

test('tools or a long conversation go to the strong model', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl } = fakeOpenRouter();
    const withTools = await handle(chat({ ...short, tools: [{ type: 'function', function: { name: 'f' } }] }), ENV, { fetchImpl });
    assert.equal(withTools.headers.get('x-harness-route'), 'tools');
    assert.equal(withTools.headers.get('x-harness-model'), 'anthropic/claude-sonnet-5.5');
    const long = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(9000) }] }] };
    const res = await handle(chat(long), ENV, { fetchImpl });
    assert.equal(res.headers.get('x-harness-route'), 'long');
    assert.equal(res.headers.get('x-harness-model'), 'anthropic/claude-sonnet-5.5');
});

test('x-harness-tier picks a side; the header pin wins over everything', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl } = fakeOpenRouter();
    const tier = await handle(chat(short, { 'x-harness-tier': 'strong' }), ENV, { fetchImpl });
    assert.equal(tier.headers.get('x-harness-model'), 'anthropic/claude-sonnet-5.5');
    const pinned = await handle(chat(short, { 'x-harness-model': 'anthropic/claude-haiku-5.5', 'x-harness-tier': 'strong' }), ENV, { fetchImpl });
    assert.equal(pinned.headers.get('x-harness-route'), 'pinned');
    assert.equal(pinned.headers.get('x-harness-model'), 'anthropic/claude-haiku-5.5');
});

test('a pinned model outside HARNESS_MODELS is refused; a body model in the list is honored', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const refused = await handle(chat(short, { 'x-harness-model': 'openai/gpt-x' }), ENV, { fetchImpl });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error.message, /HARNESS_MODELS/);
    assert.equal(calls.length, 0);

    const env = { ...ENV, HARNESS_MODELS: 'openai/gpt-4o-mini' };
    const ok = await handle(chat({ ...short, model: 'openai/gpt-4o-mini' }), env, { fetchImpl });
    assert.equal(ok.headers.get('x-harness-route'), 'requested');
    assert.equal(calls[0].body.model, 'openai/gpt-4o-mini');

    const unknownBodyModel = await handle(chat({ ...short, model: 'gpt-5-anything' }), ENV, { fetchImpl });
    assert.equal(unknownBodyModel.headers.get('x-harness-route'), 'short', 'an unlisted body model falls back to the rules');
});

test('the streamed reply passes through unchanged', async () => {
    const { handle } = await load('serverless/core.mjs');
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const { fetchImpl } = fakeOpenRouter({ status: 200, body: sse, type: 'text/event-stream' });
    const res = await handle(chat({ ...short, stream: true }), ENV, { fetchImpl });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), sse);
});

test('an OpenRouter error status is returned as it came', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl } = fakeOpenRouter({ status: 429, body: '{"error":{"message":"slow down"}}', type: 'application/json' });
    const res = await handle(chat(short), ENV, { fetchImpl });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /slow down/);
});

test('bad bodies get 400 and oversize bodies get 413', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const notJson = new Request('https://app.test/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${ENV.SERVERLESS_API_KEY}` }, body: '{nope' });
    assert.equal((await handle(notJson, ENV, { fetchImpl })).status, 400);
    const noMessages = chat({ model: 'x' });
    assert.equal((await handle(noMessages, ENV, { fetchImpl })).status, 400);
    const big = chat({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] });
    assert.equal((await handle(big, { ...ENV, HARNESS_MAX_BYTES: '500' }, { fetchImpl })).status, 413);
    assert.equal(calls.length, 0);
});

test('an OpenRouter that never answers gets 504 after the timeout', async () => {
    const { handle } = await load('serverless/core.mjs');
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const res = await handle(chat(short), { ...ENV, HARNESS_TIMEOUT_MS: '20' }, { fetchImpl });
    assert.equal(res.status, 504);
});

test('a network failure to OpenRouter gets 502', async () => {
    const { handle } = await load('serverless/core.mjs');
    const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND openrouter.test'); };
    const res = await handle(chat(short), ENV, { fetchImpl });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /ENOTFOUND/);
});

test('/v1/models lists the deployment models, and health needs no key', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl } = fakeOpenRouter();
    const env = { ...ENV, HARNESS_MODELS: 'openai/gpt-4o-mini, anthropic/claude-haiku-5.5' };
    const list = await handle(new Request('https://app.test/v1/models', { headers: { authorization: `Bearer ${ENV.SERVERLESS_API_KEY}` } }), env, { fetchImpl });
    const ids = (await list.json()).data.map((m) => m.id);
    assert.deepEqual(ids, ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'openai/gpt-4o-mini']);
    const health = await handle(new Request('https://app.test/healthz'), ENV, { fetchImpl });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
});

test('unknown paths are 404 and GET on chat is 405 (after the key check)', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl } = fakeOpenRouter();
    assert.equal((await handle(new Request('https://app.test/nope'), ENV, { fetchImpl })).status, 404);
    const get = new Request('https://app.test/v1/chat/completions', { headers: { authorization: `Bearer ${ENV.SERVERLESS_API_KEY}` } });
    assert.equal((await handle(get, ENV, { fetchImpl })).status, 405);
});

test('a Vercel rewrite prefix (/api) is treated as the same route', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const req = new Request('https://app.test/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${ENV.SERVERLESS_API_KEY}` },
        body: JSON.stringify(short),
    });
    assert.equal((await handle(req, ENV, { fetchImpl })).status, 200);
    assert.equal(calls.length, 1);
});

test('the Netlify and Vercel adapters answer through the shared handler', async () => {
    const netlify = (await load('netlify/functions/v1.mjs')).default;
    const vercel = (await load('api/v1/[...path].mjs')).default;
    const saved = { o: process.env.OPENROUTER_API_KEY, s: process.env.SERVERLESS_API_KEY };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SERVERLESS_API_KEY;
    try {
        // With no keys in the process environment the shared handler refuses, whichever host calls it.
        assert.equal((await netlify(new Request('https://app.test/v1/models'))).status, 503);
        assert.equal((await vercel(new Request('https://app.test/api/v1/models'))).status, 503);
    } finally {
        if (saved.o !== undefined) process.env.OPENROUTER_API_KEY = saved.o;
        if (saved.s !== undefined) process.env.SERVERLESS_API_KEY = saved.s;
    }
});

test('the transforms match the Interceptor: caveman on, switchable; user text never changes', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const res = await handle(chat(short), { ...ENV, HARNESS_CAVEMAN: '0' }, { fetchImpl });
    assert.equal(res.headers.get('x-harness-transforms'), 'none');
    assert.deepEqual(calls[0].body.messages, short.messages);
    await handle(chat(short), ENV, { fetchImpl });
    assert.match(res.headers.get('x-harness-transforms'), /none/);
    assert.match(calls[1].body.messages[0].content, /Be terse/);
    assert.equal(calls[1].body.messages.at(-1).content, 'hi');
});

test('repeated tool results become a pointer and long ones are shortened, in the same order as the Interceptor', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const big = 'line of log output\n'.repeat(3000); // over the in-repo Headroom limit
    const messages = [
        { role: 'user', content: 'read it twice' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'a', content: big },
        { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'b', content: big },
    ];
    const res = await handle(chat({ messages, tools: [{ type: 'function', function: { name: 'read' } }] }), ENV, { fetchImpl });
    const names = decodeURIComponent(res.headers.get('x-harness-transforms'));
    assert.match(names, /context anchor/);
    assert.match(names, /headroom/);
    const sent = calls[0].body.messages;
    assert.equal(sent.find((m) => m.tool_call_id === 'b').content, '[harness: identical to earlier tool result a; not repeated]');
    assert.match(sent.find((m) => m.tool_call_id === 'a').content, /truncated by harness/);
    assert.equal(sent.find((m) => m.role === 'user').content, 'read it twice', 'user text is not changed');
});

test('a Headroom service compresses tool results only, and a broken service changes nothing', async () => {
    const { applyTransforms } = await load('serverless/transforms.mjs');
    const tf = { caveman: false, contextAnchor: false, headroom: true, headroomUrl: '' };
    const body = {
        model: 'anthropic/claude-haiku-5.5',
        messages: [
            { role: 'user', content: 'go' },
            { role: 'tool', tool_call_id: 'x', content: 'long output that the service shortens' },
        ],
    };
    const fakeClient = {
        calls: [],
        async compress(messages) {
            this.calls.push(messages);
            return { compressed: true, messages: [
                { role: 'user', content: 'go, rewritten by the service' },
                { role: 'tool', tool_call_id: 'x', content: 'shortened' },
            ] };
        },
    };
    const out = await applyTransforms(body, tf, { headroomClient: fakeClient });
    assert.equal(out.applied.includes('headroom service'), true);
    assert.equal(out.body.messages[0].content, 'go', 'user text is kept from before the service');
    assert.equal(out.body.messages[1].content, 'shortened');

    const broken = { compress: async () => { throw new Error('down'); } };
    const kept = await applyTransforms(body, tf, { headroomClient: broken });
    assert.equal(kept.body.messages[1].content, 'long output that the service shortens');

    const mismatch = { compress: async () => ({ compressed: true, messages: [{ role: 'user', content: 'x' }] }) };
    const same = await applyTransforms(body, tf, { headroomClient: mismatch });
    assert.deepEqual(same.body.messages, body.messages);
});

test('an unreachable HEADROOM_URL still answers the request (the client falls back)', async () => {
    const { handle } = await load('serverless/core.mjs');
    const { fetchImpl, calls } = fakeOpenRouter();
    const res = await handle(chat(short), { ...ENV, HEADROOM_URL: 'http://127.0.0.1:9', HEADROOM_TIMEOUT_MS: '2000' }, { fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
});
