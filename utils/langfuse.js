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

// Langfuse Cloud has one project per region, and a key pair only works on the
// region its project lives in. A refused key pair is often just the wrong region.
const CLOUD_REGIONS = [
    { name: 'EU', host: 'https://cloud.langfuse.com' },
    { name: 'US', host: 'https://us.cloud.langfuse.com' },
    { name: 'HIPAA US', host: 'https://hipaa.cloud.langfuse.com' },
];

const isCloud = (h) => CLOUD_REGIONS.some((r) => r.host === h);

/** The public key is pk-lf-..., the secret key sk-lf-...; a pair typed the other way round is refused everywhere. */
function swappedKeys(env = process.env) {
    const pk = String(env.LANGFUSE_PUBLIC_KEY || '').trim();
    const sk = String(env.LANGFUSE_SECRET_KEY || '').trim();
    if (pk.startsWith('sk-lf-') || sk.startsWith('pk-lf-')) {
        return 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY look swapped (the public key starts pk-lf-, the secret key sk-lf-).';
    }
    return null;
}

/** One GET /api/public/projects with the key pair against one host. Never throws. */
async function probe(h, env, fetchFn) {
    try {
        const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY.trim()}:${env.LANGFUSE_SECRET_KEY.trim()}`).toString('base64');
        const res = await fetchFn(`${h}/api/public/projects`, { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(4000) });
        return { status: res.status, ok: !!res.ok };
    } catch (err) {
        return { error: err.message || String(err) };
    }
}

const refusedText = (status, h) => `Langfuse refused the keys (HTTP ${status} from ${h})`;

/** Is Langfuse reachable with these keys? Cached for a minute. */
async function check(env = process.env, fetchFn = fetch) {
    if (!configured(env)) return { ok: false, problem: 'No keys' };
    if (checkCache.result && Date.now() - checkCache.at < 60000) return checkCache.result;
    const h = host(env);
    let result;
    const swapped = swappedKeys(env);
    if (swapped) {
        result = { ok: false, host: h, problem: 'Langfuse keys look swapped', hint: swapped };
    } else {
        const first = await probe(h, env, fetchFn);
        if (first.error) {
            result = { ok: false, host: h, problem: `Can't reach ${h}: ${first.error}` };
        } else if (first.status === 401 || first.status === 403) {
            result = { ok: false, host: h, httpStatus: first.status, problem: refusedText(first.status, h), hint: 'Check that both keys come from the same project (Langfuse: Settings, API Keys) and that .env has no extra spaces or quotes. Restart the Gateway after editing .env.' };
            if (isCloud(h)) {
                // Try the other cloud regions; the first that accepts the keys is the one to use.
                const others = CLOUD_REGIONS.filter((r) => r.host !== h);
                const tries = await Promise.all(others.map(async (r) => ({ region: r, res: await probe(r.host, env, fetchFn) })));
                const hit = tries.find((t) => t.res.ok);
                if (hit) {
                    result.suggestion = { region: hit.region.name, host: hit.region.host };
                    result.hint = `These keys work on the ${hit.region.name} cloud. Set LANGFUSE_HOST=${hit.region.host} in .env and restart the Gateway.`;
                }
            }
        } else if (!first.ok) {
            result = { ok: false, host: h, httpStatus: first.status, problem: `Langfuse answered HTTP ${first.status} from ${h}`, hint: first.status === 404 ? 'That address does not look like Langfuse. Check LANGFUSE_HOST.' : undefined };
        } else {
            result = { ok: true, host: h, httpStatus: first.status };
        }
    }
    checkCache = { at: Date.now(), result };
    return result;
}

async function status(settings, env = process.env, fetchFn = fetch) {
    if (!configured(env)) return { configured: false, host: host(env), url: openUrl(env), content: !!settings.langfuseContent };
    return { configured: true, host: host(env), url: openUrl(env), content: !!settings.langfuseContent, ...(await check(env, fetchFn)) };
}

function resetCheck() { checkCache = { at: 0, result: null }; }

module.exports = { configured, host, openUrl, contentDefault, sessionOf, headersFor, check, status, resetCheck, swappedKeys, CLOUD_REGIONS, DEFAULT_HOST };
