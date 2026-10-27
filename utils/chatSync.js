// Chats and per-person data in Postgres, for the chat page's sync (ui/chat.js `sync`).
// The page keeps working from localStorage; with a database it also pushes each change here
// and pulls what other devices saved. Every row belongs to the signed-in user (req.harnessUser;
// 'local' when logins are off), and every query filters on it.
const express = require('express');
const db = require('./db');

// Keys the page may store (projects, skills and so on); anything else is refused
const DATA_KEYS = new Set(['harness-projects', 'harness-skills', 'harness-commands', 'harness-schedules', 'harness-chat-prefs']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ownerOf = (req) => (req.harnessUser && req.harnessUser.name) || 'local';

function createChatSync() {
    const router = express.Router();
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
        console.error(`[sync] ${req.method} ${req.path}: ${err.message}`);
        res.status(500).json({ error: 'the chat database did not answer' });
    });

    router.get('/ui/api/sync', wrap(async (req, res) => {
        const owner = ownerOf(req);
        const chats = (await db.query('SELECT id, title, project, updated, (deleted_at IS NOT NULL) AS deleted FROM chats WHERE owner = $1 ORDER BY updated DESC', [owner])).rows
            .map((r) => ({ ...r, updated: Number(r.updated) }));
        const data = {};
        for (const r of (await db.query('SELECT key, value, updated FROM user_data WHERE owner = $1', [owner])).rows) data[r.key] = { value: r.value, updated: Number(r.updated) };
        res.set('cache-control', 'no-store').json({ db: true, owner, chats, data });
    }));

    router.get('/ui/api/sync/chats/:id', wrap(async (req, res) => {
        if (!ID.test(req.params.id)) return res.status(400).json({ error: 'bad chat id' });
        const { rows } = await db.query('SELECT data FROM chats WHERE owner = $1 AND id = $2 AND deleted_at IS NULL', [ownerOf(req), req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: 'no such chat' });
        res.set('cache-control', 'no-store').json(rows[0].data);
    }));

    // Newer wins: a copy older than the stored one is refused (409) so a stale tab can't overwrite
    router.put('/ui/api/sync/chats/:id', wrap(async (req, res) => {
        const chat = req.body;
        if (!ID.test(req.params.id) || !chat || chat.id !== req.params.id || !Number.isFinite(chat.updated)) return res.status(400).json({ error: 'bad chat' });
        const { rows } = await db.query(
            `INSERT INTO chats (owner, id, title, project, updated, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (owner, id) DO UPDATE SET title = EXCLUDED.title, project = EXCLUDED.project,
               updated = EXCLUDED.updated, data = EXCLUDED.data, deleted_at = NULL
             WHERE chats.updated <= EXCLUDED.updated RETURNING id`,
            [ownerOf(req), chat.id, String(chat.title || '').slice(0, 300), chat.project ? String(chat.project).slice(0, 64) : null, Math.round(chat.updated), JSON.stringify(chat)]);
        res.status(rows.length ? 200 : 409).json({ ok: rows.length > 0 });
    }));

    router.delete('/ui/api/sync/chats/:id', wrap(async (req, res) => {
        if (!ID.test(req.params.id)) return res.status(400).json({ error: 'bad chat id' });
        await db.query(`UPDATE chats SET deleted_at = now(), data = '{}'::jsonb WHERE owner = $1 AND id = $2`, [ownerOf(req), req.params.id]);
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

module.exports = { createChatSync, DATA_KEYS };
