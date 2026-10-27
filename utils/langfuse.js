// Optional Langfuse logging. The Gateway (LiteLLM) sends each call to Langfuse
// when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are in .env
// (docker/gateway-start.py or scripts/start-all.js turn the callbacks on).
// This file is the Interceptor's side: what it adds to each request so Langfuse
// groups calls by chat or run, and the status the Settings page shows.
// Nothing here sends anything to Langfuse except the status check, and that
// only when keys are set.

const DEFAULT_HOST = 'https://cloud.langfuse.com';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

function configured(env = process.env) {
    return !!(String(env.LANGFUSE_PUBLIC_KEY || '').trim() && String(env.LANGFUSE_SECRET_KEY || '').trim());
}

function host(env = process.env) {
    return (String(env.LANGFUSE_HOST || '').trim() || DEFAULT_HOST).replace(/\/+$/, '');
}

/** Where the person's browser opens Langfuse (self-hosted: LANGFUSE_URL, the Gateway reaches it by another address). */
function openUrl(env = process.env) {
    return (String(env.LANGFUSE_URL || '').trim() || host(env)).replace(/\/+$/, '');
}

/** Starting value of the "log prompts and replies" setting: LANGFUSE_LOG_CONTENT in .env, else off. */
function contentDefault(env = process.env) {
    return truthy(env.LANGFUSE_LOG_CONTENT);
}

// The run or chat a request belongs to: an explicit x-harness-session (chat page),
// else the task runner's request id (run-<id>-<n> -> run-<id>).
function sessionOf(req) {
    const explicit = String(req.get('x-harness-session') || '').trim();
    if (explicit) return explicit.slice(0, 200);
    const m = /^(run-[\w-]+?)-\d+$/.exec(String(req.get('x-harness-request-id') || ''));
    return m ? m[1] : null;
}

const tag = (k, v) => (v === undefined || v === null || v === '' ? null : `${k}:${String(v).replace(/[,\s]+/g, '_').slice(0, 80)}`);

/**
 * Headers the Gateway turns into Langfuse session, tags and redaction.
 * req.harnessProfile / harnessAuto / harnessClient / harnessUser and `route`
 * (the routing decision) are what the Interceptor already knows.
 * `content` false asks LiteLLM to leave prompts and replies out of the log.
 */
function headersFor(req, route, { content = false, env = process.env } = {}) {
    if (!configured(env)) return {};
    const session = sessionOf(req);
    const tags = [
        tag('client', req.harnessClient),
        tag('model', route?.model),
        tag('strategy', route?.profile),
        tag('tier', route?.tier),
        tag('auto', req.harnessAuto?.how),
        tag('user', req.harnessUser?.name),
        tag('cache', req.get('x-harness-cache') ? 'markers' : null),
        tag('request', req.get('x-harness-request-id') ? 'harness' : null),
    ].filter(Boolean);
    const out = { 'x-litellm-tags': tags.join(',') };
    if (session) out['x-litellm-session-id'] = session;
    if (content) out['litellm-disable-message-redaction'] = 'true';
    else out['x-litellm-enable-message-redaction'] = 'true';
    return out;
}

let checkCache = { at: 0, result: null };

/** Is Langfuse reachable with these keys? Cached for a minute. */
async function check(env = process.env, fetchFn = fetch) {
    if (!configured(env)) return { ok: false, problem: 'No keys' };
    if (checkCache.result && Date.now() - checkCache.at < 60000) return checkCache.result;
    let result;
    try {
        const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY.trim()}:${env.LANGFUSE_SECRET_KEY.trim()}`).toString('base64');
        const res = await fetchFn(`${host(env)}/api/public/projects`, { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(4000) });
        if (res.status === 401 || res.status === 403) result = { ok: false, problem: 'Langfuse refused the keys' };
        else if (!res.ok) result = { ok: false, problem: `Langfuse answered HTTP ${res.status}` };
        else result = { ok: true };
    } catch (err) {
        result = { ok: false, problem: `Can't reach ${host(env)}: ${err.message}` };
    }
    checkCache = { at: Date.now(), result };
    return result;
}

async function status(settings, env = process.env, fetchFn = fetch) {
    if (!configured(env)) return { configured: false, host: host(env), url: openUrl(env), content: !!settings.langfuseContent };
    return { configured: true, host: host(env), url: openUrl(env), content: !!settings.langfuseContent, ...(await check(env, fetchFn)) };
}

function resetCheck() { checkCache = { at: 0, result: null }; }

module.exports = { configured, host, openUrl, contentDefault, sessionOf, headersFor, check, status, resetCheck, DEFAULT_HOST };
