// The serverless harness: one Web-standard handler (Request in, Response out) that
// sends OpenAI-format chat requests straight to OpenRouter. No LiteLLM, no Router,
// no database. Netlify and Vercel adapters live in netlify/ and api/ and only call handle().
//
// Routes (also served under /api/ when a Vercel rewrite adds that prefix):
//   POST /v1/chat/completions   OpenAI chat format, streamed through unchanged
//   GET  /v1/models             the models this deployment will send to
//   GET  /healthz               liveness, no secrets
//
// Access: every /v1 call needs SERVERLESS_API_KEY (Bearer or x-api-key). Without it the
// deployment refuses to serve, so an unset key never leaves an open paid proxy.
// Request transforms (caveman, context anchor, Headroom) match the Interceptor: serverless/transforms.mjs.
// See docs/serverless.md for the design and the limits.

import { readTransforms, applyTransforms } from './transforms.mjs';

export const DEFAULT_STRONG = 'anthropic/claude-sonnet-5.5';
export const DEFAULT_WEAK = 'anthropic/claude-haiku-5.5';

const csv = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Reads the deployment's settings from environment variables (process.env on both hosts). */
export function readConfig(env = {}) {
    const strong = env.HARNESS_STRONG_MODEL || DEFAULT_STRONG;
    const weak = env.HARNESS_WEAK_MODEL || DEFAULT_WEAK;
    const models = [...new Set([strong, weak, ...csv(env.HARNESS_MODELS)])];
    return {
        apiKey: env.OPENROUTER_API_KEY || '',
        accessKey: env.SERVERLESS_API_KEY || '',
        base: String(env.OPENROUTER_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
        strong,
        weak,
        models,
        // A request longer than this (characters of message text) goes to the strong model.
        strongChars: num(env.HARNESS_STRONG_CHARS, 8000),
        // How long OpenRouter may take to start answering. Streams are not cut after that.
        timeoutMs: num(env.HARNESS_TIMEOUT_MS, 25000),
        maxBytes: num(env.HARNESS_MAX_BYTES, 1000000),
        referer: env.HARNESS_SITE_URL || '',
        title: env.HARNESS_SITE_NAME || 'Custom AI Harness',
    };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export function errorResponse(status, message, type = 'invalid_request_error') {
    return new Response(JSON.stringify({ error: { message, type, code: status } }), { status, headers: JSON_HEADERS });
}

/** Compares two strings without stopping at the first difference. */
export function safeEqual(a, b) {
    const x = String(a);
    const y = String(b);
    let diff = x.length ^ y.length;
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0;
}

export function isAuthorized(request, cfg) {
    if (!cfg.accessKey) return false;
    const auth = request.headers.get('authorization') || '';
    const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
    const key = bearer || request.headers.get('x-api-key') || '';
    return safeEqual(key, cfg.accessKey);
}

/** Characters of text in a chat request's messages (string content or text parts). */
export function messageChars(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const m of messages) {
        const c = m && m.content;
        if (typeof c === 'string') total += c.length;
        else if (Array.isArray(c)) for (const part of c) if (part && typeof part.text === 'string') total += part.text.length;
    }
    return total;
}

/**
 * Picks the model for one request. Order: x-harness-model header (must be in the
 * allowed list, else 400), a body.model that is in the list, x-harness-tier
 * ("strong" or "weak"), then the rules: tools or a long conversation go strong,
 * everything else weak. This is a plain heuristic, not the Jev classifier.
 */
export function pickModel(body, headers, cfg) {
    const pinned = headers.get('x-harness-model');
    if (pinned) {
        if (!cfg.models.includes(pinned)) return { error: `model "${pinned}" is not in HARNESS_MODELS` };
        return { model: pinned, route: 'pinned' };
    }
    if (typeof body.model === 'string' && cfg.models.includes(body.model)) {
        return { model: body.model, route: 'requested' };
    }
    const tier = (headers.get('x-harness-tier') || '').toLowerCase();
    if (tier === 'strong') return { model: cfg.strong, route: 'tier' };
    if (tier === 'weak') return { model: cfg.weak, route: 'tier' };
    if (Array.isArray(body.tools) && body.tools.length) return { model: cfg.strong, route: 'tools' };
    if (messageChars(body.messages) > cfg.strongChars) return { model: cfg.strong, route: 'long' };
    return { model: cfg.weak, route: 'short' };
}

async function readJson(request, maxBytes) {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > maxBytes) return { error: errorResponse(413, `request body is larger than ${maxBytes} bytes`) };
    const text = await request.text();
    if (text.length > maxBytes) return { error: errorResponse(413, `request body is larger than ${maxBytes} bytes`) };
    try {
        const body = JSON.parse(text || 'null');
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: errorResponse(400, 'body must be a JSON object') };
        return { body };
    } catch {
        return { error: errorResponse(400, 'body is not valid JSON') };
    }
}

async function chatCompletions(request, cfg, fetchImpl, env, headroomClient) {
    const parsed = await readJson(request, cfg.maxBytes);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    if (!Array.isArray(body.messages) || !body.messages.length) return errorResponse(400, 'messages must be a non-empty array');

    const picked = pickModel(body, request.headers, cfg);
    if (picked.error) return errorResponse(400, picked.error);

    const transformed = await applyTransforms({ ...body, model: picked.model }, readTransforms(env), { headroomClient });

    const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'x-title': cfg.title,
    };
    if (cfg.referer) headers['http-referer'] = cfg.referer;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let upstream;
    try {
        upstream = await fetchImpl(`${cfg.base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(transformed.body),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) return errorResponse(504, `OpenRouter did not answer within ${cfg.timeoutMs} ms`, 'timeout');
        return errorResponse(502, `OpenRouter could not be reached: ${err && err.message ? err.message : err}`, 'upstream_error');
    }
    clearTimeout(timer);

    const out = {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
        'x-harness-model': picked.model,
        'x-harness-route': picked.route,
        'x-harness-transforms': encodeURIComponent(transformed.applied.join(', ') || 'none'),
    };
    return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** The path a request is for, with a Vercel-style /api prefix removed. */
export function routeOf(request) {
    let path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/api' || path.startsWith('/api/')) path = path.slice(4) || '/';
    return path;
}

/**
 * The whole serverless harness. `env` is the host's environment (process.env);
 * `fetchImpl` is injectable for tests.
 */
export async function handle(request, env = {}, { fetchImpl = fetch, headroomClient } = {}) {
    const cfg = readConfig(env);
    const path = routeOf(request);

    if (path === '/healthz' || path === '/v1/healthz') return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

    if (!path.startsWith('/v1/')) return errorResponse(404, `no route for ${path}`, 'not_found');

    if (!cfg.accessKey || !cfg.apiKey) {
        return errorResponse(503, 'this deployment is not configured: set SERVERLESS_API_KEY and OPENROUTER_API_KEY', 'not_configured');
    }
    if (!isAuthorized(request, cfg)) return errorResponse(401, 'missing or wrong API key', 'authentication_error');

    if (path === '/v1/models' && request.method === 'GET') {
        const data = cfg.models.map((id) => ({ id, object: 'model', owned_by: 'openrouter' }));
        return new Response(JSON.stringify({ object: 'list', data }), { headers: JSON_HEADERS });
    }
    if (path === '/v1/chat/completions') {
        if (request.method !== 'POST') return errorResponse(405, 'use POST', 'invalid_request_error');
        return chatCompletions(request, cfg, fetchImpl, env, headroomClient);
    }
    return errorResponse(404, `no route for ${request.method} ${path}`, 'not_found');
}
