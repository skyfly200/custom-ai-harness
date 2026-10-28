// Chats and per-person data in Postgres, for the chat page's sync (ui/chat.js `sync`).
// The page keeps working from localStorage; with a database it also pushes each change here
// and pulls what other devices saved. Every row belongs to the signed-in user (req.harnessUser;
// 'local' when logins are off), and every query filters on it.
const express = require('express');
const db = require('./db');
const attachments = require('./attachments');

// Keys the page may store (projects, skills and so on); anything else is refused
const DATA_KEYS = new Set(['harness-projects', 'harness-skills', 'harness-commands', 'harness-schedules', 'harness-chat-prefs']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MSG_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const ownerOf = (req) => (req.harnessUser && req.harnessUser.name) || 'local';

// One statement, because the HTTPS driver has no transactions: it writes only if the chat is still at `base`
// (0 for a chat the server has not seen), upserts the changed messages, removes the ones no longer in the order,
// and moves the chat to the next version.
const SAVE_DELTA = `
WITH cur AS (SELECT version FROM chats WHERE owner = $1 AND id = $2),
ok AS (SELECT 1 AS x WHERE (NOT EXISTS (SELECT 1 FROM cur) AND $3::bigint = 0) OR EXISTS (SELECT 1 FROM cur WHERE version = $3::bigint)),
up AS (
  INSERT INTO chat_messages (owner, chat_id, id, data, updated)
  SELECT $1, $2, m.id, m.data, $4::bigint FROM jsonb_to_recordset($5::jsonb) AS m(id text, data jsonb) WHERE EXISTS (SELECT 1 FROM ok)
  ON CONFLICT (owner, chat_id, id) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated
  RETURNING 1),
del AS (
  DELETE FROM chat_messages WHERE owner = $1 AND chat_id = $2 AND NOT (id = ANY($6::text[])) AND EXISTS (SELECT 1 FROM ok)
  RETURNING 1)
INSERT INTO chats (owner, id, title, project, updated, data, msg_order, version, deleted_at)
SELECT $1, $2, $7, $8, $4::bigint, $9::jsonb, $10::jsonb, $3::bigint + 1, NULL WHERE EXISTS (SELECT 1 FROM ok)
ON CONFLICT (owner, id) DO UPDATE SET title = EXCLUDED.title, project = EXCLUDED.project, updated = EXCLUDED.updated,
  data = EXCLUDED.data, msg_order = EXCLUDED.msg_order, version = EXCLUDED.version, deleted_at = NULL
RETURNING version`;

async function saveDelta(owner, chat, order, upserts, base) {
    const { messages, syncVersion, ...meta } = chat;
    const rows = upserts.map((m) => ({ id: String(m.id), data: m }));
    const { rows: out } = await db.query(SAVE_DELTA, [
        owner, chat.id, base, Math.round(chat.updated), JSON.stringify(rows), order,
        String(chat.title || '').slice(0, 300), chat.project ? String(chat.project).slice(0, 64) : null,
        JSON.stringify(meta), JSON.stringify(order)]);
    if (out[0]) return { ok: true, version: Number(out[0].version) };
    const cur = await db.query('SELECT version FROM chats WHERE owner = $1 AND id = $2', [owner, chat.id]);
    return { ok: false, version: cur.rows[0] ? Number(cur.rows[0].version) : 0 };
}

function createChatSync({ serverSchedules = false } = {}) {
    const router = express.Router();
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
        console.error(`[sync] ${req.method} ${req.path}: ${err.message}`);
        res.status(500).json({ error: 'the chat database did not answer' });
    });

    router.use(attachments.routes(ownerOf, wrap));

    router.get('/ui/api/sync', wrap(async (req, res) => {
        const owner = ownerOf(req);
        const chats = (await db.query('SELECT id, title, project, updated, (deleted_at IS NOT NULL) AS deleted FROM chats WHERE owner = $1 ORDER BY updated DESC', [owner])).rows
            .map((r) => ({ ...r, updated: Number(r.updated) }));
        const data = {};
        for (const r of (await db.query('SELECT key, value, updated FROM user_data WHERE owner = $1 AND key = ANY($2::text[])', [owner, [...DATA_KEYS]])).rows) data[r.key] = { value: r.value, updated: Number(r.updated) };
        res.set('cache-control', 'no-store').json({ db: true, owner, chats, data, serverSchedules });
    }));

    router.get('/ui/api/sync/chats/:id', wrap(async (req, res) => {
        if (!ID.test(req.params.id)) return res.status(400).json({ error: 'bad chat id' });
        const owner = ownerOf(req);
        const { rows } = await db.query('SELECT data, msg_order, version FROM chats WHERE owner = $1 AND id = $2 AND deleted_at IS NULL', [owner, req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: 'no such chat' });
        const messages = (await db.query('SELECT id, data FROM chat_messages WHERE owner = $1 AND chat_id = $2', [owner, req.params.id])).rows;
        const byId = new Map(messages.map((m) => [m.id, m.data]));
        const order = Array.isArray(rows[0].msg_order) ? rows[0].msg_order : [];
        res.set('cache-control', 'no-store').json({ ...rows[0].data, messages: order.filter((id) => byId.has(id)).map((id) => byId.get(id)), syncVersion: Number(rows[0].version) });
    }));

    // Save a change: the chat without its messages, the messages that changed, and the order of all of them.
    // `base` is the version the sender last saw; if the chat has moved on (another device, the server) the
    // answer is 409 with the current version, and the sender pulls, joins the two and tries again.
    router.put('/ui/api/sync/chats/:id/delta', wrap(async (req, res) => {
        const { chat, order, upserts, base } = req.body || {};
        if (!ID.test(req.params.id) || !chat || chat.id !== req.params.id || !Number.isFinite(chat.updated)
            || !Array.isArray(order) || !Array.isArray(upserts) || !Number.isFinite(base)) return res.status(400).json({ error: 'bad chat' });
        const ids = order.map(String);
        if (ids.some((id) => !MSG_ID.test(id)) || upserts.some((m) => !m || !ids.includes(String(m.id)))) return res.status(400).json({ error: 'bad messages' });
        const out = await saveDelta(ownerOf(req), chat, ids, upserts, base);
        res.status(out.ok ? 200 : 409).json(out);
    }));

    // The whole chat in one go (an older page, or a first upload): newer wins, as before
    router.put('/ui/api/sync/chats/:id', wrap(async (req, res) => {
        const chat = req.body;
        if (!ID.test(req.params.id) || !chat || chat.id !== req.params.id || !Number.isFinite(chat.updated)) return res.status(400).json({ error: 'bad chat' });
        const owner = ownerOf(req);
        const messages = (Array.isArray(chat.messages) ? chat.messages : []).filter((m) => m && MSG_ID.test(String(m.id)));
        const { rows } = await db.query('SELECT updated, version FROM chats WHERE owner = $1 AND id = $2', [owner, chat.id]);
        if (rows[0] && Number(rows[0].updated) > chat.updated) return res.status(409).json({ ok: false });
        const out = await saveDelta(owner, chat, messages.map((m) => String(m.id)), messages, rows[0] ? Number(rows[0].version) : 0);
        res.status(out.ok ? 200 : 409).json(out);
    }));

    router.delete('/ui/api/sync/chats/:id', wrap(async (req, res) => {
        if (!ID.test(req.params.id)) return res.status(400).json({ error: 'bad chat id' });
        await db.query('DELETE FROM chat_messages WHERE owner = $1 AND chat_id = $2', [ownerOf(req), req.params.id]);
        await attachments.dropChat(ownerOf(req), req.params.id);
        await db.query(`UPDATE chats SET deleted_at = now(), data = '{}'::jsonb, msg_order = '[]'::jsonb WHERE owner = $1 AND id = $2`, [ownerOf(req), req.params.id]);
        res.json({ ok: true });
    }));

    router.put('/ui/api/sync/data/:key', wrap(async (req, res) => {
        const { value, updated } = req.body || {};
        if (!DATA_KEYS.has(req.params.key) || value === undefined || !Number.isFinite(updated)) return res.status(400).json({ error: 'bad data' });
        const { rows } = await db.query(
            `INSERT INTO user_data (owner, key, value, updated) VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (owner, key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated
             WHERE user_data.updated <= EXCLUDED.updated RETURNING key`,
            [ownerOf(req), req.params.key, JSON.stringify(value), Math.round(updated)]);
        res.status(rows.length ? 200 : 409).json({ ok: rows.length > 0 });
    }));

    return router;
}

module.exports = { createChatSync, saveDelta, DATA_KEYS };
