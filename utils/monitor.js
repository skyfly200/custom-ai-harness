// Monitoring for the control UI (/ui): a ring buffer of recent routing
// decisions and health checks for every part of the stack. In memory only;
// a restart of the Interceptor starts the history fresh.

const MAX_EVENTS = 200;
const PROMPT_PREVIEW_CHARS = 160;

const events = [];
let nextId = 1;
const counters = { requests: 0, routerDown: 0, errors: 0, fallbacks: 0 };

/**
 * Record a routing decision. Returns the event so the response can be added
 * to it once the Gateway answers.
 */
function recordRoute({ path, model, threshold, winRate, tools, tokens, prompt, routerError, reason }) {
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
        status: null,
        ms: null,
        servedBy: null,
        fallbacks: null,
        error: null,
        started: Date.now(),
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    counters.requests++;
    if (routerError) counters.routerDown++;
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
}

function recordError(event, err) {
    if (!event) return;
    event.ms = Date.now() - event.started;
    event.error = err?.message || String(err);
    counters.errors++;
}

function recentEvents(limit = 50) {
    return events.slice(-limit).reverse().map(({ started, ...e }) => e);
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

module.exports = { recordRoute, recordResponse, recordError, recentEvents, stats, checkComponents, probe };
