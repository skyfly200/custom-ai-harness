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

const PERSON = /^[A-Za-z0-9_.@+-]{1,80}$/;
const SHARED_PROJECT_FIELDS = ['id', 'name', 'color', 'instructions'];
const sharedView = (p) => Object.fromEntries(SHARED_PROJECT_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

// What `me` may do with a chat of `owner`'s: 'edit', 'view' or null. Only a project the owner shared counts,
// and a guest never gets in (guests have no sharing).
const ACCESS = `
SELECT s.role FROM chats c JOIN project_shares s ON s.owner = c.owner AND s.project_id = c.project
WHERE c.owner = $1 AND c.id = $2 AND c.deleted_at IS NULL AND s.grantee IN ($3, '*') ORDER BY (s.role = 'edit') DESC LIMIT 1`;
const PROJECT_ACCESS = `SELECT role FROM project_shares WHERE owner = $1 AND project_id = $2 AND grantee IN ($3, '*') ORDER BY (role = 'edit') DESC LIMIT 1`;

// users (optional): { names() -> [{ name, guest }] }. Without it (logins off) nothing can be shared.
function createChatSync({ serverSchedules = false, users = null } = {}) {
    const router = express.Router();
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
        console.error(`[sync] ${req.method} ${req.path}: ${err.message}`);
        res.status(500).json({ error: 'the chat database did not answer' });
    });

    router.use(attachments.routes(ownerOf, wrap));
    const canShare = (req) => Boolean(users) && ownerOf(req) !== 'local' && !(req.harnessUser && req.harnessUser.guest);
    const roleOn = async (req, owner, chatId) => {
        if (!canShare(req) || owner === ownerOf(req)) return null;
        const { rows } = await db.query(ACCESS, [owner, chatId, ownerOf(req)]);
        return rows[0] ? rows[0].role : null;
    };
    const projectsOf = async (owner) => {
        const { rows } = await db.query('SELECT value FROM user_data WHERE owner = $1 AND key = $2', [owner, 'harness-projects']);
        return rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
    };

    router.get('/ui/api/sync', wrap(async (req, res) => {
        const owner = ownerOf(req);
        const chats = (await db.query('SELECT id, title, project, updated, (deleted_at IS NOT NULL) AS deleted FROM chats WHERE owner = $1 ORDER BY updated DESC', [owner])).rows
            .map((r) => ({ ...r, updated: Number(r.updated) }));
        const data = {};
        for (const r of (await db.query('SELECT key, value, updated FROM user_data WHERE owner = $1 AND key = ANY($2::text[])', [owner, [...DATA_KEYS]])).rows) data[r.key] = { value: r.value, updated: Number(r.updated) };
        res.set('cache-control', 'no-store').json({ db: true, owner, chats, data, serverSchedules, canShare: canShare(req) });
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

    // ---- sharing ----
    const shareGate = (req, res) => { if (canShare(req)) return true; res.status(403).json({ error: 'sharing is for signed-in people with a full account' }); return false; };

    // Who a project is shared with (owner), and what has been shared with me
    router.get('/ui/api/sync/shares', wrap(async (req, res) => {
        if (!shareGate(req, res)) return;
        const me = ownerOf(req);
        const mine = (await db.query('SELECT project_id, grantee, role FROM project_shares WHERE owner = $1', [me])).rows;
        const rows = (await db.query(`SELECT owner, project_id, role FROM project_shares WHERE grantee IN ($1, '*') AND owner <> $1`, [me])).rows;
        const best = new Map();
        for (const r of rows) { const k = `${r.owner}\n${r.project_id}`; if (!best.has(k) || r.role === 'edit') best.set(k, r); }
        const withMe = [];
        for (const r of best.values()) {
            const project = (await projectsOf(r.owner)).find((p) => p && p.id === r.project_id);
            if (!project) continue;
            const chats = (await db.query('SELECT id, title, updated FROM chats WHERE owner = $1 AND project = $2 AND deleted_at IS NULL ORDER BY updated DESC', [r.owner, r.project_id])).rows
                .map((c) => ({ ...c, updated: Number(c.updated) }));
            withMe.push({ owner: r.owner, role: r.role, project: sharedView(project), chats });
        }
        res.set('cache-control', 'no-store').json({ mine, withMe });
    }));

    // Existing, non-guest users the owner may invite
    router.get('/ui/api/sync/shares/people', wrap(async (req, res) => {
        if (!shareGate(req, res)) return;
        const me = ownerOf(req);
        res.set('cache-control', 'no-store').json({ people: users.names().filter((u) => !u.guest && u.name !== me).map((u) => u.name).sort() });
    }));

    // Replace who a project is shared with: { grants: [{ user, role }], everyone: '' | 'view' | 'edit' }
    router.put('/ui/api/sync/shares/:project', wrap(async (req, res) => {
        if (!shareGate(req, res)) return;
        const me = ownerOf(req);
        const { grants = [], everyone = '' } = req.body || {};
        if (!ID.test(req.params.project) || !Array.isArray(grants) || grants.length > 100 || !['', 'view', 'edit'].includes(everyone || '')) return res.status(400).json({ error: 'bad share' });
        if (!(await projectsOf(me)).some((p) => p && p.id === req.params.project)) return res.status(404).json({ error: 'no such project' });
        const known = new Map(users.names().map((u) => [u.name, u]));
        const rows = [];
        for (const g of grants) {
            const u = g && known.get(String(g.user));
            if (!u || !PERSON.test(u.name) || u.name === me) return res.status(400).json({ error: `${g && g.user} is not a user you can share with` });
            if (u.guest) return res.status(400).json({ error: `${u.name} is a guest, and guests don't get shared projects` });
            if (!['view', 'edit'].includes(g.role)) return res.status(400).json({ error: 'role must be view or edit' });
            rows.push({ grantee: u.name, role: g.role });
        }
        if (everyone) rows.push({ grantee: '*', role: everyone });
        await db.query(`
WITH del AS (DELETE FROM project_shares WHERE owner = $1 AND project_id = $2 AND NOT (grantee = ANY($3::text[])) RETURNING 1)
INSERT INTO project_shares (owner, project_id, grantee, role) SELECT $1, $2, g.grantee, g.role FROM jsonb_to_recordset($4::jsonb) AS g(grantee text, role text)
ON CONFLICT (owner, project_id, grantee) DO UPDATE SET role = EXCLUDED.role`,
        [me, req.params.project, rows.map((r) => r.grantee), JSON.stringify(rows)]);
        res.json({ ok: true });
    }));

    router.get('/ui/api/sync/shared/:owner/chats/:id', wrap(async (req, res) => {
        const { owner, id } = req.params;
        if (!ID.test(id) || !PERSON.test(owner)) return res.status(400).json({ error: 'bad chat id' });
        const role = await roleOn(req, owner, id);
        if (!role) return res.status(404).json({ error: 'no such chat' });
        const { rows } = await db.query('SELECT data, msg_order, version FROM chats WHERE owner = $1 AND id = $2 AND deleted_at IS NULL', [owner, id]);
        if (!rows[0]) return res.status(404).json({ error: 'no such chat' });
        const messages = (await db.query('SELECT id, data FROM chat_messages WHERE owner = $1 AND chat_id = $2', [owner, id])).rows;
        const byId = new Map(messages.map((m) => [m.id, m.data]));
        const order = Array.isArray(rows[0].msg_order) ? rows[0].msg_order : [];
        res.set('cache-control', 'no-store').json({ ...rows[0].data, messages: order.filter((m) => byId.has(m)).map((m) => byId.get(m)), syncVersion: Number(rows[0].version), sharedFrom: owner, sharedRole: role });
    }));

    // Writing a shared chat needs 'edit'. A chat that doesn't exist yet may be started in a project shared for editing;
    // it is then kept with the project's owner. The chat's project can't be moved out of the shared project.
    router.put('/ui/api/sync/shared/:owner/chats/:id/delta', wrap(async (req, res) => {
        const { owner, id } = req.params;
        const { chat, order, upserts, base } = req.body || {};
        if (!ID.test(id) || !PERSON.test(owner) || !chat || chat.id !== id || !Number.isFinite(chat.updated)
            || !Array.isArray(order) || !Array.isArray(upserts) || !Number.isFinite(base)) return res.status(400).json({ error: 'bad chat' });
        const ids = order.map(String);
        if (ids.some((m) => !MSG_ID.test(m)) || upserts.some((m) => !m || !ids.includes(String(m.id)))) return res.status(400).json({ error: 'bad messages' });
        if (!canShare(req) || owner === ownerOf(req)) return res.status(403).json({ error: 'not shared with you' });
        const existing = (await db.query('SELECT project FROM chats WHERE owner = $1 AND id = $2', [owner, id])).rows[0];
        const project = existing ? existing.project : (chat.project ? String(chat.project) : null);
        const role = project && (await db.query(PROJECT_ACCESS, [owner, project, ownerOf(req)])).rows[0];
        if (!role || role.role !== 'edit') return res.status(403).json({ error: 'this project is not shared with you for editing' });
        const { sharedFrom, sharedRole, ...meta } = chat;
        const out = await saveDelta(owner, { ...meta, project }, ids, upserts, base);
        res.status(out.ok ? 200 : 409).json(out);
    }));

    // Edit the shared project's own settings (name, colour, instructions); needs 'edit'
    router.put('/ui/api/sync/shared/:owner/projects/:id', wrap(async (req, res) => {
        const { owner, id } = req.params;
        if (!ID.test(id) || !PERSON.test(owner)) return res.status(400).json({ error: 'bad project' });
        if (!canShare(req) || owner === ownerOf(req)) return res.status(403).json({ error: 'not shared with you' });
        const role = (await db.query(PROJECT_ACCESS, [owner, id, ownerOf(req)])).rows[0];
        if (!role || role.role !== 'edit') return res.status(403).json({ error: 'this project is not shared with you for editing' });
        const body = req.body || {};
        const list = await projectsOf(owner);
        const p = list.find((x) => x && x.id === id);
        if (!p) return res.status(404).json({ error: 'no such project' });
        if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim().slice(0, 60);
        if (typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color)) p.color = body.color;
        if (typeof body.instructions === 'string') p.instructions = body.instructions.slice(0, 20000);
        await db.query(`UPDATE user_data SET value = $3::jsonb, updated = $4 WHERE owner = $1 AND key = $2`, [owner, 'harness-projects', JSON.stringify(list), Date.now()]);
        res.json({ ok: true, project: sharedView(p) });
    }));

    return router;
}

module.exports = { createChatSync, saveDelta, DATA_KEYS };
