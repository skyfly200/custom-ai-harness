// Telegram and Slack in front of the assistant (utils/assistant.js). Each channel only answers people on its
// allowlist, and each checks its own proof: Telegram a secret header (webhook mode), Slack a signed request.
//
// Telegram: long polling by default (works from a laptop with no public address). Set TELEGRAM_WEBHOOK_SECRET
// to use a webhook instead, at /ui/api/assistant/telegram (needs a public https address; `setWebhook` with the
// same secret).
// Slack: the Events API only, at /ui/api/assistant/slack (needs a public https address, e.g. the Cloudflare tunnel).
// The bot answers direct messages and @mentions from allowed users.
const crypto = require('crypto');

const TELEGRAM_MAX = 4000; // Telegram allows 4096 characters per message
const SLACK_MAX = 3900; // Slack's text limit is far larger; keep replies readable
const SLACK_SKEW_SECONDS = 300;

const list = (value) => new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean));

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Splits a reply into pieces of at most `max` characters, breaking at a newline or space where it can. */
function chunks(text, max) {
    const out = [];
    let rest = String(text || '');
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest || !out.length) out.push(rest);
    return out;
}

// ---- Telegram ----

/** A text message from an allowed chat, or null (other updates, bots, strangers). */
function telegramMessage(update, allowedChats) {
    const msg = update && update.message;
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return null;
    if (msg.from && msg.from.is_bot) return null;
    const chatId = String(msg.chat && msg.chat.id);
    if (!allowedChats.has(chatId)) return null;
    return { conversation: `telegram:${chatId}`, chatId, text: msg.text };
}

async function telegramCall(token, method, body, fetchImpl) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
}

async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
    for (const piece of chunks(text, TELEGRAM_MAX)) {
        await telegramCall(token, 'sendMessage', { chat_id: chatId, text: piece }, fetchImpl);
    }
}

// ---- Slack ----

/** Slack's v0 signature: HMAC-SHA256 of "v0:<timestamp>:<raw body>", refused when the timestamp is more than 5 minutes off. */
function slackSignatureOk({ signingSecret, timestamp, signature, rawBody, now = Date.now() }) {
    if (!signingSecret || !timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > SLACK_SKEW_SECONDS) return false;
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(`v0:${timestamp}:`);
    hmac.update(raw);
    return safeEqual(signature, `v0=${hmac.digest('hex')}`);
}

/** A direct message or @mention from an allowed user, or null. */
function slackMessage(payload, allowedUsers) {
    const ev = payload && payload.event;
    if (!ev || ev.bot_id || ev.subtype || !ev.user || !allowedUsers.has(ev.user)) return null;
    const direct = ev.type === 'message' && ev.channel_type === 'im';
    const mention = ev.type === 'app_mention';
    if (!direct && !mention) return null;
    const text = String(ev.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) return null;
    return { conversation: `slack:${ev.channel}`, channel: ev.channel, text, user: ev.user, thread: ev.thread_ts || null };
}

async function sendSlack({ token, channel, text, thread, fetchImpl = fetch }) {
    for (const piece of chunks(text, SLACK_MAX)) {
        const body = { channel, text: piece };
        if (thread) body.thread_ts = thread;
        const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(`Slack chat.postMessage: ${data.error || `HTTP ${res.status}`}`);
    }
}

/**
 * @param {object} opts
 * @param {object} opts.assistant  createAssistant() from utils/assistant.js
 * @param {object} [opts.env]      process.env by default
 * @param {function} [opts.fetchImpl]
 * @param {function} [opts.log]
 */
