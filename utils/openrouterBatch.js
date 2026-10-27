// OpenRouter's Batch API: about half the price, no streaming, results within 24 h
// (usually minutes). One batch holds requests for one model and one endpoint, sent
// inline; the batch is polled until it ends and its results come back inline too,
// matched to requests by custom_id. This talks to OpenRouter directly because the
// Gateway's (LiteLLM) batch support covers only OpenAI's and Anthropic's own APIs.
// https://openrouter.ai/docs/guides/features/batch-api
//
// Only checked against a fake OpenRouter: the documented shapes are followed, but
// the result entry's exact nesting is read defensively.
'use strict';

const ENDPOINT = '/v1/chat/completions';
const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

/**
 * `key()` resolves the OpenRouter credential (a key, or a federated token).
 * Returns { submit, get, parse }.
 */
function createBatchClient({ key, base = process.env.OPENROUTER_BATCH_URL || 'https://openrouter.ai/api/v1', fetchImpl = fetch }) {
    const call = async (method, path, body) => {
        const token = await key();
        if (!token) throw new Error('no OpenRouter key: set OPENROUTER_API_KEY');
        const res = await fetchImpl(`${base.replace(/\/+$/, '')}${path}`, {
            method, signal: AbortSignal.timeout(30000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`OpenRouter batch answered ${res.status}: ${String(json.error?.message || json.message || '').slice(0, 200)}`);
        return json;
    };
    return {
        /** Start a batch of chat completions for one model. `requests`: [{ id, body }]. Resolves the batch id. */
        async submit(model, requests) {
            // the docs: put the top-level fields before `requests`, or the API answers 400
            const sent = await call('POST', '/batches', { endpoint: ENDPOINT, model, completion_window: '24h', requests: requests.map((r) => ({ custom_id: r.id, body: { ...r.body, model } })) });
            if (!sent.id) throw new Error('OpenRouter batch answered with no id');
            return sent.id;
        },
        /** { status, done, error, results: { id: { text, usage } | { error } } } */
        async get(id) {
            const b = await call('GET', `/batches/${encodeURIComponent(id)}`);
            const done = TERMINAL.has(b.status);
            const results = {};
            for (const r of b.results || []) results[r.custom_id] = parse(r);
            return { status: b.status, done, error: b.error?.message || null, results };
        },
    };
}

/** One result entry: { text, usage } or { error }. */
function parse(entry) {
    if (entry.error) return { error: String(entry.error.message || entry.error).slice(0, 300) };
    const r = entry.response || {};
    const body = r.body || r;
    if (r.status_code >= 400) return { error: String(body.error?.message || `HTTP ${r.status_code}`).slice(0, 300) };
    const text = body.choices?.[0]?.message?.content;
    return typeof text === 'string' ? { text, usage: body.usage || null } : { error: 'the batch result had no message' };
}

module.exports = { createBatchClient, parse, ENDPOINT, TERMINAL };
