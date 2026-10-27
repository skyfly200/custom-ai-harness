// A test run must not pick up the developer's .env: the tests set the variables
// they need themselves, and a value left over from .env (a master key, say) would
// silently reach a fake Gateway and make a test pass or fail for the wrong reason.
if (!process.env.NODE_TEST_CONTEXT) { require('dotenv').config(); require('dotenv').config({ path: '.env.local' }); }
const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const {
    latestUserText,
    latestUserHasImage,
    deriveThreshold,
    withCavemanOpenAI,
    withCavemanAnthropic,
    dropUnsignedThinking,
    applyHeadroom,
    headroomCompressText,
    applyContextAnchor,
} = require('./utils/messageTransforms');
const monitor = require('./utils/monitor');
const { RunKeys, costOf, unlessRunKey } = require('./utils/runKeys');
const settings = require('./utils/settings');
const profiles = require('./utils/profiles');
const langfuse = require('./utils/langfuse');
const autoStrategy = require('./utils/autoStrategy');
const workflows = require('./utils/workflows');
const tiers = require('./utils/tiers');
const jevQuestions = require('./utils/jevQuestions');
const guard = require('./utils/guard');
const { askText, DEFAULT_WINDOW } = require('./utils/jevAsk');
const usage = require('./utils/usage');
const { pcmRate, pcmToWav } = require('./utils/audio');
const modelInfo = require('./utils/modelInfo');
const cacheMarkers = require('./utils/cacheMarkers');
const openrouterCatalog = require('./utils/openrouterCatalog');
const openrouterAuth = require('./utils/openrouterAuth');
const batchModels = require('./utils/batchModels');
const modelStats = require('./utils/modelStats');
const gatewayConfig = require('./utils/gatewayConfig');
const gatewayGuard = require('./utils/gatewayGuard');
const { McpManager, readConfig, writeConfig } = require('./utils/mcp');
const mcpAdmin = require('./utils/mcpAdmin');
const mcpCatalog = require('./utils/mcpCatalog');
const repoTools = require('./utils/repoTools');
const chatShell = require('./utils/chatShell');
const chatWorktrees = require('./utils/chatWorktrees');
const { requirePassword, viaProxy } = require('./utils/access');
const { createLogin } = require('./utils/login');
const { parseAdmins, Users, FileStore } = require('./utils/users');
const db = require('./utils/db');
const { PgStore } = require('./utils/pgStore');
const { createChatSync } = require('./utils/chatSync');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();
// OpenRouter credentials: OPENROUTER_API_KEY, or workload identity federation (utils/openrouterAuth.js)
const orAuth = openrouterAuth.createAuth();
for (const problem of openrouterAuth.problems()) console.warn(`OpenRouter federation: ${problem}`);
// The Gateway and Router call OpenRouter through here when federation is on, so they never hold a token that expires.
// Before the password gate: they prove themselves with OPENROUTER_PROXY_KEY (or LITELLM_MASTER_KEY).
if (openrouterAuth.federated()) app.use('/openrouter-proxy', openrouterAuth.proxyHandler(orAuth));
// Run keys: capped, short-lived keys for one agent run's model calls (utils/runKeys.js).
// Checked before the password gate, which they replace for POST /v1/chat/completions only.
const runKeys = new RunKeys();
app.use(runKeys.middleware());
// HARNESS_PASSWORD locks every page and API (see utils/access.js); unset, all stay open
const HARNESS_PASSWORD = process.env.HARNESS_PASSWORD || '';
// HARNESS_REQUIRE_LOGIN=1 puts named logins in front instead (utils/login.js)
const LOGIN_ON = /^(1|true|yes|on)$/i.test(process.env.HARNESS_REQUIRE_LOGIN || '');
if (LOGIN_ON) {
    const { admins, problems } = parseAdmins(process.env.HARNESS_ADMINS);
    if (problems.length || !admins.length) {
        throw new Error('HARNESS_REQUIRE_LOGIN is on but HARNESS_ADMINS is ' + (problems.length ? `invalid:\n  ${problems.join('\n  ')}` : 'empty')
            + '\nMake a hash with `npm run hash`, then set HARNESS_ADMINS=name:HASH (several: name:HASH,name2:HASH2). Refusing to start open.');
    }
    // With DATABASE_URL the users and keys live in Postgres; requests wait for the first load
    const store = db.enabled() ? new PgStore('users') : new FileStore(process.env.HARNESS_USERS_FILE || 'users.json');
    if (store.load) {
        const loaded = store.load();
        app.use((req, res, next) => loaded.then(() => next(), next));
    }
    const users = new Users({ admins, store });
    app.use(unlessRunKey(createLogin({ users, legacyPassword: HARNESS_PASSWORD, sessionStore: db.enabled() ? require('./utils/pgSessions').pgSessions() : null }).gate));
} else if (process.env.HARNESS_SERVER === '1' && !HARNESS_PASSWORD) {
    throw new Error('Running as a server (Docker) needs HARNESS_PASSWORD, or HARNESS_REQUIRE_LOGIN=1 with HARNESS_ADMINS, in .env');
} else {
    app.use(unlessRunKey(requirePassword(HARNESS_PASSWORD)));
}
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Chats and per-person data in Postgres; without DATABASE_URL the page reports db:false and stays on localStorage
if (db.enabled()) {
    const ready = db.init();
    app.use((req, res, next) => (req.path.startsWith('/ui/api/sync') ? ready.then(() => next(), next) : next()));
    app.use(createChatSync());
} else {
    app.get('/ui/api/sync', (req, res) => res.json({ db: false }));
}

const ROUTER_URL = process.env.ROUTER_URL || 'http://127.0.0.1:6060';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';
// LiteLLM reads the same LITELLM_MASTER_KEY from .env. When it is set, every
// call to the Gateway needs it, so the harness sends it in place of whatever
// key the client used.
const GATEWAY_KEY = process.env.LITELLM_MASTER_KEY || '';
const gatewayAuth = GATEWAY_KEY ? { authorization: `Bearer ${GATEWAY_KEY}`, 'x-api-key': GATEWAY_KEY } : {};
const COMPONENT_URLS = {
    router: ROUTER_URL,
    gateway: GATEWAY_URL,
    localEngine: process.env.LOCAL_ENGINE_URL || 'http://localhost:8000',
    ollama: process.env.OLLAMA_URL || 'http://localhost:11434',
    laya: process.env.LAYA_URL || 'http://127.0.0.1:8001',
};
// Fallback models, the output cap, the transforms and the threshold all come
// from utils/settings.js so the control UI can change them while running.
// Claude Code asks for more output than Groq's 65,536 limit, which fails every
// Groq call and pushes everything down the fallback chain. 32k fits every tier.
function capMaxTokens(value) {
    return typeof value === 'number' ? Math.min(value, settings.get().maxOutputTokens) : value;
}

// Rough size of a request as providers count it: input (~4 chars per token,
// tools and system prompt included) plus the output it asks for.
function estimateTokens(body) {
    const output = body.max_tokens ?? body.max_completion_tokens ?? 0;
    return Math.ceil(JSON.stringify(body).length / 4) + output;
}

/**
 * Ask the Router (router.py) which Gateway model should serve this request.
 * Never throws: a down Router degrades to the free tier. Requests with tools
 * (every Claude Code request) tell the Router so, and it picks a weak model
 * that can call tools; the wildcard free tier may answer them with text.
 * With a named strategy (`profile`, utils/profiles.js) the Router only scores
 * the request and the profile's own outputs pick the model.
 * `effort` (x-harness-effort) moves the score up or down before the
 * threshold and the extra tiers (utils/tiers.js) are applied; `maxTier`
 * (x-harness-max-tier) names the highest tier the request may use.
 */
