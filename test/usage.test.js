const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');

const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-')), 'usage.json');
process.env.HARNESS_USAGE_FILE = FILE;
const usage = require('../utils/usage');

// A fake Gateway reply: headers plus a body sent in small pieces
function reply(headers, body) {
    const res = new PassThrough();
    res.headers = headers;
    return new Promise((resolve) => {
        usage.tap(res, resolve);
        const buf = Buffer.from(body);
        for (let i = 0; i < buf.length; i += 7) res.write(buf.subarray(i, i + 7));
        res.end();
    });
}

test('Anthropic streams give input at message_start and output at message_delta', async () => {
    const sse = [
        { type: 'message_start', message: { model: 'llama-3.3', usage: { input_tokens: 120, cache_read_input_tokens: 1000, output_tokens: 1 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello there' } },
        { type: 'message_delta', usage: { output_tokens: 42 } },
    ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const out = await reply({ 'content-type': 'text/event-stream' }, sse);
    assert.deepEqual(out.usage, { input: 1120, output: 42, cacheRead: 1000, cacheWrite: 0 });
    assert.equal(out.model, 'llama-3.3');
});

test('OpenAI streams read the final usage chunk, and count text when it is missing', async () => {
    const chunks = [
        { choices: [{ delta: { content: 'abcdefgh' } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } },
    ];
    const sse = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    assert.deepEqual((await reply({ 'content-type': 'text/event-stream' }, sse)).usage, { input: 50, output: 9, cacheRead: 0, cacheWrite: 0 });
    const noUsage = await reply({ 'content-type': 'text/event-stream' }, `data: ${JSON.stringify(chunks[0])}\n\ndata: [DONE]\n\n`);
    assert.equal(noUsage.usage, null);
    assert.equal(noUsage.outputChars, 8);
});

test('compressed JSON replies are read too', async () => {
    const body = zlib.gzipSync(JSON.stringify({ model: 'x', usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    const out = await reply({ 'content-type': 'application/json', 'content-encoding': 'gzip' }, body);
    assert.deepEqual(out.usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
});

test('services come from config.yaml', () => {
    const map = usage.parseProviders(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8'));
    assert.equal(map['fallback-groq'], 'Groq');
    assert.equal(map['fallback-openrouter-tools'], 'OpenRouter');
    assert.equal(map['fallback-ollama'], 'Ollama');
    assert.equal(map['local-engine'], 'Local engine');
    assert.equal(usage.providerOf('groq/llama-3.1-8b'), 'Groq');
});

test('totals add up by client, model and service and are saved to the file', () => {
    usage.clear();
    const base = { client: 'Claude Code', route: 'Router', model: 'local-engine' };
    usage.record({ ...base, servedBy: 'fallback-openrouter-tools', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    usage.record({ ...base, servedBy: 'fallback-openrouter-tools', usage: { input: 50, output: 5, cacheRead: 20, cacheWrite: 0 } });
    usage.record({ ...base, client: 'Chat page', route: 'Chosen by client', model: 'fallback-groq', usage: null, estimate: { input: 30, outputChars: 41 } });
    // an old day only counts in "all time"
    usage.record({ ...base, time: new Date(Date.now() - 40 * 86400000), servedBy: 'fallback-groq', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

    const week = usage.summary(7).rows;
    const cc = week.find(r => r.client === 'Claude Code');
    assert.deepEqual([cc.requests, cc.input, cc.output, cc.cacheRead, cc.provider], [2, 150, 15, 20, 'OpenRouter']);
    const chat = week.find(r => r.client === 'Chat page');
    assert.deepEqual([chat.input, chat.output, chat.estimated, chat.servedBy, chat.provider], [30, 11, 1, 'fallback-groq', 'Groq']);
    assert.equal(week.length, 2);
    assert.equal(usage.summary(0).rows.length, 3);
    // per day and served model, oldest first
    const daily = usage.summary(0).daily;
    assert.equal(daily.length, 3);
    assert.equal(daily[0].input, 1);
    const today = daily.find(d => d.servedBy === 'fallback-openrouter-tools');
    assert.deepEqual([today.requests, today.input, today.output, today.provider], [2, 150, 15, 'OpenRouter']);
    assert.equal(usage.summary(7).daily.length, 2);

    usage.clear(); // writes the empty file; then a record is saved after a short delay
    usage.record({ ...base, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } });
    process.emit('exit');
    usage.load();
    assert.equal(usage.summary().rows[0].input, 5);
});

test('tokens taken out by compression add up, and days keep the route and model', () => {
    usage.clear();
    const base = { client: 'Claude Code', route: 'Router', model: 'claude-sonnet-5', servedBy: 'fast-openrouter', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
    usage.record({ ...base, saved: { anchor: 300, headroom: 1200 } });
    usage.record({ ...base, saved: { anchor: 0, headroom: 800 } });
    usage.record(base);
    const [row] = usage.summary(7).rows;
    assert.deepEqual([row.requests, row.savedAnchor, row.savedHeadroom], [3, 300, 2000]);
    const [day] = usage.summary(7).daily;
    assert.deepEqual([day.route, day.model, day.servedBy, day.savedHeadroom], ['Router', 'claude-sonnet-5', 'fast-openrouter', 2000]);
    usage.clear();
});

test('clients are told apart by header and user agent', () => {
    const req = (path, headers) => ({ path, headers });
    assert.equal(usage.clientOf(req('/v1/chat/completions', { 'x-harness-request-id': 'a' })), 'Chat page');
    assert.equal(usage.clientOf(req('/v1/messages', { 'user-agent': 'claude-cli/2.1.0 (external, cli)' })), 'Claude Code');
    assert.equal(usage.clientOf(req('/v1/messages', {})), 'Anthropic API client');
    assert.equal(usage.clientOf(req('/v1/chat/completions', {})), 'OpenAI API client');
});
