// Monitoring for the control UI (/ui): a ring buffer of recent routing
// decisions and health checks for every part of the stack. In memory only;
// a restart of the Interceptor starts the history fresh. Every change is
// also emitted as an 'update' so pages can follow requests live.

const { EventEmitter } = require('events');

const MAX_EVENTS = 200;
const PROMPT_PREVIEW_CHARS = 160;

const events = [];
let nextId = 1;
const counters = { requests: 0, routerDown: 0, errors: 0, fallbacks: 0 };
const live = new EventEmitter();
live.setMaxListeners(0); // one listener per open page

const publicEvent = ({ started, ...e }) => e;
function emit(type, event) {
    live.emit('update', { type, event: publicEvent(event) });
}

// A request arrived and is waiting on the Router. Not stored, only announced.
function recordRouting({ path, clientId, prompt }) {
    live.emit('update', { type: 'routing', event: { path, clientId: clientId || null, prompt: (prompt || '').slice(0, PROMPT_PREVIEW_CHARS), time: new Date().toISOString() } });
}

/**
 * Record a routing decision. Returns the event so the response can be added
 * to it once the Gateway answers.
 */
function recordRoute({ path, model, threshold, winRate, tools, tokens, prompt, routerError, reason, clientId, transforms, routeMs }) {
    const event = {
        id: nextId++,
        time: new Date().toISOString(),
        path,
        model,
        threshold,
        winRate,
        tools: !!tools,
        tokens,
        prompt: (prompt || '').slice(0, PROMPT_PREVIEW_CHARS),
        routerError: routerError || null,
        reason: reason || null,  // set when the Router was skipped (model pinned or chosen by the client)
        clientId: clientId || null, // x-harness-request-id, so a page can find its own request
        transforms: transforms || [],
        routeMs: routeMs ?? null,
        status: null,
        ms: null,
        servedBy: null,
        fallbacks: null,
        error: null,
        usage: null,   // { input, output, cacheRead, provider, estimated } once the reply ends
        doneMs: null,  // when the last byte of the reply left the Gateway (streams end after `ms`)
        started: Date.now(),
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    counters.requests++;
    if (routerError) counters.routerDown++;
    emit('route', event);
    return event;
}

/**
 * The Gateway's response headers. LiteLLM reports fallbacks it tried in
 * x-litellm-attempted-fallbacks and the deployment that answered in
 * x-litellm-model-group; either may be missing on older versions.
 */
function recordResponse(event, status, headers = {}) {
    if (!event) return;
    event.status = status;
    event.ms = Date.now() - event.started;
    event.servedBy = headers['x-litellm-model-group'] || null;
    const fallbacks = parseInt(headers['x-litellm-attempted-fallbacks'], 10);
    event.fallbacks = Number.isFinite(fallbacks) ? fallbacks : null;
    if (event.fallbacks > 0) counters.fallbacks++;
    if (status >= 400) counters.errors++;
    emit('response', event);
}

function recordFinish(event) {
    if (!event) return;
    event.doneMs = Date.now() - event.started;
    emit('finish', event);
}

function recordError(event, err) {
    if (!event) return;
    event.ms = Date.now() - event.started;
    event.error = err?.message || String(err);
    counters.errors++;
    emit('error', event);
}

// Real token counts once the reply has ended (utils/usage.js reads them)
function recordUsage(event, row) {
    if (!event || !row) return;
    event.usage = { input: row.input, output: row.output, cacheRead: row.cacheRead, provider: row.provider, estimated: !!row.estimated };
    emit('usage', event);
}

function recentEvents(limit = 50) {
    return events.slice(-limit).reverse().map(publicEvent);
}

const startedAt = new Date().toISOString();
function stats() {
    return { ...counters, since: startedAt };
}

/**
 * GET a URL and report whether it answered. Never throws.
 * `optional` parts (local engine, Ollama, local Laya) show as "off" instead of "down".
 */
async function probe(name, url, { optional = false, timeout = 2000 } = {}) {
    const started = Date.now();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        let detail = null;
        try { detail = await res.json(); } catch {}
        return { name, url, ok: res.ok, optional, status: res.status, ms: Date.now() - started, detail };
    } catch (err) {
        return { name, url, ok: false, optional, status: null, ms: Date.now() - started, error: err.cause?.code || err.message };
    }
}

function checkComponents(urls) {
    return Promise.all([
        probe('Router', `${urls.router}/health`),
        probe('Gateway (LiteLLM)', `${urls.gateway}/health/liveliness`),
        probe('Local engine', `${urls.localEngine}/v1/models`, { optional: true }),
        probe('Ollama', `${urls.ollama}/api/tags`, { optional: true }),
        probe('Laya (local)', `${urls.laya}/health`, { optional: true }),
    ]);
}

module.exports = { live, recordRouting, recordRoute, recordResponse, recordFinish, recordError, recordUsage, recentEvents, stats, checkComponents, probe };
