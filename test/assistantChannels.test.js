// Telegram and Slack in front of the assistant: allowlists, signatures, webhooks, polling and replies.
// Every outbound call goes through a fake fetch, so nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const channels = require('../utils/assistantChannels');

const sign = (secret, ts, raw) => 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A stand-in for an Express request/response pair, enough for the webhook handlers.
function fakeReq(headers, body) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { body, get: (name) => lower[name.toLowerCase()] };
}
function fakeRes() {
    const res = { code: 200, sent: null, ended: false };
    res.status = (c) => { res.code = c; return res; };
    res.end = () => { res.ended = true; return res; };
    res.type = () => res;
    res.send = (text) => { res.sent = text; return res; };
    return res;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function fakeAssistant(reply = 'pong') {
    const calls = [];
    return { calls, handle: async (conversation, text) => { calls.push({ conversation, text }); return reply; } };
}

test('a Telegram chat must be on the allowlist, and bots are ignored', () => {
    const allowed = new Set(['42']);
    const msg = (chatId, extra = {}) => ({ update_id: 1, message: { text: 'hi', chat: { id: chatId }, from: { id: 1 }, ...extra } });
    assert.deepEqual(channels.telegramMessage(msg(42), allowed), { conversation: 'telegram:42', chatId: '42', text: 'hi' });
    assert.equal(channels.telegramMessage(msg(99), allowed), null);
    assert.equal(channels.telegramMessage(msg(42, { from: { is_bot: true } }), allowed), null);
    assert.equal(channels.telegramMessage({ update_id: 2, edited_message: {} }, allowed), null);
});

test('chunks break long text at a newline or a space and never exceed the limit', () => {
    const text = 'a'.repeat(30) + '\n' + 'b'.repeat(30) + ' ' + 'c'.repeat(30);
    const parts = channels.chunks(text, 40);
    assert.ok(parts.every((p) => p.length <= 40), JSON.stringify(parts.map((p) => p.length)));
    assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
    assert.deepEqual(channels.chunks('short', 40), ['short']);
    assert.deepEqual(channels.chunks('', 40), ['']);
});

test('the Slack signature is checked against the raw body and a fresh timestamp', () => {
    const secret = 'shh';
    const raw = '{"type":"event_callback"}';
    const now = 1_700_000_000_000;
    const ts = String(now / 1000);
    const good = { signingSecret: secret, timestamp: ts, signature: sign(secret, ts, raw), rawBody: raw, now };
    assert.equal(channels.slackSignatureOk(good), true);
    assert.equal(channels.slackSignatureOk({ ...good, rawBody: raw + ' ' }), false);
    assert.equal(channels.slackSignatureOk({ ...good, signingSecret: 'other' }), false);
    assert.equal(channels.slackSignatureOk({ ...good, now: now + 301_000 }), false);
    assert.equal(channels.slackSignatureOk({ ...good, signature: undefined }), false);
});

test('Slack takes direct messages and mentions from allowed users, and strips the mention', () => {
    const users = new Set(['U1']);
    const dm = { event: { type: 'message', channel_type: 'im', channel: 'D9', user: 'U1', text: 'hello' } };
    assert.equal(channels.slackMessage(dm, users).text, 'hello');
    const mention = { event: { type: 'app_mention', channel: 'C5', user: 'U1', text: '<@UBOT> status please' } };
    assert.deepEqual(channels.slackMessage(mention, users), { conversation: 'slack:C5', channel: 'C5', text: 'status please', user: 'U1', thread: null });
    assert.equal(channels.slackMessage({ event: { ...dm.event, user: 'U2' } }, users), null);
    assert.equal(channels.slackMessage({ event: { ...dm.event, bot_id: 'B1' } }, users), null);
    assert.equal(channels.slackMessage({ event: { ...dm.event, subtype: 'message_changed' } }, users), null);
    assert.equal(channels.slackMessage({ event: { type: 'message', channel_type: 'channel', channel: 'C', user: 'U1', text: 'x' } }, users), null);
});

test('the Telegram webhook refuses a wrong secret and replies to an allowed chat', async () => {
    const replies = [];
    const fetchImpl = async (url, init) => {
        replies.push({ url, body: JSON.parse(init.body) });
        return jsonRes({ ok: true, result: {} });
    };
    const assistant = fakeAssistant('pong');
    const ch = channels.createChannels({
        assistant,
        env: { TELEGRAM_BOT_TOKEN: 'T0K', TELEGRAM_ALLOWED_CHAT_IDS: '42', TELEGRAM_WEBHOOK_SECRET: 's3cret' },
        fetchImpl,
        log: () => {},
    });
    assert.equal(ch.status().telegram, 'webhook');
    const update = { update_id: 5, message: { text: 'ping', chat: { id: 42 }, from: { id: 42 } } };

    const denied = fakeRes();
    ch.telegramWebhookHandler(fakeReq({ 'x-telegram-bot-api-secret-token': 'nope' }, update), denied);
    assert.equal(denied.code, 401);

    const ok = fakeRes();
    ch.telegramWebhookHandler(fakeReq({ 'x-telegram-bot-api-secret-token': 's3cret' }, update), ok);
    assert.equal(ok.code, 200);
    await tick();
    assert.deepEqual(assistant.calls, [{ conversation: 'telegram:42', text: 'ping' }]);
    assert.equal(replies.length, 1);
    assert.match(replies[0].url, /^https:\/\/api\.telegram\.org\/botT0K\/sendMessage$/);
    assert.deepEqual(replies[0].body, { chat_id: '42', text: 'pong' });
});

test('a Telegram update from a stranger is not answered, and the log names the chat id once', async () => {
    let called = false;
    const logs = [];
    const ch = channels.createChannels({
        assistant: fakeAssistant(),
        env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_ALLOWED_CHAT_IDS: '42', TELEGRAM_WEBHOOK_SECRET: 'x' },
        fetchImpl: async () => { called = true; return jsonRes({ ok: true, result: {} }); },
        log: (m) => logs.push(m),
    });
    const res = fakeRes();
    const stranger = { update_id: 1, message: { text: 'hi', chat: { id: 7 } } };
    ch.telegramWebhookHandler(fakeReq({ 'x-telegram-bot-api-secret-token': 'x' }, stranger), res);
    ch.telegramWebhookHandler(fakeReq({ 'x-telegram-bot-api-secret-token': 'x' }, stranger), fakeRes());
    assert.equal(res.code, 200);
    await tick();
    assert.equal(called, false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Telegram chat 7 .*TELEGRAM_ALLOWED_CHAT_IDS/);
});

