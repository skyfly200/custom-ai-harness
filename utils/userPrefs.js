// A signed-in person's own routings and Interceptor overrides, kept in user_data (utils/chatSync.js has the
// same table for the chat page's data). Models, fallbacks and the Router stay global and admin-edited: a
// person's routing can only point at models the Gateway already serves. Admins' routings are the shared
// ones (routing-profiles.json); a person's own are added after them.
'use strict';

const db = require('./db');
const profiles = require('./profiles');

const ROUTINGS = 'routings';
const SETTINGS = 'settings';
const TTL_MS = 15000;
const MAX_ROUTINGS = 30;
// the Interceptor settings a person may change for their own requests; guard thresholds and timeouts stay global
const OWN_SETTINGS = ['caveman', 'headroom', 'contextAnchor'];

const cache = new Map(); // `${owner}\0${key}` -> { at, value }

async function read(owner, key) {
    const id = `${owner}\0${key}`;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const { rows } = await db.query('SELECT value FROM user_data WHERE owner = $1 AND key = $2', [owner, key]);
    const value = rows[0] ? rows[0].value : null;
    cache.set(id, { at: Date.now(), value });
    return value;
}

async function write(owner, key, value) {
    await db.query(
        `INSERT INTO user_data (owner, key, value, updated) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (owner, key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated`,
        [owner, key, JSON.stringify(value), Date.now()]);
    cache.set(`${owner}\0${key}`, { at: Date.now(), value });
}

/** Every model name a cleaned routing refers to, fallbacks included. */
function modelsOf(p) {
    const names = [p.pin, p.down, p.downTools, p.strong, p.strongTools, p.weak, p.tools, p.overflow, p.images];
    for (const t of p.tiers || []) names.push(t.model, t.tools);
    for (const [src, targets] of Object.entries(p.fallbacks || {})) names.push(src, ...targets);
    return names.filter(Boolean);
}

/** The person's own routings: { profiles, version }. */
async function ownRoutings(owner) {
    const saved = (await read(owner, ROUTINGS)) || {};
    const list = [];
    for (const p of saved.profiles || []) { try { list.push(profiles.clean(p)); } catch { /* a routing that no longer validates is skipped */ } }
    return { profiles: list, version: Number(saved.version) || 0 };
}

/**
 * Replace the person's routings. `shared` are the admin routings (their ids are taken); `allowed` is the
 * Gateway's model list; a routing that names another model is refused. `expected` guards two tabs.
 */
async function saveRoutings(owner, next, { expected, shared = [], allowed }) {
    const cur = await ownRoutings(owner);
    if (expected !== undefined && expected !== cur.version) throw Object.assign(new Error('Your routings changed since this page loaded. Reload it and try again.'), { status: 409 });
    if (!Array.isArray(next)) throw new Error('profiles must be a list');
    if (next.length > MAX_ROUTINGS) throw new Error(`at most ${MAX_ROUTINGS} routings each`);
    const cleaned = next.map(profiles.clean);
    const taken = new Set(shared.map((p) => p.id));
    const allow = allowed ? new Set(allowed) : null;
    const ids = new Set();
    for (const p of cleaned) {
        if (taken.has(p.id) || ids.has(p.id)) throw new Error(`“${p.name}” needs a different name: that one is taken`);
        ids.add(p.id);
        const bad = allow && modelsOf(p).find((m) => !allow.has(m));
        if (bad) throw new Error(`${p.name}: the Gateway has no model called “${bad}”`);
    }
    const version = cur.version + 1;
    await write(owner, ROUTINGS, { profiles: cleaned, version });
    return { profiles: cleaned, version };
}

async function ownSettings(owner) {
    const saved = (await read(owner, SETTINGS)) || {};
    return Object.fromEntries(OWN_SETTINGS.filter((k) => typeof saved[k] === 'boolean').map((k) => [k, saved[k]]));
}

async function saveSettings(owner, changes) {
    const cur = await ownSettings(owner);
    for (const [k, v] of Object.entries(changes || {})) {
        if (!OWN_SETTINGS.includes(k)) throw new Error(`${k} is a global setting: only admins change it`);
        if (v === null) delete cur[k];
        else if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
        else cur[k] = v;
    }
    await write(owner, SETTINGS, cur);
    return cur;
}

const forget = (owner) => { for (const k of [...cache.keys()]) if (k.startsWith(`${owner}\0`)) cache.delete(k); };

module.exports = { ownRoutings, saveRoutings, ownSettings, saveSettings, modelsOf, forget, OWN_SETTINGS };
