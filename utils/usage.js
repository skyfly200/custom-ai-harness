// Token usage for the Usage page (/ui/usage.html): real token counts read from
// the Gateway's replies, totalled per day by client, model and provider.
// Saved to harness-usage.json (gitignored) so totals survive a restart; the
// page's "Clear" button or deleting the file starts them fresh.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

const FILE = process.env.HARNESS_USAGE_FILE || path.join(__dirname, '..', 'harness-usage.json');
const CONFIG_FILE = process.env.HARNESS_GATEWAY_CONFIG || path.join(__dirname, '..', 'config.yaml');
const MAX_BODY_CHARS = 20 * 1024 * 1024; // non-streamed replies bigger than this go unparsed
const SAVE_DELAY_MS = 2000;

// rows: one per day + client + route + model + servedBy + provider
let data = { since: null, rows: {} };
let saveTimer = null;

function load() {
    try {
        const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (saved && typeof saved.rows === 'object') data = { since: saved.since || null, rows: saved.rows };
    } catch {
        data = { since: null, rows: {} };
    }
}

function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
        fs.writeFileSync(FILE, JSON.stringify(data));
    } catch (err) {
        console.warn(`Could not save token usage to ${FILE}: ${err.message}`);
    }
}

// Many requests in a burst write the file once
function scheduleSave() {
    if (!saveTimer) {
        saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
        saveTimer.unref?.();
    }
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
    if (!u || typeof u !== 'object') return null;
    const cacheRead = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const input = u.prompt_tokens ?? ((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + cacheWrite);
    const output = u.completion_tokens ?? u.output_tokens ?? 0;
    if (!input && !output) return null;
    return { input, output, cacheRead, cacheWrite };
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
    let n = 0;
    for (const choice of obj.choices || []) {
        const m = choice.delta || choice.message || {};
        if (typeof m.content === 'string') n += m.content.length;
        if (typeof m.reasoning_content === 'string') n += m.reasoning_content.length;
        for (const call of m.tool_calls || []) n += (call.function?.arguments || '').length;
    }
    const d = obj.delta; // Anthropic content_block_delta
    if (d) n += (d.text || d.partial_json || d.thinking || '').length;
    for (const block of Array.isArray(obj.content) ? obj.content : []) {
        n += (block.text || '').length + (block.input ? JSON.stringify(block.input).length : 0);
    }
    return n;
}

function inspect(obj, state) {
    if (!obj || typeof obj !== 'object') return;
    state.usage = merge(state.usage, normalize(obj.usage));
    if (obj.type === 'message_start') state.usage = merge(state.usage, normalize(obj.message?.usage));
    state.model = state.model || obj.model || obj.message?.model || null;
    state.chars += outputChars(obj);
}

/**
 * Follow a Gateway reply as it streams to the client, without touching it,
 * and call done({ usage, model, outputChars }) when it ends. Handles JSON and
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
    const state = { usage: null, model: null, chars: 0 };
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
        done({ usage: state.usage, model: state.model, outputChars: state.chars });
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
    res.on('error', finish);
    res.on('aborted', finish);
}

// ---- totals ----------------------------------------------------------------

/**
 * Which kind of client sent a request, from the route and its headers.
 */
function clientOf(req) {
    const agent = String(req.get?.('user-agent') || req.headers?.['user-agent'] || '');
    const id = req.get?.('x-harness-request-id') || req.headers?.['x-harness-request-id'];
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
function record({ time = new Date(), client, route, model, servedBy, upstream, usage, estimate, saved }) {
    const counts = usage || {
        input: estimate?.input ?? 0,
        output: Math.ceil((estimate?.outputChars ?? 0) / 4),
        cacheRead: 0,
        cacheWrite: 0,
    };
    const served = servedBy || model || 'unknown';
    const row = {
        day: new Date(time).toISOString().slice(0, 10),
        client: client || 'Unknown',
        route: route || 'Router',
        model: model || 'unknown',
        servedBy: served,
        provider: providerOf(served),
    };
    const key = [row.day, row.client, row.route, row.model, row.servedBy, row.provider].join('|');
    const t = data.rows[key] || (data.rows[key] = { ...row, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0 });
    t.requests++;
    // the provider's own name for the model (from the reply), for pricing models the Gateway doesn't list
    if (typeof upstream === 'string' && upstream) t.upstream = upstream.slice(0, 200);
    // Input tokens the Interceptor's compression took out before sending
    if (saved?.anchor) t.savedAnchor = (t.savedAnchor || 0) + saved.anchor;
    if (saved?.headroom) t.savedHeadroom = (t.savedHeadroom || 0) + saved.headroom;
    t.input += counts.input;
    t.output += counts.output;
    t.cacheRead += counts.cacheRead;
    t.cacheWrite += counts.cacheWrite;
    if (!usage) t.estimated++;
    if (!data.since) data.since = new Date(time).toISOString();
    scheduleSave();
    return { ...row, ...counts, estimated: !usage };
}

const COUNTS = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'estimated', 'savedAnchor', 'savedHeadroom'];

/**
 * Totals over the last `days` days (0 or missing for all time), one row per
 * client + route + model + servedBy + provider, plus `daily`: one row per
 * day + route + model + servedBy + provider, for charts, costs and savings per day.
 */
function summary(days = 0) {
    const from = days > 0 ? new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10) : '';
    const rows = {};
    const daily = {};
    for (const r of Object.values(data.rows)) {
        if (r.day < from) continue;
        const key = [r.client, r.route, r.model, r.servedBy, r.provider].join('|');
        const t = rows[key] || (rows[key] = { client: r.client, route: r.route, model: r.model, servedBy: r.servedBy, provider: r.provider, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, savedAnchor: 0, savedHeadroom: 0 });
        const dayKey = [r.day, r.route, r.model, r.servedBy, r.provider].join('|');
        const d = daily[dayKey] || (daily[dayKey] = { day: r.day, route: r.route, model: r.model, servedBy: r.servedBy, provider: r.provider, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, savedAnchor: 0, savedHeadroom: 0 });
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

function clear() {
    data = { since: null, rows: {} };
    saveNow();
}

load();
process.on('exit', () => { if (saveTimer) saveNow(); });

module.exports = { tap, record, summary, clear, load, normalize, clientOf, routeOf, providerOf, parseProviders, FILE };