test('the Slack webhook answers the URL check, then replies in the channel for a signed DM', async () => {
    const posts = [];
    const fetchImpl = async (url, init) => { posts.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return jsonRes({ ok: true }); };
    const assistant = fakeAssistant('hi from the assistant');
    const ch = channels.createChannels({
        assistant,
        env: { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 'sig', SLACK_ALLOWED_USER_IDS: 'U1' },
        fetchImpl,
        log: () => {},
        now: () => 1_700_000_000_000,
    });
    assert.equal(ch.status().slack, 'events');
    const ts = String(1_700_000_000);

    const verify = { type: 'url_verification', challenge: 'abc123' };
    const rawVerify = JSON.stringify(verify);
    const v = fakeRes();
    ch.slackWebhookHandler(fakeReq({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign('sig', ts, rawVerify) }, Buffer.from(rawVerify)), v);
    assert.equal(v.sent, 'abc123');

    const event = { type: 'event_callback', event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello there' } };
    const raw = JSON.stringify(event);
    const bad = fakeRes();
    ch.slackWebhookHandler(fakeReq({ 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=00' }, Buffer.from(raw)), bad);
    assert.equal(bad.code, 401);

    const res = fakeRes();
    ch.slackWebhookHandler(fakeReq({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign('sig', ts, raw) }, Buffer.from(raw)), res);
    assert.equal(res.code, 200);
    await tick();
    assert.deepEqual(assistant.calls, [{ conversation: 'slack:D1', text: 'hello there' }]);
    assert.equal(posts[0].url, 'https://slack.com/api/chat.postMessage');
    assert.equal(posts[0].auth, 'Bearer xoxb-1');
    assert.deepEqual(posts[0].body, { channel: 'D1', text: 'hi from the assistant' });

    // a retry of the same event is acknowledged but not answered again
    const retry = fakeRes();
    ch.slackWebhookHandler(fakeReq({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign('sig', ts, raw), 'x-slack-retry-num': '1' }, Buffer.from(raw)), retry);
    await tick();
    assert.equal(assistant.calls.length, 1);
});

test('misconfigured channels say what is missing and stay off', () => {
    const ch = channels.createChannels({
        assistant: fakeAssistant(),
        env: { TELEGRAM_BOT_TOKEN: 'T', SLACK_BOT_TOKEN: 'x' },
        fetchImpl: async () => jsonRes({ ok: true }),
    });
    assert.equal(ch.status().telegram, 'off');
    assert.equal(ch.status().slack, 'off');
    assert.equal(ch.problems.length, 2);
    assert.match(ch.problems[0], /TELEGRAM_ALLOWED_CHAT_IDS/);
    assert.match(ch.problems[1], /SLACK_SIGNING_SECRET/);
});

test('polling reads updates, answers the allowed chat, and stops when asked', async () => {
    const sent = [];
    const calls = [];
    let ch;
    let offsets = [];
    const fetchImpl = async (url, init) => {
        const method = url.split('/').pop();
        calls.push(method);
        if (method === 'deleteWebhook') return jsonRes({ ok: true, result: true });
        if (method === 'getUpdates') {
            const body = JSON.parse(init.body);
            offsets.push(body.offset);
            if (body.offset === 0) return jsonRes({ ok: true, result: [{ update_id: 10, message: { text: 'hey', chat: { id: 42 }, from: { id: 42 } } }] });
            ch.stop();
            return jsonRes({ ok: true, result: [] });
        }
        if (method === 'sendMessage') { sent.push(JSON.parse(init.body)); return jsonRes({ ok: true, result: {} }); }
        return jsonRes({ ok: false, description: 'unknown' }, 400);
    };
    ch = channels.createChannels({
        assistant: fakeAssistant('got it'),
        env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_ALLOWED_CHAT_IDS: '42' },
        fetchImpl,
        log: () => {},
        pollSeconds: 0,
    });
    assert.equal(ch.status().telegram, 'polling');
    assert.equal(ch.start(), true);
    assert.equal(ch.start(), false);
    for (let i = 0; i < 50 && sent.length === 0; i += 1) await tick();
    for (let i = 0; i < 50 && calls.filter((c) => c === 'getUpdates').length < 2; i += 1) await tick();
    assert.equal(calls[0], 'deleteWebhook');
    assert.deepEqual(offsets, [0, 11]);
    assert.deepEqual(sent, [{ chat_id: '42', text: 'got it' }]);
});

// ---- Discord ----

class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeSocket.last = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; if (this.onclose) this.onclose(); }
    deliver(packet) { this.onmessage({ data: JSON.stringify(packet) }); }
}

test('a Discord direct message from an allowed user is answered; a server message needs a mention', () => {
    const users = new Set(['U1']);
    const dm = { author: { id: 'U1' }, channel_id: 'D1', content: 'hello' };
    assert.deepEqual(channels.discordMessage(dm, users, 'BOT'), { conversation: 'discord:D1', channel: 'D1', text: 'hello', user: 'U1' });
    const quiet = { author: { id: 'U1' }, channel_id: 'C1', guild_id: 'G1', content: 'hello' };
    assert.equal(channels.discordMessage(quiet, users, 'BOT'), null);
    const mention = { author: { id: 'U1' }, channel_id: 'C1', guild_id: 'G1', content: '<@!BOT> status please', mentions: [{ id: 'BOT' }] };
    assert.equal(channels.discordMessage(mention, users, 'BOT').text, 'status please');
    assert.equal(channels.discordMessage({ ...dm, author: { id: 'U2' } }, users, 'BOT'), null);
    assert.equal(channels.discordMessage({ ...dm, author: { id: 'U1', bot: true } }, users, 'BOT'), null);
});

test('a Discord reply is posted with the bot token, and a long reply is split', async () => {
    const posts = [];
    const fetchImpl = async (url, init) => { posts.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body).content }); return jsonRes({ id: '1' }); };
    await channels.sendDiscord({ token: 'T0', channel: 'C9', text: 'short', fetchImpl });
    assert.deepEqual(posts[0], { url: 'https://discord.com/api/v10/channels/C9/messages', auth: 'Bot T0', body: 'short' });
    const long = `${'a'.repeat(1200)}\n${'b'.repeat(1200)}`;
    posts.length = 0;
    await channels.sendDiscord({ token: 'T0', channel: 'C9', text: long, fetchImpl });
    assert.equal(posts.length, 2);
    assert.ok(posts.every((p) => p.body.length <= 1900));
});

