// ask_jev_file: windowing and combining Jev's answers, which files may be read,
// POST /v1/jev/ask against a fake Router, and the MCP tools over stdio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-jevfiles-')));
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.HARNESS_FILE_ROOTS = dir;
const { askText, windows } = require('../utils/jevAsk');
const { readFileText } = require('../utils/jevFiles');

test('text is cut into windows and the strongest one wins', async () => {
    assert.deepEqual(windows('abcdef', 4), [{ start: 0, end: 4 }, { start: 4, end: 6 }]);
    const text = `${'a\n'.repeat(500)}NEEDLE${'b\n'.repeat(500)}`;
    const ask = async (chunk) => ({ q: chunk.includes('NEEDLE') ? 0.92 : 0.04 });
    const r = await askText({ text, question: 'Is there a needle?', ask, window: 400 });
    assert.equal(r.answer, true);
    assert.equal(r.score, 0.92);
    assert.equal(r.windows, 6);
    assert.equal(r.best.line, 401); // the line the winning window starts on
    assert.equal(r.truncated, false);
    const no = await askText({ text: 'nothing here', question: 'Is there a needle?', ask });
    assert.equal(no.answer, false);
});

test('scale returns the number, threshold moves the bool, and long files report what was read', async () => {
    const ask = async () => ({ q: 0.4 });
    const scale = await askText({ text: 'x', question: 'Is it hard to read?', mode: 'scale', ask });
    assert.equal(scale.score, 0.4);
    assert.equal('answer' in scale, false);
    assert.equal((await askText({ text: 'x', question: 'q', ask, threshold: 0.3 })).answer, true);
    const long = await askText({ text: 'x'.repeat(5000), question: 'q', ask, window: 500, maxWindows: 4 });
    assert.deepEqual([long.windows, long.scanned, long.truncated], [10, 4, true]);
    await assert.rejects(askText({ text: 'x', question: '', ask }), /question is required/);
    await assert.rejects(askText({ text: 'x', question: 'q', mode: 'maybe', ask }), /mode must be/);
    await assert.rejects(askText({ text: 'x', question: 'q', ask: async () => ({}) }), /no answer/);
});

test('only plain files inside the allowed folders are read', () => {
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
    assert.equal(readFileText(path.join(dir, 'a.js')), 'const a = 1;\n');
    assert.throws(() => readFileText(path.join(dir, 'missing.js')), /does not exist/);
    assert.throws(() => readFileText(os.tmpdir()), /outside the allowed folders/);
    assert.throws(() => readFileText(dir), /not a file/);
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=secret\n');
    assert.throws(() => readFileText(path.join(dir, '.env')), /secrets file/);
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    assert.throws(() => readFileText(path.join(dir, 'blob.bin')), /binary/);
    process.env.HARNESS_FILE_MAX_BYTES = '10';
    assert.throws(() => readFileText(path.join(dir, 'a.js')), /over the 10 byte limit/);
    delete process.env.HARNESS_FILE_MAX_BYTES;
    // a link out of the folder is followed, then refused
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'x');
    fs.symlinkSync(outside, path.join(dir, 'link.txt'));
    assert.throws(() => readFileText(path.join(dir, 'link.txt')), /outside the allowed folders/);
    fs.rmSync(outside);
});

// A fake Router: /health tells the harness how much Jev reads at once, /ask answers
// "yes" for any window that mentions "token".
const asked = [];
const router = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', backend: 'systemone', settings: { max_chars: 300 } }));
        const body = JSON.parse(data);
        asked.push(body);
        res.end(JSON.stringify({ answers: { q: /token/.test(body.text) ? 0.9 : 0.05 } }));
    });
});
let harness, base;
test.before(async () => {
    await new Promise((r) => router.listen(0, '127.0.0.1', r));
    process.env.ROUTER_URL = `http://127.0.0.1:${router.address().port}`;
    process.env.GATEWAY_URL = 'http://127.0.0.1:9';
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
});
test.after(() => { harness?.close(); router.close(); });

const ask = (body) => fetch(`${base}/v1/jev/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('/v1/jev/ask windows the text to what the Router reads and combines the answers', async () => {
    const text = `${'let x = 1;\n'.repeat(100)}const token = read();\n${'let y = 2;\n'.repeat(100)}`;
    asked.length = 0;
    const r = await (await ask({ text, question: 'Does it use a token?' })).json();
    assert.equal(r.answer, true);
    assert.equal(r.windows, Math.ceil(text.length / 300));
    assert.ok(asked.every((a) => a.text.length <= 300));
    assert.equal(r.best.line, 82); // the 300-character window from character 900 holds the token
});

test('/v1/jev/ask refuses a bad request', async () => {
    assert.equal((await ask({ question: 'q' })).status, 400);
    assert.equal((await ask({ text: 'x', question: 'q', mode: 'huh' })).status, 400);
});

test('the MCP tools answer from a file without returning its content', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    fs.writeFileSync(path.join(dir, 'auth.js'), `${'// filler\n'.repeat(60)}const token = getToken();\n`);
    fs.writeFileSync(path.join(dir, 'plain.js'), 'console.log("hi");\n');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
        command: process.execPath, args: [path.join(__dirname, '..', 'scripts', 'jev-files-mcp.js')],
        env: { ...process.env, HARNESS_URL: base },
    }));
    try {
        const tools = (await client.listTools()).tools.map((t) => t.name).sort();
        assert.deepEqual(tools, ['ask_jev_filebool', 'ask_jev_files', 'ask_jev_filescale']);
        const call = async (name, args) => (await client.callTool({ name, arguments: args }));
        const yes = await call('ask_jev_filebool', { path: path.join(dir, 'auth.js'), question: 'Does it use a token?' });
        assert.match(yes.content[0].text, /: yes \(Jev 90% sure it is yes, strongest around line \d+\)\./);
        assert.doesNotMatch(yes.content[0].text, /filler/);
        const no = await call('ask_jev_filebool', { path: path.join(dir, 'plain.js'), question: 'Does it use a token?' });
        assert.match(no.content[0].text, /: no \(Jev 5% sure it is yes\)\./);
        const scale = await call('ask_jev_filescale', { path: path.join(dir, 'auth.js'), question: 'This file handles tokens' });
        assert.match(scale.content[0].text, /0\.90 on a 0 to 1 scale/);
        const many = await call('ask_jev_files', { paths: [path.join(dir, 'plain.js'), path.join(dir, 'auth.js'), path.join(dir, '.env')], question: 'Does it use a token?' });
        const lines = many.content[0].text.split('\n');
        assert.equal(lines[0], '1 of 3 files: yes.');
        assert.match(lines[1], /auth\.js: 90%/);
        assert.match(lines[2], /\.env: not asked \(.*secrets file/);
        const bad = await call('ask_jev_filebool', { path: path.join(dir, 'nope.js'), question: 'q' });
        assert.equal(bad.isError, true);
    } finally {
        await client.close();
    }
});
