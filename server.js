require('dotenv').config();
const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { countTokens, isEnabled, recordObservation } = require('./utils/tokenCounter');
const {
    latestUserText,
    deriveThreshold,
    withCavemanOpenAI,
    withCavemanAnthropic,
    dropUnsignedThinking,
    applyHeadroom,
    headroomCompressText,
    applyContextAnchor,
} = require('./utils/messageTransforms');
const monitor = require('./utils/monitor');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const ROUTER_URL = process.env.ROUTER_URL || 'http://localhost:6060';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';
const COMPONENT_URLS = {
    router: ROUTER_URL,
    gateway: GATEWAY_URL,
    localEngine: process.env.LOCAL_ENGINE_URL || 'http://localhost:8000',
    ollama: process.env.OLLAMA_URL || 'http://localhost:11434',
    laya: process.env.LAYA_URL || 'http://127.0.0.1:8001',
};
const ROUTER_DOWN_MODEL = 'fallback-openrouter'; // free tier with no size cap, when the Router can't be reached
const ROUTER_DOWN_TOOLS_MODEL = 'fallback-openrouter-tools'; // same, for requests that need tool calls
// Claude Code asks for more output than Groq's 65,536 limit, which fails every
// Groq call and pushes everything down the fallback chain. 32k fits every tier.
const MAX_OUTPUT_TOKENS = 32768;

function capMaxTokens(value) {
    return typeof value === 'number' ? Math.min(value, MAX_OUTPUT_TOKENS) : value;
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
 */
async function routeModel(body) {
    const { messages } = body;
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const threshold = deriveThreshold(messages);
    try {
        const res = await fetch(`${ROUTER_URL}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: latestUserText(messages), threshold, tokens: estimateTokens(body), tools: hasTools }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { model, win_rate } = await res.json();
        return { model, threshold, winRate: win_rate, tools: hasTools };
    } catch (err) {
        const model = hasTools ? ROUTER_DOWN_TOOLS_MODEL : ROUTER_DOWN_MODEL;
        console.warn(`Router unavailable (${err.message}); using ${model}`);
        return { model, threshold, winRate: null, tools: hasTools, routerError: err.message };
    }
}

function logRoute(path, { model, threshold, winRate, reason }) {
    if (reason) {
        console.log(`${path} → ${model} (pinned: ${reason})`);
    } else {
        console.log(`${path} → ${model} (threshold ${threshold}, strong win rate ${winRate ?? 'n/a'})`);
    }
}

/**
 * Token counting (opt‑in). When enabled we log estimated in/out tokens and
 * feed the actual output count back into the correction factor so the estimate
 * learns from real data.
 */
function logTokens(req, label) {
    if (!isEnabled) return;
    const inText = JSON.stringify(req.body);
    const inTok = countTokens(inText);
    console.info(`[tokens] ${label} in=${inTok}`);
    const oldSend = res.send;
    res.send = function (body) {
        try {
            const outText = typeof body === 'string' ? body : JSON.stringify(body);
            const outTok = countTokens(outText);
        } catch {}
        return oldSend.call(this, body);
    };
}

// Everything goes to the Gateway (LiteLLM), which speaks both the OpenAI and
// the Anthropic Messages formats and applies the fallback chain.
const toGateway = createProxyMiddleware({
    target: GATEWAY_URL,
    changeOrigin: true,
    on: {
        proxyReq: fixRequestBody,
        proxyRes: (proxyRes, req) => monitor.recordResponse(req.harnessEvent, proxyRes.statusCode, proxyRes.headers),
        error: (err, req) => monitor.recordError(req.harnessEvent, err),
    }
});

// Control UI: monitor the stack and switch the Router's classifier.
app.use('/ui', express.static(path.join(__dirname, 'ui')));

app.get('/ui/api/status', async (req, res) => {
    res.json({ components: await monitor.checkComponents(COMPONENT_URLS), stats: monitor.stats() });
});

app.get('/ui/api/events', (req, res) => {
    res.json(monitor.recentEvents(Math.min(parseInt(req.query.limit, 10) || 50, 200)));
});

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Controls answer only on this machine, and only to JSON: a plain cross-site
// form can't send that without a CORS preflight, so another web page can't
// flip the Router's settings either.
async function forwardToRouter(req, res, routerPath) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return res.status(403).json({ error: 'controls work only from this machine' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
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

app.post('/ui/api/router/backend', (req, res) => forwardToRouter(req, res, '/admin/backend'));
app.post('/ui/api/router/reload', (req, res) => forwardToRouter(req, res, '/admin/reload'));

// OpenAI-compatible agents (Cursor, Aider, Continue, ...)
app.post(['/chat/completions', '/v1/chat/completions'], async (req, res, next) => {
    // Context anchor first, on the raw results, then Headroom compression
    req.body.messages = applyHeadroom(applyContextAnchor(withCavemanOpenAI(req.body.messages || [])));
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    req.body.max_completion_tokens = capMaxTokens(req.body.max_completion_tokens);
    const route = await routeModel(req.body);
    req.body.model = route.model;
    logRoute(req.path, route);
    req.harnessEvent = monitor.recordRoute({
        path: req.path, ...route, tokens: estimateTokens(req.body), prompt: latestUserText(req.body.messages),
    });
    next();
}, toGateway);

// Anthropic Messages API: Claude Code with ANTHROPIC_BASE_URL=http://localhost:3000
app.post('/v1/messages', async (req, res, next) => {
    req.body.messages = applyHeadroom(applyContextAnchor(dropUnsignedThinking(req.body.messages || [])));
    req.body.system = withCavemanAnthropic(req.body.system);
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    const route = await routeModel(req.body);
    req.body.model = route.model;
    logRoute(req.path, route);
    req.harnessEvent = monitor.recordRoute({
        path: req.path, ...route, tokens: estimateTokens(req.body), prompt: latestUserText(req.body.messages),
    });
    next();
}, toGateway);

// Anything else (token counting, model listing) passes through untouched
app.use(toGateway);

if (require.main === module) {
    app.listen(3000, () => console.log('Harness interceptor active on port 3000'));
}

module.exports = { applyHeadroom, headroomCompressText, applyContextAnchor, deriveThreshold, withCavemanAnthropic, dropUnsignedThinking };