async function routeModel(body, requested, profile, effort, maxTier) {
    const { messages } = body;
    const config = settings.get();
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const fixed = profile ? profile.threshold : config.fixedThreshold;
    const threshold = fixed ?? deriveThreshold(messages);
    let shift = tiers.effortShift(effort);
    const base = { threshold, winRate: null, tools: hasTools, ...(profile && { profile: profile.name }), ...(shift && { effort: shift }) };
    // A client can name a model in the x-harness-model header (the chat page does)
    if (requested && !profiles.isClaudeAlias(requested)) return { ...base, model: requested, reason: 'chosen by the client' };
    if (profile?.pin && !profiles.isClaudeAlias(profile.pin)) return { ...base, model: profile.pin, reason: `pinned in strategy ${profile.name}` };
    if (!profile && config.pinModel && !profiles.isClaudeAlias(config.pinModel)) return { ...base, model: config.pinModel, reason: 'pinned in settings' };
    // Pictures go to a model that reads them; agent requests (with tools) keep their route,
    // since an images model that can't call tools would end the agent's loop
    const images = profile ? profile.images : config.imagesModel;
    if (images && !hasTools && latestUserHasImage(messages)) return { ...base, model: images, tier: 'Images', reason: 'the message has an image' };
    // Extra yes/no questions put to Jev (utils/jevQuestions.js): they can lean the effort or pick a model
    if (config.jevQuestions.length) {
        const got = await jevQuestions.ask(config.jevQuestions, latestUserText(messages), askRouter);
        const effect = jevQuestions.apply(config.jevQuestions, got.answers, { tools: hasTools });
        const asked = { answers: got.answers, hits: effect.hits.map(h => h.id), ...(got.error && { error: got.error }) };
        shift = Math.max(-1, Math.min(1, shift + effect.shift));
        if (shift) base.effort = shift; else delete base.effort;
        base.asked = asked;
        if (effect.model) return { ...base, model: effect.model, tier: 'Question', reason: `Jev said yes to ${effect.by} (${Math.round(effect.hits.find(h => h.id === effect.by).p * 100)}%)` };
    }
    try {
        const tokens = estimateTokens(body);
        // Effort moves the score; moving the threshold the other way makes the Router's own pick agree
        const asked = tiers.clamp01(threshold - shift);
        const res = await fetch(`${ROUTER_URL}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: latestUserText(messages), threshold: asked, tokens, tools: hasTools }),
            signal: AbortSignal.timeout(config.routerTimeoutMs),
        });
        if (!res.ok) {
            // the Router says why its classifier failed (an HTTP error from Jev, a missing key, ...)
            const detail = gatewayGuard.errorMessage(await res.text().catch(() => ''));
            throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
        }
        const { model, win_rate } = await res.json();
        // x-harness-max-tier keeps the score under the next tier up, so cost stays capped
        const top = tiers.ceiling(profile ? profile.tiers : config.tiers, threshold, maxTier);
        const score = top === null ? win_rate + shift : Math.min(win_rate + shift, top);
        const extra = tiers.pick(profile ? profile.tiers : config.tiers, threshold, score, hasTools);
        if (extra) return { ...base, model: extra.model, tier: extra.tier, winRate: win_rate };
        const strong = score >= threshold;
        return {
            ...base,
            model: profile ? profiles.pick(profile, score, threshold, tokens, hasTools) : model,
            tier: strong ? 'Strong' : 'Weak',
            winRate: win_rate,
        };
    } catch (err) {
        const from = profile || { down: config.routerDownModel, downTools: config.routerDownToolsModel };
        const model = hasTools ? from.downTools : from.down;
        console.warn(`Router unavailable (${err.message}); using ${model}`);
        return { ...base, model, routerError: err.message };
    }
}

function logRoute(path, { model, threshold, winRate, reason, tier, effort }) {
    if (reason) {
        console.log(`${path} → ${model} (${tier ? reason : `pinned: ${reason}`})`);
    } else {
        console.log(`${path} → ${model} (${tier ? `${tier}, ` : ''}threshold ${threshold}, strong win rate ${winRate ?? 'n/a'}${effort ? `, effort ${effort > 0 ? '+' : ''}${effort}` : ''})`);
    }
}

// Token counts from a routed request's reply, for the Usage page. Failed
// calls carry no usage and aren't counted.
function recordUsage(req, proxyRes) {
    const event = req.harnessEvent;
    if (!event || proxyRes.statusCode >= 400) return;
    usage.tap(proxyRes, ({ usage: counts, outputChars, model: upstream }) => {
        const row = usage.record({
            client: req.harnessClient,
            route: usage.routeOf(event),
            model: event.model,
            servedBy: event.servedBy,
            upstream,
            usage: counts,
            // no counts in the reply: the request's own size and the text that came back
            estimate: { input: req.harnessInputEstimate, outputChars },
            saved: req.harnessSaved,
        });
        monitor.recordUsage(event, row);
        // a run key pays for its own replies (utils/runKeys.js)
        if (req.harnessRunKey) {
            getModelInfo().then((info) => info.models[event.servedBy] || info.models[event.model], () => null)
                .then((price) => runKeys.charge(req.harnessRunKey.id, costOf(price, row)));
        }
    });
}

// The reason behind a failed answer (a provider's quota or rate-limit message,
// usually), read from the error body on its way to the client.
function recordFailure(req, proxyRes) {
    const event = req.harnessEvent;
    if (!event || proxyRes.statusCode < 400) return;
    const chunks = [];
    let size = 0;
    proxyRes.on('data', (c) => { if (size < 8192) { chunks.push(c); size += c.length; } });
    proxyRes.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        if (/gzip/i.test(proxyRes.headers['content-encoding'] || '')) {
            try { text = require('zlib').gunzipSync(Buffer.concat(chunks)).toString('utf8'); } catch {}
        }
        const { kind, message } = gatewayGuard.classify(proxyRes.statusCode, text);
        console.warn(`${req.path} → ${event.model} failed (${kind}, HTTP ${proxyRes.statusCode}): ${message}`);
        monitor.recordError(event, new Error(message), kind);
    });
}

// Sockets to the Gateway. The proxy's own agent keeps free sockets forever,
// and LiteLLM (uvicorn) closes an idle one after a few seconds: reusing one in
// that gap is a read ECONNRESET on a request that never reached a model. A
// short timeout drops them first, and per-request reset retry covers the rest.
const gatewayAgent = new (GATEWAY_URL.startsWith('https:') ? https : http).Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    timeout: 4000, // close an idle socket before the Gateway does
    maxSockets: 256,
    maxFreeSockets: 8,
});

// Everything goes to the Gateway (LiteLLM), which speaks both the OpenAI and
// the Anthropic Messages formats and applies the fallback chain. The guard
// fails a request the Gateway leaves hanging, so clients get an error instead.
const toGateway = createProxyMiddleware({
    target: GATEWAY_URL,
    changeOrigin: true,
    agent: gatewayAgent,
    on: {
        proxyReq: (proxyReq, req, res) => {
            for (const [name, value] of Object.entries(gatewayAuth)) proxyReq.setHeader(name, value);
            for (const [name, value] of Object.entries(req.harnessLangfuse || {})) proxyReq.setHeader(name, value);
            fixRequestBody(proxyReq, req, res);
            if (!req.harnessEvent) return; // token counting, model listing
            const { gatewayTimeoutMs, streamIdleTimeoutMs } = settings.get();
            req.harnessGuard = gatewayGuard.guard({
                req, res, proxyReq,
                firstByteMs: gatewayTimeoutMs,
                idleMs: streamIdleTimeoutMs,
                onFail: ({ kind, message }) => {
                    console.warn(`${req.path} → ${req.harnessEvent.model}: ${message}`);
                    monitor.recordError(req.harnessEvent, new Error(message), kind);
                },
            });
            // once per request: the retry below runs this hook again
            if (!req.harnessCancelHook) {
                req.harnessCancelHook = true;
                res.on('close', () => {
                    if (!res.writableFinished && !req.harnessFailed) monitor.recordCancel(req.harnessEvent);
                });
            }
        },
        proxyRes: (proxyRes, req) => {
            req.harnessGuard?.response(proxyRes);
            monitor.recordResponse(req.harnessEvent, proxyRes.statusCode, proxyRes.headers);
            recordUsage(req, proxyRes);
            recordFailure(req, proxyRes);
            proxyRes.on('end', () => monitor.recordFinish(req.harnessEvent));
        },
        // Replaces http-proxy-middleware's own error answer, so it must answer
        // the client itself: without that a down Gateway left clients waiting forever.
        // It also does the reset retry: with an on.error handler, http-proxy-middleware
        // resolves its promise instead of calling next(err), so the error middleware
        // further down never sees the failure.
        error: (err, req, res) => {
            req.harnessGuard?.clear();
            if (req.harnessFailed) return; // the guard already answered
            // A reset before the Gateway said anything is usually a socket it had
            // already closed: send the same request again, on a fresh one.
            if (gatewayGuard.isReset(err) && !res.headersSent && !req.harnessRetried) {
                req.harnessRetried = true;
                console.warn(`${req.path}: the Gateway reset the connection (${err.code}); retrying once`);
                // the body was read once already: the proxy writes req.body again from
                // what the body parser kept, which is still here
                req.harnessGuard?.clear();
                toGateway(req, res, () => {});
                return;
            }
            req.harnessFailed = true;
            const { kind, message } = gatewayGuard.answerProxyError(err, req, res);
            console.warn(`${req.path}: ${message}`);
            monitor.recordError(req.harnessEvent, new Error(message), kind);
        },
    }
});

// Control UI: monitor the stack and switch the Router's classifier.
app.use('/ui', express.static(path.join(__dirname, 'ui')));

// Langfuse logging (utils/langfuse.js): are keys set, can we reach it, are prompts logged
app.get('/ui/api/langfuse', async (req, res) => res.json(await langfuse.status(settings.get())));

app.get('/ui/api/status', async (req, res) => {
    res.json({ components: await monitor.checkComponents(COMPONENT_URLS), stats: monitor.stats(), openrouter: orAuth.status() });
});

// Token totals by client, model and provider; days=N for the last N days
app.get('/ui/api/usage', (req, res) => {
    res.json(usage.summary(Math.max(0, parseInt(req.query.days, 10) || 0)));
});
app.post('/ui/api/usage/clear', localJsonOnly, (req, res) => {
    usage.clear();
    res.json(usage.summary());
});

app.get('/ui/api/events', (req, res) => {
    res.json(monitor.recentEvents(Math.min(parseInt(req.query.limit, 10) || 50, 200)));
});

// Live feed of the same events (Server-Sent Events): a request arriving, the
// Router's choice, the Gateway's answer, the end of the reply, and errors.
app.get('/ui/api/live', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const send = (update) => res.write(`data: ${JSON.stringify(update)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    monitor.live.on('update', send);
    req.on('close', () => { clearInterval(ping); monitor.live.off('update', send); });
});

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Controls answer only on this machine (or, with HARNESS_PASSWORD set, to
// anyone who gave it), and only to JSON: a plain cross-site form can't send
// that without a CORS preflight, so another web page can't change settings either.
function localJsonOnly(req, res, next) {
    localOnly(req, res, () => {
        if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
        next();
    });
}

// Who may use the controls: admins when logins are on, otherwise this machine or a HARNESS_PASSWORD login
function localOnly(req, res, next) {
    // With logins on, controls are for admins, wherever they sit
    if (req.harnessLogin && req.harnessUser.role !== 'admin') return res.status(403).json({ error: 'admins only' });
    // A request through a tunnel or proxy on this machine looks like loopback, but isn't "this machine"
    if (!req.harnessLogin && (!LOOPBACK.has(req.socket.remoteAddress) || viaProxy(req)) && !req.harnessAuthenticated) {
        return res.status(403).json({ error: 'controls work only from this machine, or with HARNESS_PASSWORD set' });
    }
    next();
}

async function forwardToRouter(req, res, routerPath) {
    try {
        const upstream = await fetch(`${ROUTER_URL}${routerPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(req.body ?? {}),
            signal: AbortSignal.timeout(120000), // building a scorer can load a model
        });
        res.status(upstream.status).json(await upstream.json());
    } catch (err) {
        res.status(502).json({ error: `Router unreachable: ${err.cause?.code || err.message}` });
    }
}

// The task runner (runner/server.js) is its own process; its API is reached
// through here so it sits behind the same login. Starting, approving, stopping
// and deleting runs are controls, so they get the same local-or-password check.
const RUNNER_URL = (process.env.RUNNER_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
// /ui/api/runs, /ui/api/agents and /ui/api/tickets are the runner's /runs, /agents and /tickets
for (const part of ['runs', 'agents', 'tickets']) {
    app.use(`/ui/api/${part}`, (req, res, next) => (req.method === 'GET' ? next() : localJsonOnly(req, res, next)), async (req, res) => {
        const headers = { 'content-type': 'application/json', ...(process.env.RUNNER_TOKEN ? { 'x-runner-token': process.env.RUNNER_TOKEN } : {}) };
        try {
            const upstream = await fetch(`${RUNNER_URL}/${part}${req.url === '/' ? '' : req.url}`, {
                method: req.method, headers, signal: AbortSignal.timeout(60000),
                ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body ?? {}) }),
            });
            res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(await upstream.text());
        } catch (err) {
            res.status(502).json({ error: `The task runner is not running (${err.cause?.code || err.message}). Start it with npm run all, or node runner/server.js.` });
        }
    });
}
app.post('/ui/api/router/backend', localJsonOnly, (req, res) => forwardToRouter(req, res, '/admin/backend'));
app.post('/ui/api/router/reload', localJsonOnly, (req, res) => forwardToRouter(req, res, '/admin/reload'));
app.post('/ui/api/router/config', localJsonOnly, (req, res) => forwardToRouter(req, res, '/admin/config'));
app.post('/ui/api/router/save', localJsonOnly, (req, res) => forwardToRouter(req, res, '/admin/save'));

app.get('/ui/api/settings', (req, res) => res.json({ settings: settings.get(), defaults: settings.DEFAULTS }));
app.post('/ui/api/settings', localJsonOnly, (req, res) => {
    try {
        res.json({ settings: settings.update(req.body), defaults: settings.DEFAULTS });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});
app.post('/ui/api/settings/reset', localJsonOnly, (req, res) => res.json({ settings: settings.reset(), defaults: settings.DEFAULTS }));

// Named strategies (utils/profiles.js): the routing editor saves them, the chat
// page picks one per chat or project, any client can name one in x-harness-profile.
app.get('/ui/api/profiles', (req, res) => res.json(profiles.state()));
// {version, profiles: [...]} replaces the whole list
app.post('/ui/api/profiles', localJsonOnly, (req, res) => {
    try {
        res.json(profiles.replace(req.body?.profiles, req.body?.version));
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

// The Gateway's models and fallback chains, for the routing editor (ui/routing.html).
// Saving removes or appends model_list entries and rewrites fallback lines in
// config.yaml, keeping everything else; LiteLLM reads it at start.
const GATEWAY_CONFIG = process.env.GATEWAY_CONFIG || path.join(__dirname, 'config.yaml');
app.get('/ui/api/gateway', (req, res) => {
    try {
        res.json({ file: GATEWAY_CONFIG, ...gatewayConfig.parse(fs.readFileSync(GATEWAY_CONFIG, 'utf8')) });
    } catch (err) {
        res.status(500).json({ error: `${path.basename(GATEWAY_CONFIG)}: ${err.message}` });
    }
});
// {version, remove: [deployment ids], add: [{name, model, api_base, api_key}], fallbacks}
app.post('/ui/api/gateway', localJsonOnly, (req, res) => {
    try {
        const text = gatewayConfig.update(fs.readFileSync(GATEWAY_CONFIG, 'utf8'), req.body || {});
        fs.writeFileSync(GATEWAY_CONFIG, text, 'utf8');
        res.json({ file: GATEWAY_CONFIG, ...gatewayConfig.parse(text) });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

// Model names the Gateway serves: its /v1/models, else the model_name entries in config.yaml
app.get('/ui/api/models', async (req, res) => {
    try {
        const upstream = await fetch(`${GATEWAY_URL}/v1/models`, { headers: gatewayAuth, signal: AbortSignal.timeout(3000) });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        const { data } = await upstream.json();
        res.json({ source: 'gateway', models: [...new Set(data.map(m => m.id))] });
    } catch {
        let text = '';
        try { text = fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'); } catch {}
        const models = [...text.matchAll(/^\s*-\s*model_name:\s*["']?([^"'\s#]+)/gm)].map(m => m[1]);
        res.json({ source: 'config.yaml', models: [...new Set(models)] });
    }
});

// Prices and context sizes for the chat page's cost and context readouts:
// LiteLLM's /v1/model/info, else which models config.yaml says are free
let modelInfoCache = { at: 0, body: null };
async function getModelInfo() {
    if (modelInfoCache.body && Date.now() - modelInfoCache.at < 5 * 60 * 1000) return modelInfoCache.body;
    let text = '';
    try { text = fs.readFileSync(GATEWAY_CONFIG, 'utf8'); } catch {}
    const fromConfig = modelInfo.fromConfig(text);
    try {
        const upstream = await fetch(`${GATEWAY_URL}/v1/model/info`, { headers: gatewayAuth, signal: AbortSignal.timeout(10000) });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        // config.yaml fills in models the Gateway's list leaves out
        const body = { source: 'gateway', models: { ...fromConfig, ...modelInfo.fromGatewayInfo((await upstream.json()).data) } };
        modelInfoCache = { at: Date.now(), body };
        return body;
    } catch (err) {
        return { source: 'config.yaml', gatewayError: err.message, models: fromConfig };
    }
}

// Models the Usage page has counted that neither list names, priced by the
// provider model their replies reported (OpenRouter ids). Rows saved before
// replies were kept have no such model; for OpenRouter ones the name is
// matched instead, when exactly one OpenRouter model fits it
// (or-claude-sonnet-5.5 is anthropic/claude-sonnet-5.5).
function usageModels(models, catalog) {
    if (!catalog?.length) return models;
    const ids = new Set(catalog.map(m => m.id));
    const out = { ...models };
    for (const r of usage.summary(0).rows) {
        if (out[r.servedBy]) continue;
        const id = r.upstream ? r.upstream.replace(/^openrouter\//, '') : r.provider === 'OpenRouter' ? modelInfo.catalogIdFor(r.servedBy, catalog) : null;
        if (id && ids.has(id)) out[r.servedBy] = { maxInput: null, maxOutput: null, inputCost: null, outputCost: null, free: false, upstream: `openrouter/${id}`, local: false };
    }
    return out;
}
// OpenRouter's own prices replace the Gateway's for openrouter/ models, so the
// pages count what OpenRouter actually bills
app.get('/ui/api/model-info', async (req, res) => {
    const info = await getModelInfo();
    const catalog = await getOpenrouterCatalog({ waitMs: 10000 });
    res.json({
        ...info,
        models: modelInfo.withOpenrouterPrices(usageModels(info.models, catalog), catalog),
        // whether OpenRouter's prices are in, so the pages can say why a price is missing
        openrouter: catalog ? { ok: true, at: new Date(openrouterCache.at).toISOString() } : { ok: false, error: openrouterError || 'not loaded yet' },
    });
});

// Command guard (utils/guard.js): an agent asks before running a shell command
// or writing a file; .claude/hooks/guard.js does this for Claude Code. Rules
// first, then Jev through the Router's /ask for commands no rule covers.
async function askRouter(text, questions) {
    const res = await fetch(`${ROUTER_URL}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, questions }),
        signal: AbortSignal.timeout(settings.get().routerTimeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Router answered HTTP ${res.status}`);
    return body.answers;
}
// Workflows (workflows/*.json): the recipes the task runner follows. /pick asks
// Jev which one fits a goal, so the Agents page can show it before the run starts.
app.get('/ui/api/workflows', (req, res) => {
    const { list, problems } = workflows.load();
    res.json({ workflows: list.map(({ id, name, when, fallback, stages }) => ({ id, name, when, fallback, stages: stages.map(({ id: sid, role, tools, effort, verdict }) => ({ id: sid, role, tools, effort, verdict })) })), problems });
});
app.post('/ui/api/workflows/pick', async (req, res) => {
    res.json(await workflows.pick(String(req.body?.goal || ''), { ask: askRouter }));
});
// The task runner makes a run key for an agent run's model calls and revokes it when the run ends
app.post('/v1/run-keys', localJsonOnly, (req, res) => {
    try { res.json(runKeys.create(req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/v1/run-keys/:id', localOnly, (req, res) => {
    const spent = runKeys.revoke(req.params.id);
    if (!spent) return res.status(404).json({ error: 'no such run key' });
    res.json(spent);
});
app.post('/v1/guard', async (req, res) => {
    const { guardJev, guardAskAt, guardDenyAt } = settings.get();
    const result = await guard.check(req.body || {}, { ask: askRouter, jev: guardJev, askAt: guardAskAt, denyAt: guardDenyAt });
    monitor.live.emit('update', { type: 'guard', event: result });
    res.json(result);
});

// How much text the Router's classifier reads at once: the tail it keeps of each prompt
let windowCache = { at: 0, size: DEFAULT_WINDOW };
async function classifierWindow() {
    if (Date.now() - windowCache.at < 60000) return windowCache.size;
    try {
        const res = await fetch(`${ROUTER_URL}/health`, { signal: AbortSignal.timeout(2000) });
        const { backend, settings: s = {} } = await res.json();
        const size = Number(backend === 'laya' ? s.laya_max_chars : s.max_chars);
        windowCache = { at: Date.now(), size: Number.isFinite(size) && size >= 200 ? size : DEFAULT_WINDOW };
    } catch {
        windowCache = { at: Date.now() - 50000, size: windowCache.size };
    }
    return windowCache.size;
}

// Ask Jev a question about a text (a file an agent doesn't want in its context)
app.post('/v1/jev/ask', async (req, res) => {
    const { text, question, mode, threshold, maxWindows } = req.body || {};
    try {
        const result = await askText({
            text, question, mode, ask: askRouter, window: await classifierWindow(),
            ...(Number.isFinite(threshold) ? { threshold } : {}), ...(Number.isFinite(maxWindows) ? { maxWindows } : {}),
        });
        res.json(result);
    } catch (err) {
        const bad = /required|mode must/.test(err.message);
        res.status(bad ? 400 : 502).json({ error: err.message });
    }
});
app.get('/ui/api/guard', (req, res) => res.json({ log: guard.recent(Number(req.query.limit) || 50), rules: guard.counts(), file: guard.FILE }));
app.post('/ui/api/guard/reload', localJsonOnly, (req, res) => { guard.load(); res.json({ rules: guard.counts() }); });

// Benchmarks from Artificial Analysis's free API (1,000 requests a day), kept
// for a day. Off unless ARTIFICIAL_ANALYSIS_API_KEY is set.
let benchCache = { at: 0, list: null, error: null };
async function getBenchmarks() {
    const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    if (!key) return { list: null, error: null };
    const fresh = benchCache.list && Date.now() - benchCache.at < 24 * 60 * 60 * 1000;
    const retry = !benchCache.list && benchCache.error && Date.now() - benchCache.at < 10 * 60 * 1000;
    if (fresh || retry) return benchCache;
    try {
        const upstream = await fetch(modelStats.AA_URL, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(8000) });
        if (!upstream.ok) throw new Error(`Artificial Analysis answered HTTP ${upstream.status}`);
        benchCache = { at: Date.now(), list: modelStats.fromArtificialAnalysis(await upstream.json()), error: null };
    } catch (err) {
        benchCache = { at: Date.now(), list: benchCache.list, error: err.message };
    }
    return benchCache;
}

// Quality, speed, price and strengths of each Gateway model (utils/modelStats.js)
app.get('/ui/api/model-stats', async (req, res) => {
    const info = await getModelInfo();
    const catalog = await getOpenrouterCatalog({ waitMs: 4000 });
    const bench = await getBenchmarks();
    res.json({
        models: modelStats.build(modelInfo.withOpenrouterPrices(info.models, catalog), catalog, bench.list),
        strengths: modelStats.STRENGTHS,
        benchmarks: {
            on: !!process.env.ARTIFICIAL_ANALYSIS_API_KEY,
            count: bench.list?.length || 0,
            error: bench.error,
            models: (bench.list || []).map(m => ({ slug: m.slug, name: m.name, creator: m.creator })),
        },
    });
});
// Benchmarks matched to each OpenRouter catalog id, for the Add model dialog
app.get('/ui/api/openrouter/benchmarks', async (req, res) => {
    const catalog = await getOpenrouterCatalog({ waitMs: 4000 });
    const bench = await getBenchmarks();
    res.json({
        on: !!process.env.ARTIFICIAL_ANALYSIS_API_KEY,
        error: bench.error,
        count: bench.list?.length || 0,
        models: modelStats.forCatalog(catalog, bench.list),
    });
});
app.post('/ui/api/model-stats', localJsonOnly, (req, res) => {
    try {
        res.json({ saved: modelStats.set(req.body?.name, req.body?.values) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Read-aloud for the chat page through an OpenAI-compatible speech endpoint
// (POST {TTS_URL}/audio/speech). With an OpenRouter key and no TTS_URL it uses
// OpenRouter's speech models; TTS_URL points it at Kokoro-FastAPI, OpenAI, or
// the Gateway instead. The chat page picks the model and voice; TTS_MODEL and
// TTS_VOICE are only the defaults.
const OPENROUTER_URL = (process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const TTS_URL = (process.env.TTS_URL || (orAuth.configured() ? OPENROUTER_URL : '')).replace(/\/+$/, '');
const TTS_OPENROUTER = /openrouter\.ai/.test(TTS_URL);
const TTS_MODEL = process.env.TTS_MODEL || (TTS_OPENROUTER ? 'fish-audio/s2.1-pro-free:free' : 'kokoro');
const TTS_VOICE = process.env.TTS_VOICE ?? (TTS_OPENROUTER ? '' : 'af_heart'); // empty sends none: the model's default voice
const ttsKey = async () => process.env.TTS_API_KEY
    || (TTS_URL.startsWith(GATEWAY_URL) ? GATEWAY_KEY : '')
    || (TTS_OPENROUTER ? await orAuth.key().catch((err) => { console.warn(`TTS: ${err.message}`); return ''; }) : '');
const TTS_INSTRUCTIONS = process.env.TTS_INSTRUCTIONS || ''; // tone and pacing, for models that take it
const TTS_VOICES = (process.env.TTS_VOICES || '').split(',').map(v => v.trim()).filter(Boolean);
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const ttsHeaders = async () => {
    const key = await ttsKey();
    return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
};
const voiceIds = (list) => (list || []).map(v => (typeof v === 'string' ? v : v.id || v.voice_id || v.name)).filter(Boolean);

// Speech models the server offers, with their voices: [{ id, name, voices, free }]
let ttsModelCache = { at: 0, models: null };
async function listTtsModels() {
    if (ttsModelCache.models && Date.now() - ttsModelCache.at < 10 * 60 * 1000) return ttsModelCache.models;
    let models = [];
    if (TTS_OPENROUTER) {
        try {
            const upstream = await fetch(`${TTS_URL}/models?output_modalities=speech`, { headers: await ttsHeaders(), signal: AbortSignal.timeout(8000) });
            if (upstream.ok) {
                models = ((await upstream.json()).data || []).map(m => ({
                    id: m.id,
                    name: m.name || m.id,
                    voices: voiceIds(m.supported_voices || m.architecture?.supported_voices),
                    free: m.id.endsWith(':free') || Object.values(m.pricing || {}).every(v => !Number(v)),
                }));
            }
        } catch {}
    } else {
        // one model; Kokoro-FastAPI lists its voices, OpenAI and others don't
        let voices = [];
        try {
            const upstream = await fetch(`${TTS_URL}/audio/voices`, { headers: await ttsHeaders(), signal: AbortSignal.timeout(3000) });
            if (upstream.ok) {
                const body = await upstream.json();
                voices = voiceIds(Array.isArray(body) ? body : body.voices);
            }
        } catch {}
        if (!voices.length && /tts-1|gpt-4o-mini-tts|^openai\//i.test(TTS_MODEL)) voices = OPENAI_VOICES;
        models = [{ id: TTS_MODEL, name: TTS_MODEL, voices, free: false }];
    }
    let fallback = models.find(m => m.id === TTS_MODEL);
    if (!fallback) models.unshift(fallback = { id: TTS_MODEL, name: TTS_MODEL, voices: [], free: TTS_MODEL.endsWith(':free') });
    if (TTS_VOICES.length) fallback.voices = TTS_VOICES;
    if (models.length > 1) ttsModelCache = { at: Date.now(), models }; // don't cache a failed lookup
    return models;
}

// OpenRouter's chat models for the routing editor's model picker. The catalog
// is public, so this works without a key; it is kept for an hour.
let openrouterCache = { at: 0, models: null };
async function fetchOpenrouterCatalog(timeoutMs = 10000) {
    const key = await orAuth.key().catch((err) => { console.warn(`OpenRouter catalog: ${err.message}`); return ''; });
    const upstream = await fetch(`${OPENROUTER_URL}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) throw new Error(`OpenRouter answered HTTP ${upstream.status}`);
    const models = openrouterCatalog.fromCatalog(await upstream.json());
    if (!models.length) throw new Error('OpenRouter listed no models');
    openrouterCache = { at: Date.now(), models };
    return models;
}

// The catalog for prices: the hour's copy, else a fresh one. A failed fetch
// isn't retried for a minute, so pages don't keep waiting on an unreachable OpenRouter.
let openrouterFailedAt = 0;
let openrouterError = '';
async function getOpenrouterCatalog({ waitMs }) {
    if (openrouterCache.models && Date.now() - openrouterCache.at < 60 * 60 * 1000) return openrouterCache.models;
    if (Date.now() - openrouterFailedAt < 60 * 1000) return openrouterCache.models;
    try {
        const models = await fetchOpenrouterCatalog(waitMs);
        openrouterError = '';
        return models;
    } catch (err) {
        openrouterFailedAt = Date.now();
        openrouterError = err.message;
        console.warn(`Couldn't load OpenRouter's prices: ${err.message}`);
        return openrouterCache.models;
    }
}

app.get('/ui/api/openrouter/models', async (req, res) => {
    if (openrouterCache.models && Date.now() - openrouterCache.at < 60 * 60 * 1000) return res.json({ models: batchModels.mark(openrouterCache.models) });
    try {
        res.json({ models: batchModels.mark(await fetchOpenrouterCatalog()) });
    } catch (err) {
        if (openrouterCache.models) return res.json({ models: batchModels.mark(openrouterCache.models), stale: true });
        res.status(502).json({ error: `Couldn't load OpenRouter's model list: ${err.message}` });
    }
});

app.get('/ui/api/tts', async (req, res) => {
    if (!TTS_URL) return res.json({ configured: false });
    res.json({ configured: true, model: TTS_MODEL, voice: TTS_VOICE, host: new URL(TTS_URL).host, models: await listTtsModels() });
});

const pcmOnlyModels = new Set(); // models that refused MP3 once

app.post('/ui/api/tts', async (req, res) => {
    if (!TTS_URL) return res.status(404).json({ error: 'No TTS server: add OPENROUTER_API_KEY (or the OPENROUTER_FEDERATION_* settings) or TTS_URL to .env' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
    const { text, voice, speed } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const model = typeof req.body.model === 'string' && req.body.model ? req.body.model : TTS_MODEL;
    // the default voice belongs to the default model
    const chosenVoice = (typeof voice === 'string' && voice) || (model === TTS_MODEL ? TTS_VOICE : '');
    const speak = async (format) => fetch(`${TTS_URL}/audio/speech`, {
        method: 'POST',
        headers: await ttsHeaders(),
        body: JSON.stringify({
            model,
            input: text.slice(0, 4000),
            ...(chosenVoice ? { voice: chosenVoice } : {}),
            // some models reject any speed but the default, so send it only when changed
            ...(Number(speed) && Number(speed) !== 1 ? { speed: Math.min(4, Math.max(0.25, Number(speed))) } : {}),
            ...(TTS_INSTRUCTIONS ? { instructions: TTS_INSTRUCTIONS } : {}),
            response_format: format,
        }),
        signal: AbortSignal.timeout(60000),
    });
    try {
        // MP3 when the model makes it; some (Gemini TTS) only make raw PCM
        let format = pcmOnlyModels.has(model) ? 'pcm' : 'mp3';
        let upstream = await speak(format);
        if (!upstream.ok && format === 'mp3') {
            const detail = await upstream.text();
            if (upstream.status === 400 && /response[_ ]?format|pcm|mp3/i.test(detail)) {
                pcmOnlyModels.add(model);
                upstream = await speak(format = 'pcm');
            } else {
                return res.status(502).json({ error: `TTS server answered HTTP ${upstream.status}: ${detail.slice(0, 300)}` });
            }
        }
        if (!upstream.ok) {
            const detail = (await upstream.text()).slice(0, 300);
            return res.status(502).json({ error: `TTS server answered HTTP ${upstream.status}: ${detail}` });
        }
        const type = upstream.headers.get('content-type') || '';
        if (format === 'pcm' && !/wav|mpeg|ogg|opus|aac|flac/i.test(type)) {
            res.set('content-type', 'audio/wav');
            return res.send(pcmToWav(Buffer.from(await upstream.arrayBuffer()), { sampleRate: pcmRate(type) }));
        }
        res.set('content-type', upstream.headers.get('content-type') || 'audio/mpeg');
        res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
        res.status(502).json({ error: `TTS server unreachable: ${err.cause?.code || err.message}` });
    }
});

// Dictation for the chat page through an OpenAI-compatible transcription
// endpoint (POST {STT_URL}/audio/transcriptions). The browser's own speech
// service needs no server, but Brave and some Chromium builds ship without one
// and always fail with "network". STT_URL points this at OpenRouter, Groq,
// OpenAI, a local Whisper or the Gateway. STT_MODEL is the model to ask for and
// STT_LANGUAGE the default language; the page can override both per request.
const STT_URL = (process.env.STT_URL || (process.env.OPENROUTER_API_KEY ? OPENROUTER_URL : '')).replace(/\/+$/, '');
const STT_OPENROUTER = /openrouter\.ai/.test(STT_URL);
const STT_MODEL = process.env.STT_MODEL || (STT_OPENROUTER ? 'mistralai/voxtral-mini-transcribe-3-0' : 'whisper-1');
const STT_LANGUAGE = process.env.STT_LANGUAGE || '';
const STT_KEY = process.env.STT_API_KEY
    || (STT_URL.startsWith(GATEWAY_URL) ? GATEWAY_KEY : '')
    || (STT_OPENROUTER ? process.env.OPENROUTER_API_KEY || '' : '');

app.get('/ui/api/stt', (req, res) => {
    if (!STT_URL) return res.json({ configured: false });
    res.json({ configured: true, model: STT_MODEL, language: STT_LANGUAGE, host: new URL(STT_URL).host });
});

// The page records with MediaRecorder and sends base64 JSON. Upstream it goes
// as a multipart upload, which is what OpenAI, Groq, local Whisper servers and
// OpenRouter all accept; 24 MB is OpenAI's cap and OpenRouter's too.
const STT_FORMATS = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
const STT_MAX_BYTES = 24 * 1024 * 1024;

app.post('/ui/api/stt', async (req, res) => {
    if (!STT_URL) return res.status(404).json({ error: 'No speech server: add OPENROUTER_API_KEY or STT_URL to .env' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
    const { audio, format, language, model } = req.body || {};
    if (typeof audio !== 'string' || !audio) return res.status(400).json({ error: 'audio is required' });
    const bytes = Buffer.from(audio, 'base64');
    if (!bytes.length) return res.status(400).json({ error: 'audio is empty' });
    if (bytes.length > STT_MAX_BYTES) return res.status(413).json({ error: 'audio is longer than 24 MB' });
    const type = String(format || 'audio/webm').split(';')[0].trim();
    const ext = STT_FORMATS[type] || 'webm';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), `dictation.${ext}`);
    form.append('model', typeof model === 'string' && model ? model : STT_MODEL);
    // transcription servers want an ISO-639-1 code: the page holds "en-US"
    const lang = ((typeof language === 'string' && language.trim()) || STT_LANGUAGE).split(/[-_]/)[0];
    if (lang) form.append('language', lang);
    try {
        const upstream = await fetch(`${STT_URL}/audio/transcriptions`, {
            method: 'POST',
            headers: STT_KEY ? { authorization: `Bearer ${STT_KEY}` } : {},
            body: form,
            signal: AbortSignal.timeout(120000),
        });
        const body = await upstream.text();
        if (!upstream.ok) return res.status(502).json({ error: `Speech server answered HTTP ${upstream.status}: ${body.slice(0, 300)}` });
        let text = body;
        try { text = JSON.parse(body).text ?? ''; } catch {}
        res.json({ text: String(text).trim() });
    } catch (err) {
        res.status(502).json({ error: `Speech server unreachable: ${err.cause?.code || err.message}` });
    }
});

// Tools for the chat page: MCP servers from mcp-servers.json, and read-only
// tools over a git repo a chat is linked to. The page runs the tool loop: it
// sends the definitions with each request and calls back here to run a call.
const mcp = new McpManager();

app.get('/ui/api/tools', async (req, res) => {
    await mcp.start();
    const status = mcp.status();
    const definitions = {};
    for (const s of status.servers) definitions[s.name] = mcp.definitions(status.servers.filter(o => o.name !== s.name).map(o => o.name));
    res.json({ ...status, definitions, repoDefinitions: repoTools.definitions(), shellDefinitions: settings.get().shellInRepo ? chatShell.definitions() : [] });
});

app.post('/ui/api/tools/reload', localJsonOnly, async (req, res) => {
    await mcp.reload();
    res.json(mcp.status());
});

// The Tools page: add, edit, test, switch off and remove MCP servers. Admin-only
// (a stdio server is a program this machine runs); literal env and header
// values are never sent back, only that they are set.
function mcpList() {
    const status = new Map(mcp.status().servers.map(s => [s.name, s]));
    const tools = mcp.allTools();
    return {
        file: mcp.file,
        error: mcp.configError || null,
        servers: Object.entries(readConfig(mcp.file)).map(([name, spec]) => ({
            name,
            spec: mcpAdmin.describeSpec(spec),
            status: status.get(name)?.status || (spec.disabled ? 'disabled' : 'connecting'),
            error: status.get(name)?.error || null,
            tools: tools.get(name) || [],
        })),
        catalog: mcpCatalog,
    };
}

async function mcpEdit(res, change) {
    try {
        await mcp.start();
        const servers = readConfig(mcp.file);
        change(servers);
        writeConfig(servers, mcp.file);
        await mcp.sync();
        res.json(mcpList());
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
}

app.get('/ui/api/mcp', localOnly, async (req, res) => {
    try {
        await mcp.start();
        res.json(mcpList());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add a server, or edit one (`from` is the name it had; a new name renames it)
app.post('/ui/api/mcp/save', localJsonOnly, (req, res) => mcpEdit(res, (servers) => {
    const { from, name, spec } = req.body || {};
    mcpAdmin.checkName(name);
    if (from && servers[from] === undefined) throw Object.assign(new Error(`no server named ${from}`), { status: 404 });
    if ((!from || from !== name) && servers[name] !== undefined) throw Object.assign(new Error(`a server named ${name} already exists`), { status: 409 });
    const built = mcpAdmin.buildSpec(spec, from ? servers[from] : {});
    if (from && from !== name) {
        // keep the file's order when renaming
        const entries = Object.entries(servers).map(([k, v]) => (k === from ? [name, built] : [k, v]));
        for (const k of Object.keys(servers)) delete servers[k];
        Object.assign(servers, Object.fromEntries(entries));
    } else {
        servers[name] = built;
    }
}));

// Switch a server on or off, or choose which of its tools the model is offered
app.post('/ui/api/mcp/patch', localJsonOnly, (req, res) => mcpEdit(res, (servers) => {
    const { name, disabled, disabledTools } = req.body || {};
    const spec = servers[name];
    if (!spec) throw Object.assign(new Error(`no server named ${name}`), { status: 404 });
    if (disabled !== undefined) {
        if (disabled) spec.disabled = true;
        else delete spec.disabled;
    }
    if (disabledTools !== undefined) {
        if (!Array.isArray(disabledTools) || disabledTools.some(t => typeof t !== 'string')) throw Object.assign(new Error('disabledTools must be a list of tool names'), { status: 400 });
        if (disabledTools.length) spec.disabledTools = disabledTools;
        else delete spec.disabledTools;
    }
}));

app.post('/ui/api/mcp/remove', localJsonOnly, (req, res) => mcpEdit(res, (servers) => {
    const { name } = req.body || {};
    if (servers[name] === undefined) throw Object.assign(new Error(`no server named ${name}`), { status: 404 });
    delete servers[name];
}));

// Try an entry without saving it: connect, list the tools, disconnect
app.post('/ui/api/mcp/test', localJsonOnly, async (req, res) => {
    try {
        const { from, spec } = req.body || {};
        const stored = from ? readConfig(mcp.file)[from] : undefined;
        const built = mcpAdmin.buildSpec(spec, stored || {});
        res.json(await mcp.probe(built));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.post('/ui/api/repo', localJsonOnly, async (req, res) => {
    try {
        const repo = await repoTools.inspect(req.body?.path);
        const workspace = req.body?.chatId ? await chatWorktrees.create(repo.path, req.body.chatId) : null;
        res.json({ ...repo, ...(workspace ? { workspacePath: workspace.path, workspaceBranch: workspace.branch } : {}) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Run one command for a chat linked to a repo, once the guard has been asked.
// "allow" runs it and "deny" never does; "ask" runs only when the page says you
// allowed it there, so a page that skips the question gets a refusal, not a run.
async function shellCall(repo, args, confirmed) {
    const { guardJev, guardAskAt, guardDenyAt, shellInRepo } = settings.get();
    if (!shellInRepo) throw new Error('the shell is off: turn it on in the chat options or in the settings');
    const command = String(args.command || '');
    if (!command.trim()) throw new Error('command is required');
    const root = chatShell.repoRoot(repo);
    const verdict = await guard.check({ tool: 'bash', command }, { ask: askRouter, jev: guardJev, askAt: guardAskAt, denyAt: guardDenyAt });
    monitor.live.emit('update', { type: 'guard', event: { ...verdict, from: 'chat' } });
    if (verdict.decision === 'deny') throw new Error(`refused: ${verdict.reason}`);
    if (verdict.decision === 'ask' && !confirmed) throw new Error(`needs your approval (${verdict.reason}) but the page sent no confirmation`);
    const r = await chatShell.exec(root, command, { timeoutMs: (Number(args.timeout_seconds) || 120) * 1000 });
    const status = r.timedOut ? `timed out after ${Math.round(r.ms / 1000)} s` : `exit code ${r.code}`;
    return `${status}\n${r.output}`.trimEnd();
}

// A command the chat's shell wants to run, checked but not run: the page shows
// the guard's verdict, asks you when it says "ask", then posts the command back
// to /ui/api/tools/call with `confirmed`.
app.post('/ui/api/tools/shell/check', localJsonOnly, async (req, res) => {
    const { command } = req.body || {};
    if (typeof command !== 'string' || !command.trim()) return res.status(400).json({ error: 'command is required' });
    const { guardJev, guardAskAt, guardDenyAt, shellInRepo } = settings.get();
    if (!shellInRepo) return res.json({ decision: 'deny', reason: 'the shell is off in the settings' });
    const result = await guard.check({ tool: 'bash', command }, { ask: askRouter, jev: guardJev, askAt: guardAskAt, denyAt: guardDenyAt });
    monitor.live.emit('update', { type: 'guard', event: { ...result, from: 'chat' } });
    res.json(result);
});

// Run one tool call. A failing tool is an answer for the model, not an HTTP error.
app.post('/ui/api/tools/call', localJsonOnly, async (req, res) => {
    const { name, arguments: args, repo, chatId, confirmed } = req.body || {};
    if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name is required' });
    const started = Date.now();
    try {
        const needsRepo = chatShell.isShellTool(name) || repoTools.isRepoTool(name);
        const workspace = needsRepo && repo && chatId ? await chatWorktrees.create(repo, chatId) : null;
        const toolRepo = workspace?.path || repo;
        let result;
        if (chatShell.isShellTool(name)) {
            result = { text: await shellCall(toolRepo, args || {}, confirmed === true), isError: false };
        } else if (repoTools.isRepoTool(name)) {
            if (!toolRepo) throw new Error('this chat is not linked to a git repo');
            result = { text: await repoTools.call(toolRepo, name, args || {}), isError: false };
        } else {
            await mcp.start();
            result = await mcp.call(name, args || {});
        }
        res.json({ ...result, ms: Date.now() - started });
    } catch (err) {
        res.json({ text: `Error: ${err.message}`, isError: true, ms: Date.now() - started });
    }
});

// The named strategy a request asked for with x-harness-profile (null: the
// default). "auto" lets the harness choose per request (utils/autoStrategy.js);
// req.harnessAuto then says how, for the routing log.
async function profileOf(req) {
    // x-harness-strategy is the same header under its current name
    const id = req.get('x-harness-strategy') || req.get('x-harness-profile');
    if (id && id.trim().toLowerCase() === autoStrategy.AUTO) {
        const { autoJev, autoAskAt, autoFirst } = settings.get();
        const picked = await autoStrategy.pick(profiles.list(), {
            text: latestUserText(req.body.messages || []),
            tools: Array.isArray(req.body.tools) && req.body.tools.length > 0,
            client: usage.clientOf(req),
            tokens: estimateTokens(req.body),
            ask: askRouter, jev: autoJev, askAt: autoAskAt, first: autoFirst,
        });
        req.harnessAuto = { how: picked.how, why: picked.why };
        console.log(`Auto strategy: ${picked.profile ? picked.profile.name : 'the default strategy'} (${picked.how}: ${picked.why})`);
        return picked.profile;
    }
    const p = profiles.get(id);
    if (id && !p) console.warn(`Unknown strategy "${id}"; using the default`);
    return p;
}

// Which transforms run: the request's routing decides, else the Interceptor settings
function transformsFor(req) {
    const { caveman, headroom, contextAnchor } = req.harnessProfile || settings.get();
    return { caveman, headroom, contextAnchor };
}

// Context anchor first, on the raw results, then Headroom compression.
// req.harnessSaved keeps the tokens each one took out (about 4 characters a
// token), for the Usage page's savings.
function compressToolResults(req, messages) {
    const { headroom, contextAnchor } = transformsFor(req);
    const size = (m) => JSON.stringify(m).length;
    const before = headroom || contextAnchor ? size(messages) : 0;
    const anchored = contextAnchor ? applyContextAnchor(messages) : messages;
    const middle = contextAnchor ? size(anchored) : before;
    const out = headroom ? applyHeadroom(anchored) : anchored;
    const after = headroom ? size(out) : middle;
    req.harnessSaved = {
        anchor: Math.max(0, Math.round((before - middle) / 4)),
        headroom: Math.max(0, Math.round((middle - after) / 4)),
    };
    return out;
}

// Transforms the Interceptor applied to this request, for the live feed
function activeTransforms(req) {
    const { caveman, headroom, contextAnchor } = transformsFor(req);
    return [caveman && 'caveman', headroom && 'headroom', contextAnchor && 'context anchor'].filter(Boolean);
}

async function routeAndRecord(req, res) {
    const clientId = req.get('x-harness-request-id');
    const prompt = latestUserText(req.body.messages);
    monitor.recordRouting({ path: req.path, clientId, prompt });
    const started = Date.now();
    const route = await routeModel(req.body, req.get('x-harness-model'), req.harnessProfile, req.get('x-harness-effort'), req.get('x-harness-max-tier'));
    route.model = profiles.currentName(route.model);
    req.body.model = route.model;
    // A strategy's own fallback chains replace the Gateway's for this request
    const own = profiles.gatewayFallbacks(req.harnessProfile);
    if (own) req.body.fallbacks = own;
    logRoute(req.path, route);
    req.harnessClient = usage.clientOf(req);
    req.harnessInputEstimate = Math.ceil(JSON.stringify(req.body.messages || []).length / 4)
        + Math.ceil(JSON.stringify(req.body.system || '').length / 4)
        + Math.ceil(JSON.stringify(req.body.tools || []).length / 4);
    req.harnessEvent = monitor.recordRoute({
        path: req.path, ...route, tokens: estimateTokens(req.body), prompt, clientId,
        transforms: activeTransforms(req), routeMs: Date.now() - started, auto: req.harnessAuto,
    });
    // Tell the client where its request went (the chat page shows it)
    res.set('x-harness-event', String(req.harnessEvent.id));
    res.set('x-harness-model', route.model);
    res.set('x-harness-route', route.reason || (route.routerError ? 'router down'
        : `${route.tier ? `${route.tier}: ` : ''}win rate ${route.winRate} vs threshold ${route.threshold}${route.effort ? `, effort ${route.effort > 0 ? '+' : ''}${route.effort}` : ''}`));
    if (route.tier) res.set('x-harness-tier', encodeURIComponent(route.tier));
    if (route.profile) res.set('x-harness-profile', encodeURIComponent(route.profile));
    if (req.harnessAuto) res.set('x-harness-auto', encodeURIComponent(`${req.harnessAuto.how}: ${req.harnessAuto.why}`));
    req.harnessLangfuse = langfuse.headersFor(req, route, { content: settings.get().langfuseContent });
}

// OpenAI-compatible agents (Cursor, Aider, Continue, ...) and the chat page
app.post(['/chat/completions', '/v1/chat/completions'], async (req, res, next) => {
    req.harnessProfile = await profileOf(req);
    const messages = req.body.messages || [];
    req.body.messages = compressToolResults(req, transformsFor(req).caveman ? withCavemanOpenAI(messages) : messages);
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    req.body.max_completion_tokens = capMaxTokens(req.body.max_completion_tokens);
    await routeAndRecord(req, res);
    // the chat page asks for cache markers; only Claude needs them
    if (req.get('x-harness-cache') && cacheMarkers.isAnthropic((await getModelInfo()).models[req.body.model])) {
        req.body.messages = cacheMarkers.addCacheMarkers(req.body.messages);
    }
    next();
}, toGateway);

// Anthropic Messages API: Claude Code with ANTHROPIC_BASE_URL=http://localhost:3000
app.post('/v1/messages', async (req, res, next) => {
    req.harnessProfile = await profileOf(req);
    req.body.messages = compressToolResults(req, dropUnsignedThinking(req.body.messages || []));
    if (transformsFor(req).caveman) req.body.system = withCavemanAnthropic(req.body.system);
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    await routeAndRecord(req, res);
    next();
}, toGateway);

// Anything else (token counting, model listing) passes through untouched
app.use(toGateway);

// Errors the proxy hands on. It emits 'error' and then calls next with the same
// error, so this runs after on.error, which leaves a reset unanswered: a
// connection the Gateway dropped before saying anything is retried once, on a
// fresh socket, and anything else is answered here.
app.use((err, req, res, next) => {
    if (gatewayGuard.isReset(err) && !res.headersSent && !req.harnessRetried) {
        req.harnessGuard?.clear(); // its watchdog would answer the retry
        req.harnessRetried = true;
        console.warn(`${req.path}: the Gateway reset the connection (${err.code}); retrying once`);
        return toGateway(req, res, next);
    }
    if (res.headersSent || res.writableEnded) return;
    req.harnessFailed = true;
    const { kind, message } = gatewayGuard.answerProxyError(err, req, res);
    console.warn(`${req.path}: ${message}`);
    monitor.recordError(req.harnessEvent, new Error(message), kind);
});

if (require.main === module) {
    app.listen(3000, () => console.log('Harness interceptor active on port 3000'));
    mcp.start().then(() => {
        for (const s of mcp.status().servers) console.log(`MCP server ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ` · ${s.tools.length} tools`}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        Promise.all([chatShell.closePowerShellSessions(), mcp.close()]).finally(() => process.exit(0));
    });
}

module.exports = { app, mcp, applyHeadroom, headroomCompressText, applyContextAnchor, deriveThreshold, withCavemanAnthropic, dropUnsignedThinking };
