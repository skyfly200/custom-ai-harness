// Monitoring for the control UI (/ui): a ring buffer of recent routing
// decisions and health checks for every part of the stack. In memory only;
// a restart of the Interceptor starts the history fresh. Every change is
// also emitted as an 'update' so pages can follow requests live.

const { EventEmitter } = require('events');

const MAX_EVENTS = 200;
const PROMPT_PREVIEW_CHARS = 160;

const events = [];
let nextId = 1;
const counters = { requests: 0, routerDown: 0, errors: 0, fallbacks: 0, rateLimited: 0, timeouts: 0 };
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
function recordRoute({ path, model, threshold, winRate, tools, tokens, prompt, routerError, reason, clientId, transforms, routeMs, profile, tier, effort, auto, asked }) {
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
        profile: profile || null, // the named routing it used (utils/profiles.js), null for the default
        tier: tier || null,       // the tier the score landed in: Strong, Weak, Images or an extra tier (utils/tiers.js)
        effort: effort || 0,      // how far x-harness-effort moved the score
        asked: asked || null,     // extra Jev questions (utils/jevQuestions.js): { answers, hits: [ids that reached their bar], error? }
        auto: auto || null,       // how Auto chose the routing: { how: 'rule' | 'jev' | 'default', why }
        routeMs: routeMs ?? null,
        status: null,
        ms: null,
        servedBy: null,
        fallbacks: null,
        error: null,
        errorKind: null, // 'rate limit', 'timeout', 'gateway down', 'error' or 'stopped' (utils/gatewayGuard.js)
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

// A failed request: the Gateway unreachable, a timeout, or (with `status`) the
// reason behind a 4xx/5xx answer, which recordResponse already counted.
function recordError(event, err, kind = null) {
    if (!event || event.error) return;
    event.ms ??= Date.now() - event.started;
    event.error = err?.message || String(err);
    event.errorKind = kind;
    if (event.status == null || event.status < 400) counters.errors++;
    if (kind === 'rate limit') counters.rateLimited++;
    if (kind === 'timeout') counters.timeouts++;
    emit('error', event);
}

// The client went away before the reply ended (the chat page's Stop button)
function recordCancel(event) {
    if (!event || event.error || event.doneMs != null) return;
    event.error = 'stopped by the client';
    event.errorKind = 'stopped';
    event.doneMs = Date.now() - event.started;
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

/**
 * Why the Router can't be edited, and what to do about it; null when it can.
 * `c` is the probe result for the Router.
 */
function routerProblem(c, platform = process.platform) {
    if (!c) return null;
    if (c.ok && c.detail?.settings) return null;
    const url = c.url ? c.url.replace(/\/health$/, '') : 'the Router address';
    if (c.ok) return `The Router at ${url} is an older version without admin endpoints. Update router.py (git pull) and restart it.`;
    if (c.status != null) return `Something answered at ${url}/health with HTTP ${c.status}, but it is not the Router. Another program may be using port 6060, or ROUTER_URL in .env points at the wrong service.`;
    const py = platform === 'win32' ? '.venv\\Scripts\\python router.py' : '.venv/bin/python router.py';
    const refused = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|UND_ERR/i.test(c.error || '');
    if (refused) {
        const localhost = /\/\/localhost[:/]/i.test(url) ? ` If it is running, \`localhost\` may mean ::1 here while the Router listens on 127.0.0.1: set ROUTER_URL=http://127.0.0.1:6060 in .env and restart the Interceptor.` : '';
        return `Nothing is listening at ${url} (${c.error}). The Router did not start or has stopped: look for the lines marked "router" in the window running npm run all, which show the Python error (often a missing package: see the README setup). To see it alone, run ${py}.${localhost}`;
    }
    if (/Timeout|Abort/i.test(c.error || '')) return `The Router at ${url} did not answer within 2 s. It may still be starting (a classifier model can take a minute to load); refresh in a moment.`;
    return `The Router at ${url} can't be reached (${c.error || 'no answer'}).`;
}

function checkComponents(urls) {
    return Promise.all([
        probe('Router', `${urls.router}/health`).then(r => ({ ...r, problem: routerProblem(r) })),
        probe('Gateway (LiteLLM)', `${urls.gateway}/health/liveliness`),
        probe('Local engine', `${urls.localEngine}/v1/models`, { optional: true }),
        probe('Ollama', `${urls.ollama}/api/tags`, { optional: true }),
        probe('Laya (local)', `${urls.laya}/health`, { optional: true }),
    ]);
}

module.exports = { live, recordRouting, recordRoute, recordResponse, recordFinish, recordError, recordCancel, recordUsage, recentEvents, stats, checkComponents, probe, routerProblem };
