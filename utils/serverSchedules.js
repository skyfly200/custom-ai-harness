// Scheduled messages that run on the server, so they go out with every tab closed. The schedules are the
// ones the chat page keeps (user_data key 'harness-schedules', one list per person). Every few seconds the
// server looks for a due one, claims it by moving its `next` forward in the same row (so two servers, or a
// server and a stale page, can't both send it), writes the message into the target chat, asks the model
// through its own /v1/chat/completions (routed, billed and limited like a page's request) and saves the reply.
//
// What a server run knows: the chat's history (attachments included), the project's instructions, the chat's
// system prompt and notes, skills that are switched on, and the chat's or project's routing. It has no tools
// (MCP, repo, shell): a scheduled message that needs them is answered without.
const crypto = require('crypto');
const db = require('./db');
const chatSync = require('./chatSync');
const chatReplies = require('./chatReplies');
const attachments = require('./attachments');
const internalAuth = require('./internalAuth');
const { nextRun } = require('../ui/schedule');

const KEY = 'harness-schedules';
const uid = () => crypto.randomBytes(6).toString('hex');
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DUPLICATE_MS = 2 * 60 * 1000; // a schedule that ran this recently is not run again (a stale page put it back)

const enabled = () => db.enabled() && !/^(0|false|no|off)$/i.test(process.env.HARNESS_SERVER_SCHEDULES || '');
const keepAwake = () => !/^(0|false|no|off)$/i.test(process.env.HARNESS_SCHEDULES_KEEP_AWAKE || '');

const getData = async (owner, key) => (await db.query('SELECT value FROM user_data WHERE owner = $1 AND key = $2', [owner, key])).rows[0]?.value;

function routeHeaders(chat, project) {
    const own = chat.route && chat.route !== 'project';
    const pick = own ? { route: chat.route, model: chat.model } : project && project.route ? { route: project.route, model: project.model } : { route: 'default' };
    const effort = chat.effort && chat.effort !== 'auto' ? { 'x-harness-effort': chat.effort } : {};
    if (pick.route === 'model' && String(pick.model || '').trim()) return { 'x-harness-model': pick.model.trim() };
    if (pick.route === 'auto') return { 'x-harness-profile': 'auto', ...effort };
    if (String(pick.route || '').startsWith('p:')) return { 'x-harness-profile': pick.route.slice(2), ...effort };
    return effort;
}

async function userText(owner, chatId, m) {
    const parts = [m.content];
    let images = 0;
    for (const a of m.attachments || []) {
        if (a.kind === 'image') { images++; continue; }
        let text = a.text;
        if (text == null && a.aid) text = (await attachments.get(owner, chatId, a.aid))?.body;
        if (text != null) parts.push(`<file name="${a.name}">\n${text}\n</file>`);
    }
    if (images) parts.push(`(${images} attached image${images > 1 ? 's were' : ' was'} not included in this scheduled run)`);
    return parts.filter(Boolean).join('\n\n');
}

async function contextFor(owner, chat, project) {
    const parts = [];
    if (project && String(project.instructions || '').trim()) parts.push(`Instructions for the project "${project.name}":\n\n${project.instructions.trim()}`);
    if (String(chat.system || '').trim()) parts.push(chat.system.trim());
    if (String(chat.notes || '').trim()) parts.push(`Context notes from the user:\n\n${chat.notes.trim()}`);
    const ids = new Set([...(chat.skills || []), ...((project && project.skills) || [])]);
    if (ids.size) {
        const skills = (await getData(owner, 'harness-skills')) || [];
        for (const k of skills) if (ids.has(k.id) && k.body) parts.push(`Skill "${k.name}" is on. Follow it:\n\n${k.body.trim()}`);
    }
    return parts.join('\n\n');
}

// The model's answer, asked of this server as `owner`. Replaceable in tests.
async function defaultComplete({ owner, chatId, body, headers }) {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-harness-session': `chat-${chatId}`, 'x-harness-client': 'scheduled message', ...headers, ...internalAuth.headersFor(owner) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.HARNESS_SCHEDULE_TIMEOUT_MS) || 10 * 60 * 1000),
    });
    const text = await res.text();
    if (!res.ok) {
        let msg = text;
        try { const j = JSON.parse(text); msg = j.error?.message || j.error || text; } catch { /* plain text */ }
        throw new Error(`HTTP ${res.status}: ${String(msg).slice(0, 400)}`);
    }
    const j = JSON.parse(text);
    return { text: j.choices?.[0]?.message?.content || '', model: res.headers.get('x-harness-model') || j.model };
}

