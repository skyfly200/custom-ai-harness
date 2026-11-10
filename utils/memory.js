// Memory: short notes a person keeps across every chat, that the model reads and may add to, change or
// remove. Each note is one fact or preference ("prefers metric units", "the staging app is harness-staging").
// Kept per person in user_data (key "harness-memory") when there is a database, else in memory.json next to
// the other local state (HARNESS_MEMORY_FILE), keyed by owner. The chat page puts the notes in the system
// prompt when Memory is on and offers memory_save / memory_forget as tools; this module only stores them.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const KEY = 'harness-memory';
const LOCAL = '_local';
const MAX_NOTES = 200;
const MAX_TEXT = 500;

const file = () => process.env.HARNESS_MEMORY_FILE || path.join(__dirname, '..', 'memory.json');

// ---- storage ----
let chain = Promise.resolve(); // read-modify-write one at a time
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

async function load(owner) {
    if (db.enabled()) {
        const { rows } = await db.query('SELECT value FROM user_data WHERE owner = $1 AND key = $2', [owner, KEY]);
        return rows[0] ? rows[0].value : { notes: [] };
    }
    try { return JSON.parse(fs.readFileSync(file(), 'utf8'))[owner] || { notes: [] }; } catch { return { notes: [] }; }
}
async function store(owner, value) {
    if (db.enabled()) {
        await db.query(
            `INSERT INTO user_data (owner, key, value, updated) VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (owner, key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated`,
            [owner, KEY, JSON.stringify(value), Date.now()]);
        return;
    }
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first save */ }
    all[owner] = value;
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

const uid = () => `m${crypto.randomBytes(5).toString('hex')}`;

/** Trim and check one note's text. */
function cleanText(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) throw Object.assign(new Error('the note is empty'), { status: 400 });
    if (t.length > MAX_TEXT) throw Object.assign(new Error(`a note is at most ${MAX_TEXT} characters`), { status: 400 });
    return t;
}

// ---- operations (owner = the signed-in name, or _local on your own machine) ----
/** The person's notes, oldest first. */
async function list(owner = LOCAL) {
    const { notes = [] } = await load(owner);
    return notes.map((n) => ({ ...n }));
}

/** Add a note. A note that repeats an existing one (ignoring case) is not added twice. */
function add(owner = LOCAL, input = {}, now = Date.now()) {
    return serial(async () => {
        const data = await load(owner);
        const notes = data.notes || [];
        const text = cleanText(input.text);
        const same = notes.find((n) => n.text.toLowerCase() === text.toLowerCase());
        if (same) return { ...same, existing: true };
        if (notes.length >= MAX_NOTES) throw Object.assign(new Error(`at most ${MAX_NOTES} notes; remove some first`), { status: 400 });
        const note = { id: uid(), text, created: now, updated: now };
        notes.push(note);
        await store(owner, { ...data, notes });
        return note;
    });
}

/** Change a note's text. */
function update(owner = LOCAL, id, input = {}, now = Date.now()) {
    return serial(async () => {
        const data = await load(owner);
        const n = (data.notes || []).find((x) => x.id === id);
        if (!n) throw Object.assign(new Error('no such note'), { status: 404 });
        n.text = cleanText(input.text);
        n.updated = now;
        await store(owner, data);
        return { ...n };
    });
}

function remove(owner = LOCAL, id) {
    return serial(async () => {
        const data = await load(owner);
        const before = (data.notes || []).length;
        data.notes = (data.notes || []).filter((x) => x.id !== id);
        if (data.notes.length === before) throw Object.assign(new Error('no such note'), { status: 404 });
        await store(owner, data);
    });
}

// ---- pure helpers ----
/**
 * The system-prompt text for the notes: the instructions for the memory tools, then each note with its id
 * so the model can name one to change or remove. The instructions stay even when the list is empty, since
 * the model can still save a first note.
 */
function promptText(notes = []) {
    const head = 'Memory: notes the user keeps across all their chats. Use them when relevant and do not repeat them back unprompted. '
        + 'When the user asks you to remember something, or states a lasting preference or fact about themselves or their work, call memory_save with a short note. '
        + 'When a note is wrong, call memory_save with its id to change it; when the user asks you to forget something, call memory_forget with its id. Never save secrets, passwords or keys.';
    if (!notes.length) return `${head}\nNo notes are saved yet.`;
    return `${head}\n${notes.map((n) => `- [${n.id}] ${n.text}`).join('\n')}`;
}

module.exports = { list, add, update, remove, promptText, cleanText, LOCAL, KEY, MAX_NOTES, MAX_TEXT };
