// Token usage for the Usage page (/ui/usage.html): real token counts read from
// the Gateway's replies, totalled per day by person, client, model and provider.
// With a database (DATABASE_URL) the totals live in the usage_daily table
// (utils/usageDb.js); without one they are saved to harness-usage.json
// (gitignored). Either way they survive a restart; the page's "Clear" button
// or deleting the file starts them fresh.
//
// A row's `user` is the signed-in person's name. '' is usage from before
// per-user tracking and any request that had no signed-in person (the whole
// install, when logins are off).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
// The same reading of a provider's usage the chat page does (ui/tokens.js), so
// a number shown in a chat and one counted here never disagree
const Tokens = require('../ui/tokens');

const FILE = process.env.HARNESS_USAGE_FILE || path.join(__dirname, '..', 'harness-usage.json');
const CONFIG_FILE = process.env.HARNESS_GATEWAY_CONFIG || path.join(__dirname, '..', 'config.yaml');
const MAX_BODY_CHARS = 20 * 1024 * 1024; // non-streamed replies bigger than this go unparsed
const SAVE_DELAY_MS = 2000;

// rows: one per day + user + client + route + model + servedBy + provider
let data = { since: null, rows: {} };
let saveTimer = null;
// with a database: the table's access, the counts added since the last write (by row key), and the load of its totals
let store = null;
let pending = new Map();
let loaded = null;

const COUNTS = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'estimated', 'savedAnchor', 'savedHeadroom'];
const rowKey = (r) => [r.day, String(r.user || '').toLowerCase(), r.client, r.route, r.model, r.servedBy, r.provider].join('|');
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// Adds a row's counts to data.rows under its key (rows saved before per-user tracking have no user)
function fold(r) {
    const key = rowKey(r);
    const t = data.rows[key] || (data.rows[key] = { day: r.day, user: r.user || '', client: r.client, route: r.route, model: r.model, servedBy: r.servedBy, provider: r.provider, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0 });
    addCounts(t, r);
}

function addCounts(t, r) {
    for (const k of COUNTS) if (r[k]) t[k] = (t[k] || 0) + r[k];
    if (r.upstream) t.upstream = r.upstream;
    if (r.last && (!t.last || r.last > t.last)) t.last = r.last;
}

function load() {
    try {
        const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (saved && typeof saved.rows === 'object') {
            data = { since: saved.since || null, rows: {} };
            for (const r of Object.values(saved.rows)) fold(r);
        }
    } catch {
        data = { since: null, rows: {} };
    }
}

function saveFile() {
    try {
        fs.writeFileSync(FILE, JSON.stringify(data));
    } catch (err) {
        console.warn(`Could not save token usage to ${FILE}: ${err.message}`);
    }
}

function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (store) flush(); else saveFile();
}

// Many requests in a burst write once
function scheduleSave() {
    if (!saveTimer) {
        saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
        saveTimer.unref?.();
    }
}

/** Write what the database hasn't got yet. A failure keeps the counts for the next try. Never rejects. */
async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!store) return;
    await loaded?.catch(() => {}); // the table's own counts are loaded first, so none is counted twice
    if (!store || !pending.size) return;
    const batch = [...pending.values()];
    pending = new Map();
    try {
        await store.add(batch);
    } catch (err) {
        console.warn(`Could not save token usage to the database: ${err.message}`);
        for (const r of batch) {
            const key = rowKey(r);
            if (pending.has(key)) addCounts(pending.get(key), r); else pending.set(key, r);
        }
        scheduleSave();
    }
}

/**
 * Keep the totals in the database `dbStore` (utils/usageDb.js: loadAll, add, clear) from now on; call it at
 * start, before requests arrive. What the table holds is added to the counts made while it loads. The first
 * time (an empty table), totals from harness-usage.json are moved in, as usage with no person. If the table
 * can't be read, the file stays the store. Resolves once the totals are loaded.
 */
