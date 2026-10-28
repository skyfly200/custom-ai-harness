// Chat attachments in Postgres, apart from the chat text (migration 008). The page uploads each
// image or text file once, keeps a stub {kind, name, size, aid} in the synced message, and fetches
// the bytes back only when it needs them (to show an image, or to send a file to a model).
// Limits: HARNESS_ATTACH_MAX_MB per file (default 6) and HARNESS_ATTACH_QUOTA_MB per person (default 200).
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS = new Set(['image', 'text']);
const mb = (name, dflt) => Math.round((Number(process.env[name]) || dflt) * 1024 * 1024);
const maxFile = () => mb('HARNESS_ATTACH_MAX_MB', 6);
const quota = () => mb('HARNESS_ATTACH_QUOTA_MB', 200);

const aidOf = (body) => 'a' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);

async function usage(owner) {
    const { rows } = await db.query('SELECT COALESCE(SUM(size), 0) AS used FROM attachments WHERE owner = $1', [owner]);
    return Number(rows[0].used);
}

// Stores one attachment for a chat; the same bytes in the same chat are stored once.
async function put(owner, chatId, { kind, name, body }) {
    if (!ID.test(chatId)) return { status: 400, error: 'bad chat id' };
    if (!KINDS.has(kind) || typeof body !== 'string' || !body || typeof name !== 'string') return { status: 400, error: 'bad attachment' };
    if (kind === 'image' && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(body)) return { status: 400, error: 'an image must be a data URL' };
    const size = Buffer.byteLength(body);
    if (size > maxFile()) return { status: 413, error: `that file is over the ${maxFile() / 1048576} MB limit` };
    const id = aidOf(body);
    const have = await db.query('SELECT 1 FROM attachments WHERE owner = $1 AND chat_id = $2 AND id = $3', [owner, chatId, id]);
    if (have.rows.length) return { status: 200, id, size };
    if ((await usage(owner)) + size > quota()) return { status: 413, error: `your attachment space (${quota() / 1048576} MB) is full; delete old chats to free it` };
    await db.query(
        'INSERT INTO attachments (owner, chat_id, id, kind, name, size, body) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
        [owner, chatId, id, kind, name.slice(0, 300), size, body]);
    return { status: 200, id, size };
}

async function get(owner, chatId, id) {
    if (!ID.test(chatId) || !ID.test(id)) return null;
    const { rows } = await db.query('SELECT kind, name, size, body FROM attachments WHERE owner = $1 AND chat_id = $2 AND id = $3', [owner, chatId, id]);
    return rows[0] ? { ...rows[0], size: Number(rows[0].size) } : null;
}

const dropChat = (owner, chatId) => db.query('DELETE FROM attachments WHERE owner = $1 AND chat_id = $2', [owner, chatId]);

// Routes, mounted by chatSync with the same owner rule as the chats
function routes(ownerOf, wrap) {
    const router = express.Router();
    router.get('/ui/api/sync/attachments', wrap(async (req, res) => {
        res.set('cache-control', 'no-store').json({ used: await usage(ownerOf(req)), quota: quota(), maxFile: maxFile() });
    }));
    router.post('/ui/api/sync/chats/:chat/attachments', wrap(async (req, res) => {
        const out = await put(ownerOf(req), req.params.chat, req.body || {});
        res.status(out.status).json(out.error ? { error: out.error } : { id: out.id, size: out.size });
    }));
    router.get('/ui/api/sync/chats/:chat/attachments/:id', wrap(async (req, res) => {
        const a = await get(ownerOf(req), req.params.chat, req.params.id);
        if (!a) return res.status(404).json({ error: 'no such attachment' });
        res.set('cache-control', 'private, max-age=31536000, immutable').json(a);
    }));
    // The image itself, for an <img src>
    router.get('/ui/api/sync/chats/:chat/attachments/:id/raw', wrap(async (req, res) => {
        const a = await get(ownerOf(req), req.params.chat, req.params.id);
        const m = a && a.kind === 'image' && /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(a.body);
        if (!m) return res.status(404).end();
        res.set({ 'content-type': m[1], 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }).send(Buffer.from(m[2], 'base64'));
    }));
    return router;
}

module.exports = { put, get, dropChat, usage, routes, aidOf };