function create({ complete = defaultComplete, now = () => Date.now(), intervalMs = 30 * 1000 } = {}) {
    let running = 0;
    let known = 0;       // enabled schedules seen at the last look, across everyone
    let timer = null;
    let looking = false;

    // Add the schedule's message (and an empty reply) to its chat, making the chat when there is none
    async function open(owner, s, project, tries = 0) {
        let chat = null, order = [], base = 0;
        if (String(s.target || '').startsWith('chat:') && ID.test(s.target.slice(5))) {
            const { rows } = await db.query('SELECT data, msg_order, version FROM chats WHERE owner = $1 AND id = $2 AND deleted_at IS NULL', [owner, s.target.slice(5)]);
            if (rows[0]) { chat = { ...rows[0].data, id: s.target.slice(5) }; order = rows[0].msg_order || []; base = Number(rows[0].version); }
        }
        if (!chat) {
            const t = new Date(now());
            chat = { id: `s${uid()}`, title: `${s.name || 'Scheduled'} · ${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: s.tz || 'UTC' })}`,
                created: now(), updated: now(), system: '', notes: '', scheduled: s.id, ...(project ? { project: project.id } : {}) };
        }
        const user = { id: `u${uid()}`, role: 'user', content: s.prompt, time: now(), scheduled: true };
        const reply = { id: `a${uid()}`, role: 'assistant', content: '', streaming: true, time: now() };
        chat.updated = now();
        const out = await chatSync.saveDelta(owner, chat, [...order, user.id, reply.id], [user, reply], base);
        if (!out.ok) {
            if (tries >= 2) throw new Error('the target chat kept changing');
            return open(owner, s, project, tries + 1);
        }
        return { chat, user, reply, history: order };
    }

    async function run(owner, s) {
        const projects = (await getData(owner, 'harness-projects')) || [];
        const wanted = String(s.target || '').startsWith('new:') ? s.target.slice(4) : null;
        const project = wanted ? projects.find((p) => p.id === wanted) : null;
        const { chat, user, reply, history } = await open(owner, s, project);
        const proj = project || projects.find((p) => p.id === chat.project) || null;
        try {
            const sys = await contextFor(owner, chat, proj);
            const messages = sys ? [{ role: 'system', content: sys }] : [];
            if (history.length) {
                const { rows } = await db.query('SELECT id, data FROM chat_messages WHERE owner = $1 AND chat_id = $2', [owner, chat.id]);
                const byId = new Map(rows.map((r) => [r.id, r.data]));
                for (const id of history) {
                    const m = byId.get(id);
                    if (!m || m.streaming) continue;
                    if (m.role === 'user') messages.push({ role: 'user', content: await userText(owner, chat.id, m) });
                    else if (m.role === 'assistant' && m.content) messages.push({ role: 'assistant', content: m.content });
                }
            }
            messages.push({ role: 'user', content: s.prompt });
            const { text, model } = await complete({ owner, chatId: chat.id, body: { model: 'auto', messages }, headers: routeHeaders(chat, proj) });
            await chatReplies.save({ owner, chatId: chat.id, messageId: reply.id, text: text || '*(the model sent no reply)*', model });
        } catch (err) {
            console.error(`[schedules] ${owner}/${s.id}: ${err.message}`);
            await chatReplies.save({ owner, chatId: chat.id, messageId: reply.id, text: `*(scheduled run failed: ${err.message})*` }).catch(() => {});
        }
        return { chat: chat.id, user: user.id, reply: reply.id };
    }

    // One look: claim whatever is due, then run it in the background
    async function tick() {
        if (looking) return [];
        looking = true;
        const started = [];
        try {
            const { rows } = await db.query(`SELECT owner, value, updated FROM user_data WHERE key = $1 AND jsonb_typeof(value) = 'array'`, [KEY]);
            known = 0;
            for (const row of rows) {
                const list = Array.isArray(row.value) ? row.value : [];
                known += list.filter((s) => s && s.next).length;
                const at = now();
                const due = list.filter((s) => s && s.prompt && s.next && s.next <= at);
                if (!due.length) continue;
                const claimed = [];
                const next = list.map((s) => {
                    if (!due.includes(s)) return s;
                    const recent = s.last && at - s.last < DUPLICATE_MS;
                    if (!recent) claimed.push(s);
                    return { ...s, last: recent ? s.last : at, next: s.repeat === 'once' ? null : nextRun(s.start, s.repeat, at, s.tz) };
                });
                const won = await db.query('UPDATE user_data SET value = $3::jsonb, updated = $4 WHERE owner = $1 AND key = $2 AND updated = $5 RETURNING key',
                    [row.owner, KEY, JSON.stringify(next), Math.max(at, Number(row.updated) + 1), Number(row.updated)]);
                if (!won.rows.length) continue; // someone else changed or claimed them; the next look sees the new state
                for (const s of claimed) {
                    running++;
                    started.push(run(row.owner, s).catch((err) => console.error(`[schedules] ${err.message}`)).finally(() => { running--; }));
                }
            }
        } finally { looking = false; }
        return started;
    }

    function start() {
        if (timer) return;
        const go = () => tick().catch((err) => console.error(`[schedules] ${err.message}`));
        setTimeout(go, 3000).unref();
        timer = setInterval(go, intervalMs);
        timer.unref();
    }
    const stop = () => { clearInterval(timer); timer = null; };

    // Keeps the server from sleeping: a run is in progress, or schedules exist (Fly can't wake it for them)
    const busy = () => running > 0 || (keepAwake() && known > 0);

    return { tick, run, start, stop, busy, status: () => ({ running, schedules: known }) };
}

module.exports = { create, enabled, keepAwake, routeHeaders };
