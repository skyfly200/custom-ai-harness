// Dictation through the harness: /ui/api/stt against a fake OpenAI-style
// transcription server. Brave has no speech service of its own, so this is the
// only way dictation works there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const seen = [];
let mode = 'ok';
const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
        if (mode === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream is sad' })); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: '  hello from whisper  ' }));
    });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stt-'));
let harness, base;

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

test.before(async () => {
    const upstream = await listen(upstreamServer);
    process.env.STT_URL = `${upstream}/v1`;
    process.env.STT_MODEL = 'whisper-1';
    process.env.STT_API_KEY = 'sk-test';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    const { app } = require('../server');
    harness = http.createServer(app);
    base = await listen(harness);
});

test.after(() => { harness?.close(); upstreamServer.close(); });

const post = (body) => fetch(`${base}/ui/api/stt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const AUDIO = Buffer.from('fake-opus-bytes');

test('says which speech model it will use', async () => {
    const info = await (await fetch(`${base}/ui/api/stt`)).json();
    assert.equal(info.configured, true);
    assert.equal(info.model, 'whisper-1');
    assert.match(info.host, /127\.0\.0\.1/);
});

test('base64 audio becomes a multipart upload and the text comes back trimmed', async () => {
    seen.length = 0;
    mode = 'ok';
    const res = await post({ audio: AUDIO.toString('base64'), format: 'audio/webm;codecs=opus', language: 'en-US' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'hello from whisper' });
    const req = seen[0];
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.auth, 'Bearer sk-test');
    assert.match(req.type, /multipart\/form-data/);
    assert.match(req.body, /name="model"\r\n\r\nwhisper-1/);
    // transcription servers take an ISO-639-1 code, not en-US
    assert.match(req.body, /name="language"\r\n\r\nen\r\n/);
    assert.match(req.body, /filename="dictation.webm"/);
    assert.ok(req.body.includes(AUDIO.toString('latin1')), 'the audio bytes are sent as they came');
});

test('the model can be overridden per request', async () => {
    seen.length = 0;
    await post({ audio: AUDIO.toString('base64'), model: 'voxtral-mini' });
    assert.match(seen[0].body, /name="model"\r\n\r\nvoxtral-mini/);
    assert.doesNotMatch(seen[0].body, /name="language"/); // none set, none sent
});

test('an upstream refusal is a readable error, not a silent empty transcript', async () => {
    mode = 'down';
    const res = await post({ audio: AUDIO.toString('base64') });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 503.*upstream is sad/s);
    mode = 'ok';
});

test('empty or missing audio is refused before anything is sent', async () => {
    seen.length = 0;
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ audio: '###' })).status, 400);
    assert.equal(seen.length, 0);
});

test('dictation takes JSON from the chat page, not a raw upload', async () => {
    const res = await fetch(`${base}/ui/api/stt`, { method: 'POST', body: 'audio=x' });
    assert.equal(res.status, 415);
});