async function useDatabase(dbStore) {
    const fileRows = Object.values(data.rows);
    const fileSince = data.since;
    data = { since: null, rows: {} };
    pending = new Map();
    store = dbStore;
    loaded = (async () => {
        try {
            const stored = await dbStore.loadAll();
            for (const r of stored) fold(r);
            if (!stored.length && fileRows.length) {
                for (const r of fileRows) fold(r);
                await dbStore.add(fileRows);
                data.since = fileSince;
                try { fs.writeFileSync(FILE, JSON.stringify({ since: null, rows: {} })); } catch { /* the file was only the first-run source */ }
            }
            data.since = data.since || Object.values(data.rows).map((r) => r.day).sort()[0] || null;
        } catch (err) {
            // back to the file, with what was counted meanwhile
            store = null;
            const fresh = Object.values(data.rows);
            data = { since: fileSince, rows: {} };
            for (const r of [...fileRows, ...fresh]) fold(r);
            pending = new Map();
            scheduleSave();
            throw err;
        }
    })();
    await loaded;
}

// ---- providers -------------------------------------------------------------

// Who actually serves a Gateway model, from its litellm_params in config.yaml
function providerFor({ model = '', api_base: apiBase = '' }) {
    if (/:11434\b/.test(apiBase)) return 'Ollama';
    if (/:8000\b/.test(apiBase)) return 'Local engine';
    if (/:8001\b/.test(apiBase)) return 'Laya (local)';
    if (/localhost|127\.0\.0\.1/.test(apiBase)) return `Local (${apiBase.replace(/^https?:\/\//, '')})`;
    const prefix = model.split('/')[0].toLowerCase();
    const names = { groq: 'Groq', openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google', vertex_ai: 'Google', mistral: 'Mistral', ollama: 'Ollama', ollama_chat: 'Ollama', deepseek: 'DeepSeek', together_ai: 'Together', bedrock: 'AWS Bedrock', azure: 'Azure' };
    return names[prefix] || (prefix && model.includes('/') ? prefix : 'Unknown');
}

// model_name -> provider, read from config.yaml without a YAML library: only
// the model_list entries' model_name, model and api_base lines matter.
let providers = null;
function parseProviders(text) {
    const map = {};
    let current = null;
    const finish = () => { if (current?.model_name) map[current.model_name] = providerFor(current); };
    for (const line of text.split(/\r?\n/)) {
        const entry = line.match(/^\s*-\s*model_name:\s*["']?([^"'\s#]+)/);
        if (entry) { finish(); current = { model_name: entry[1] }; continue; }
        if (/^\S/.test(line)) { finish(); current = null; continue; } // next top-level section
        const field = current && line.match(/^\s+(model|api_base):\s*["']?([^"'\s#]+)/);
        if (field) current[field[1]] = field[2];
    }
    finish();
    return map;
}

function providerOf(model) {
    if (!providers) {
        try { providers = parseProviders(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { providers = {}; }
    }
    if (!model) return 'Unknown';
    return providers[model] || providerFor({ model });
}

// ---- reading usage out of a reply ------------------------------------------

// OpenAI and Anthropic usage objects to one shape. Anthropic counts cached
// input separately from input_tokens; input here is all of it.
function normalize(u) {
    const k = Tokens.usage(u);
    if (!k) return null;
    return { input: k.input, output: k.output, cacheRead: k.cacheRead, cacheWrite: k.cacheWrite };
}

// Streams report usage in pieces (Anthropic: input at message_start, output
// at message_delta), and counts only ever grow, so keep the largest of each.
function merge(a, b) {
    if (!b) return a;
    if (!a) return b;
    return {
        input: Math.max(a.input, b.input),
        output: Math.max(a.output, b.output),
        cacheRead: Math.max(a.cacheRead, b.cacheRead),
        cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    };
}

// Characters of generated text and tool arguments, for an estimate when the
// reply carries no usage (an OpenAI stream without include_usage)
function outputChars(obj) {
    return Tokens.charsOf(obj);
}

const MAX_TEXT_CHARS = 200000;

// The words of the reply, from either format, streamed or whole
function textOf(obj) {
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') return String(obj.delta.text || '');
    const choice = obj.choices?.[0];
    if (choice) {
        if (typeof choice.delta?.content === 'string') return choice.delta.content;
        if (typeof choice.message?.content === 'string') return choice.message.content;
    }
    if (obj.type === 'message' && Array.isArray(obj.content)) return obj.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('');
    return '';
}

function inspect(obj, state) {
    if (!obj || typeof obj !== 'object') return;
    if (state.text.length < MAX_TEXT_CHARS) state.text += textOf(obj);
    state.usage = merge(state.usage, normalize(obj.usage));
    if (obj.type === 'message_start') state.usage = merge(state.usage, normalize(obj.message?.usage));
    state.model = state.model || obj.model || obj.message?.model || null;
    state.chars += outputChars(obj);
}

/**
 * Follow a Gateway reply as it streams to the client, without touching it,
 * and call done({ usage, model, outputChars, text, aborted }) when it ends (text: what it said; aborted: it was cut off). Handles JSON and
 * Server-Sent Events, compressed or not. usage is null if the reply had none.
 */
function tap(res, done) {
    const type = String(res.headers['content-type'] || '');
    const sse = type.includes('text/event-stream');
    const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
    const decoder = encoding === 'gzip' ? zlib.createGunzip()
        : encoding === 'br' ? zlib.createBrotliDecompress()
        : encoding === 'deflate' ? zlib.createInflate()
        : null;
    const text = new StringDecoder('utf8');
    const state = { usage: null, model: null, chars: 0, text: '', aborted: false };
    let buffer = '';
    let finished = false;

    const lines = (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('data:')) {
                const payload = line.slice(5).trim();
                if (payload && payload !== '[DONE]') { try { inspect(JSON.parse(payload), state); } catch {} }
            }
        }
    };
    const onText = (chunk) => {
        const s = text.write(chunk);
        if (sse) lines(s);
        else if (buffer.length < MAX_BODY_CHARS) buffer += s;
    };
    const finish = () => {
        if (finished) return;
        finished = true;
        const rest = text.end();
        if (sse) lines(rest + '\n');
        else {
            buffer += rest;
            if (/json/.test(type) || /^\s*\{/.test(buffer)) { try { inspect(JSON.parse(buffer), state); } catch {} }
        }
        done({ usage: state.usage, model: state.model, outputChars: state.chars, text: state.text, aborted: state.aborted });
    };

    if (decoder) {
        decoder.on('data', onText);
        decoder.on('end', finish);
        decoder.on('error', finish);
        res.on('data', (c) => { if (!finished) decoder.write(c); });
        res.on('end', () => decoder.end());
    } else {
        res.on('data', onText);
        res.on('end', finish);
    }
    res.on('error', () => { state.aborted = true; finish(); });
    res.on('aborted', () => { state.aborted = true; finish(); });
}

// ---- totals ----------------------------------------------------------------

/**
 * Which kind of client sent a request, from the route and its headers.
 */
function clientOf(req) {
    const agent = String(req.get?.('user-agent') || req.headers?.['user-agent'] || '');
    const id = req.get?.('x-harness-request-id') || req.headers?.['x-harness-request-id'];
    if (/^run-/.test(String(id || ''))) return 'Agent run';
    if (id) return 'Chat page';
    if (/claude-cli|claude-code/i.test(agent)) return 'Claude Code';
    if (/cursor/i.test(agent)) return 'Cursor';
    if (/aider/i.test(agent)) return 'Aider';
    if (/continue/i.test(agent)) return 'Continue';
    return (req.path || req.url || '').includes('/messages') ? 'Anthropic API client' : 'OpenAI API client';
}

// How the model was chosen, from a monitor event
function routeOf(event) {
    if (event.routerError) return 'Router down';
    if (event.reason === 'pinned in settings' || /^pinned in (routing|strategy)/.test(event.reason || '')) return 'Pinned';
    if (event.reason === 'chosen by the client') return 'Chosen by client';
    return 'Router';
}

/**
 * Add one finished request. `usage` null means the reply had no counts: then
 * input comes from the request size and output from the reply text (about 4
 * characters a token), and the row is marked estimated.
 */
function record({ time = new Date(), user, client, route, model, servedBy, upstream, usage, estimate, saved }) {
    const counts = usage || {
        input: estimate?.input ?? 0,
        output: Math.ceil((estimate?.outputChars ?? 0) / 4),
        cacheRead: 0,
        cacheWrite: 0,
    };
    const served = servedBy || model || 'unknown';
    const row = {
        day: new Date(time).toISOString().slice(0, 10),
        user: user ? String(user) : '',
        client: client || 'Unknown',
        route: route || 'Router',
        model: model || 'unknown',
        servedBy: served,
        provider: providerOf(served),
    };
    // what this request adds. upstream is the provider's own name for the model (from the reply), for pricing models
    // the Gateway doesn't list; savedAnchor/savedHeadroom are input tokens the Interceptor's compression took out
    const add = {
        ...row, last: new Date(time).toISOString(), requests: 1,
        input: counts.input, output: counts.output, cacheRead: counts.cacheRead, cacheWrite: counts.cacheWrite,
        estimated: usage ? 0 : 1, savedAnchor: saved?.anchor || 0, savedHeadroom: saved?.headroom || 0,
        ...(typeof upstream === 'string' && upstream ? { upstream: upstream.slice(0, 200) } : {}),
    };
    fold(add);
    if (store) {
        const key = rowKey(add);
        if (pending.has(key)) addCounts(pending.get(key), add); else pending.set(key, { ...add });
    }
    if (!data.since) data.since = new Date(time).toISOString();
    scheduleSave();
    return { ...row, ...counts, estimated: !usage };
}

const blankRow = (extra) => ({ ...extra, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, savedAnchor: 0, savedHeadroom: 0 });
const firstDay = (days) => (days > 0 ? new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10) : '');

/**
 * Totals over the last `days` days (0 or missing for all time), one row per
 * client + route + model + servedBy + provider, plus `daily`: one row per
 * day + route + model + servedBy + provider, for charts, costs and savings per day.
 * `user` limits it to one person's requests ('' is the usage with no person);
 * leave it out for everyone's together.
 */
function summary(days = 0, { user } = {}) {
    const from = firstDay(days);
    const rows = {};
    const daily = {};
    for (const r of Object.values(data.rows)) {
        if (r.day < from) continue;
        if (user !== undefined && !same(r.user, user)) continue;
        const key = [r.client, r.route, r.model, r.servedBy, r.provider].join('|');
        const t = rows[key] || (rows[key] = blankRow({ client: r.client, route: r.route, model: r.model, servedBy: r.servedBy, provider: r.provider }));
        const dayKey = [r.day, r.route, r.model, r.servedBy, r.provider].join('|');
        const d = daily[dayKey] || (daily[dayKey] = blankRow({ day: r.day, route: r.route, model: r.model, servedBy: r.servedBy, provider: r.provider }));
        for (const k of COUNTS) { t[k] += r[k] || 0; d[k] += r[k] || 0; }
        if (r.upstream) t.upstream = r.upstream;
    }
    return {
        since: data.since,
        days: days > 0 ? days : null,
        rows: Object.values(rows),
        daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    };
}

/**
 * Everyone's usage over the last `days` days (0: all time), for the admin view: `users` (one per person, with
 * when they were last active), `rows` (person + client + route + model + servedBy + provider) and `daily`
 * (person + day + client + model + servedBy + provider), each with the counts. The page prices them.
 */
function byUser(days = 0) {
    const from = firstDay(days);
    const people = {};
    const rows = {};
    const daily = {};
    for (const r of Object.values(data.rows)) {
        if (r.day < from) continue;
        const who = String(r.user || '').toLowerCase();
        const p = people[who] || (people[who] = blankRow({ user: r.user || '', last: null }));
        const key = [who, r.client, r.route, r.model, r.servedBy, r.provider].join('|');
        const t = rows[key] || (rows[key] = blankRow({ user: r.user || '', client: r.client, route: r.route, model: r.model, servedBy: r.servedBy, provider: r.provider }));
        const dayKey = [who, r.day, r.client, r.model, r.servedBy, r.provider].join('|');
        const d = daily[dayKey] || (daily[dayKey] = blankRow({ user: r.user || '', day: r.day, client: r.client, model: r.model, servedBy: r.servedBy, provider: r.provider }));
        for (const k of COUNTS) { p[k] += r[k] || 0; t[k] += r[k] || 0; d[k] += r[k] || 0; }
        if (r.upstream) t.upstream = r.upstream;
        const at = r.last || `${r.day}T00:00:00.000Z`;
        if (!p.last || at > p.last) p.last = at;
    }
    return {
        since: data.since,
        days: days > 0 ? days : null,
        users: Object.values(people),
        rows: Object.values(rows),
        daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    };
}

async function clear() {
    data = { since: null, rows: {} };
    pending = new Map();
    clearTimeout(saveTimer);
    saveTimer = null;
    saveFile(); // the file is emptied in database mode too, so an old one is never moved in again
    if (store) await store.clear();
}

load();
process.on('exit', () => { if (saveTimer && !store) saveNow(); });

module.exports = { tap, record, summary, byUser, clear, load, flush, useDatabase, normalize, clientOf, routeOf, providerOf, parseProviders, FILE };