test('a Discord send error names Discord, not the token', async () => {
    const fetchImpl = async () => jsonRes({ message: 'Missing Access', code: 50001 }, 403);
    await assert.rejects(channels.sendDiscord({ token: 'SECRET', channel: 'C', text: 'x', fetchImpl }), (err) => err.message === 'Discord send: Missing Access' && !err.message.includes('SECRET'));
});

test('the Discord gateway identifies with the intents, answers an allowed DM, and stops cleanly', async () => {
    const posts = [];
    const fetchImpl = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return jsonRes({ id: '2' }); };
    const assistant = fakeAssistant('pong');
    const logs = [];
    const ch = channels.createChannels({
        assistant,
        env: { DISCORD_BOT_TOKEN: 'DTOK', DISCORD_ALLOWED_USER_IDS: 'U1' },
        fetchImpl,
        log: (m) => logs.push(m),
        WebSocketImpl: FakeSocket,
    });
    assert.equal(ch.status().discord, 'gateway');
    ch.start();
    const socket = FakeSocket.last;
    assert.match(socket.url, /gateway\.discord\.gg/);
    socket.deliver({ op: 10, d: { heartbeat_interval: 600000 } });
    assert.equal(socket.sent[0].op, 2);
    assert.equal(socket.sent[0].d.token, 'DTOK');
    assert.equal(socket.sent[0].d.intents, 37377); // GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT
    socket.deliver({ op: 0, t: 'READY', s: 1, d: { user: { id: 'BOT' } } });
    assert.match(logs.join('\n'), /connected as bot BOT/);

    socket.deliver({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { author: { id: 'U1' }, channel_id: 'D7', content: 'hey' } });
    socket.deliver({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { author: { id: 'U9' }, channel_id: 'D8', content: 'who am I talking to' } });
    for (let i = 0; i < 20 && posts.length === 0; i += 1) await tick();
    assert.deepEqual(assistant.calls, [{ conversation: 'discord:D7', text: 'hey' }]);
    assert.deepEqual(posts, [{ url: 'https://discord.com/api/v10/channels/D7/messages', body: { content: 'pong' } }]);
    assert.equal(logs.filter((m) => /Discord user U9/.test(m)).length, 1);

    ch.stop();
    assert.equal(socket.closed, true);
});

test('Discord with a token but no allowed users says so and stays off', () => {
    const ch = channels.createChannels({ assistant: fakeAssistant(), env: { DISCORD_BOT_TOKEN: 'T' }, fetchImpl: async () => jsonRes({}), log: () => {}, WebSocketImpl: FakeSocket });
    assert.equal(ch.status().discord, 'off');
    assert.ok(ch.problems.some((p) => /DISCORD_ALLOWED_USER_IDS/.test(p)));
});