function createChannels({ assistant, env = process.env, fetchImpl = fetch, log = (m) => console.warn(m), now = () => Date.now(), pollSeconds = 25 }) {
    const tg = { token: env.TELEGRAM_BOT_TOKEN || '', chats: list(env.TELEGRAM_ALLOWED_CHAT_IDS), secret: env.TELEGRAM_WEBHOOK_SECRET || '' };
    const sl = { token: env.SLACK_BOT_TOKEN || '', signing: env.SLACK_SIGNING_SECRET || '', users: list(env.SLACK_ALLOWED_USER_IDS) };
    const problems = [];
    const telegramOn = Boolean(tg.token);
    const slackOn = Boolean(sl.token || sl.signing);
    if (telegramOn && !tg.chats.size) problems.push('Telegram: TELEGRAM_ALLOWED_CHAT_IDS is empty, so no chat can use the bot');
    if (slackOn && !(sl.token && sl.signing && sl.users.size)) problems.push('Slack: needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and SLACK_ALLOWED_USER_IDS');
    const telegram = telegramOn && tg.chats.size > 0;
    const slack = slackOn && Boolean(sl.token && sl.signing && sl.users.size);
    const telegramWebhook = telegram && Boolean(tg.secret);
    let polling = false;
    let stopped = false;

    async function answer(conversation, text, send) {
        let reply;
        try { reply = await assistant.handle(conversation, text); } catch (err) { reply = `Something went wrong: ${err.message}`; }
        if (!reply) return;
        try { await send(reply); } catch (err) { log(`assistant reply to ${conversation} failed: ${err.message}`); }
    }

    const telegramSend = (chatId) => (text) => sendTelegram({ token: tg.token, chatId, text, fetchImpl });

    // Logs each stranger once, with the id to add to the allowlist, so the owner can find their own chat id.
    const noted = new Set();
    function refused(kind, id) {
        const key = `${kind}:${id}`;
        if (noted.has(key)) return;
        noted.add(key);
        log(`Assistant: ignored a message from ${kind} ${id} (not on the allowlist; add it to ${kind.startsWith('Telegram') ? 'TELEGRAM_ALLOWED_CHAT_IDS' : 'SLACK_ALLOWED_USER_IDS'} to allow it)`);
    }
    function telegramUpdate(update) {
        const chatId = update && update.message && update.message.chat && update.message.chat.id;
        if (chatId !== undefined && !tg.chats.has(String(chatId)) && !(update.message.from && update.message.from.is_bot)) refused('Telegram chat', chatId);
        return telegramMessage(update, tg.chats);
    }

    /** Telegram's webhook: the secret header must match TELEGRAM_WEBHOOK_SECRET. Answers at once; the reply follows. */
    function telegramWebhookHandler(req, res) {
        if (!telegramWebhook || !safeEqual(req.get('x-telegram-bot-api-secret-token') || '', tg.secret)) return res.status(401).end();
        res.status(200).end();
        const m = telegramUpdate(req.body);
        if (m) answer(m.conversation, m.text, telegramSend(m.chatId));
    }

    /** Slack's Events API: verifies the signature, answers the URL check, acks within three seconds, then replies. */
    function slackWebhookHandler(req, res) {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!slack || !slackSignatureOk({ signingSecret: sl.signing, timestamp: req.get('x-slack-request-timestamp'), signature: req.get('x-slack-signature'), rawBody: raw, now: now() })) {
            return res.status(401).end();
        }
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
        if (payload.type === 'url_verification') return res.type('text').send(String(payload.challenge || ''));
        res.status(200).end();
        if (req.get('x-slack-retry-num')) return; // Slack resends an event it thinks was missed; the first copy is handled
        const m = slackMessage(payload, sl.users);
        const ev = payload.event;
        if (!m && ev && ev.user && !sl.users.has(ev.user) && (ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im'))) refused('Slack user', ev.user);
        if (m) answer(m.conversation, m.text, (text) => sendSlack({ token: sl.token, channel: m.channel, text, thread: m.thread, fetchImpl }));
    }

    async function poll() {
        let offset = 0;
        let failures = 0;
        while (!stopped) {
            try {
                const updates = await telegramCall(tg.token, 'getUpdates', { offset, timeout: pollSeconds, allowed_updates: ['message'] }, fetchImpl);
                failures = 0;
                for (const update of updates || []) {
                    offset = update.update_id + 1;
                    const m = telegramUpdate(update);
                    if (m) answer(m.conversation, m.text, telegramSend(m.chatId));
                }
            } catch (err) {
                failures += 1;
                log(`Telegram polling: ${err.message} (retry ${failures})`);
                await new Promise((resolve) => setTimeout(resolve, Math.min(60000, 2000 * 2 ** Math.min(failures, 5))));
            }
        }
    }

    /** Starts long polling (Telegram, without a webhook secret). Safe to call once; a no-op otherwise. */
    function start() {
        if (!telegram || telegramWebhook || polling) return false;
        polling = true;
        telegramCall(tg.token, 'deleteWebhook', { drop_pending_updates: false }, fetchImpl)
            .catch((err) => log(`Telegram: ${err.message}`))
            .then(() => poll());
        return true;
    }

    function stop() { stopped = true; }

    return {
        problems,
        telegramWebhookHandler,
        slackWebhookHandler,
        start,
        stop,
        status: () => ({
            telegram: telegram ? (telegramWebhook ? 'webhook' : 'polling') : 'off',
            slack: slack ? 'events' : 'off',
            telegramChats: tg.chats.size,
            slackUsers: sl.users.size,
        }),
    };
}

module.exports = {
    createChannels,
    telegramMessage,
    slackSignatureOk,
    slackMessage,
    sendTelegram,
    sendSlack,
    chunks,
    safeEqual,
};
