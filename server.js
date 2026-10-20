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
const settings = require('./utils/settings');
const profiles = require('./utils/profiles');
const usage = require('./utils/usage');
const { pcmRate, pcmToWav } = require('./utils/audio');
const modelInfo = require('./utils/modelInfo');
const cacheMarkers = require('./utils/cacheMarkers');
const openrouterCatalog = require('./utils/openrouterCatalog');
const gatewayConfig = require('./utils/gatewayConfig');
const gatewayGuard = require('./utils/gatewayGuard');
const { McpManager } = require('./utils/mcp');
const repoTools = require('./utils/repoTools');
const { requirePassword } = require('./utils/access');
const fs = require('fs');
const path = require('path');

const app = express();
// HARNESS_PASSWORD locks every page and API (see utils/access.js); unset, all stay open
const HARNESS_PASSWORD = process.env.HARNESS_PASSWORD || '';
app.use(requirePassword(HARNESS_PASSWORD));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const ROUTER_URL = process.env.ROUTER_URL || 'http://localhost:6060';
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
 * With a named routing (`profile`, utils/profiles.js) the Router only scores
 * the request and the profile's own outputs pick the model.
 */
async function routeModel(body, requested, profile) {
    const { messages } = body;
    const config = settings.get();
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const fixed = profile ? profile.threshold : config.fixedThreshold;
    const threshold = fixed ?? deriveThreshold(messages);
    const base = { threshold, winRate: null, tools: hasTools, ...(profile && { profile: profile.name }) };
    // A client can name a model in the x-harness-model header (the chat page does)
    if (requested) return { ...base, model: requested, reason: 'chosen by the client' };
    if (profile?.pin) return { ...base, model: profile.pin, reason: `pinned in routing ${profile.name}` };
    if (!profile && config.pinModel) return { ...base, model: config.pinModel, reason: 'pinned in settings' };
    try {
        const tokens = estimateTokens(body);
        const res = await fetch(`${ROUTER_URL}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: latestUserText(messages), threshold, tokens, tools: hasTools }),
            signal: AbortSignal.timeout(config.routerTimeoutMs),
        });
        if (!res.ok) {
            // the Router says why its classifier failed (an HTTP error from Jev, a missing key, ...)
            const detail = gatewayGuard.errorMessage(await res.text().catch(() => ''));
            throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
        }
        const { model, win_rate } = await res.json();
        return { ...base, model: profile ? profiles.pick(profile, win_rate, threshold, tokens, hasTools) : model, winRate: win_rate };
    } catch (err) {
        const from = profile || { down: config.routerDownModel, downTools: config.routerDownToolsModel };
        const model = hasTools ? from.downTools : from.down;
        console.warn(`Router unavailable (${err.message}); using ${model}`);
        return { ...base, model, routerError: err.message };
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

// Token counts from a routed request's reply, for the Usage page. Failed
// calls carry no usage and aren't counted.
function recordUsage(req, proxyRes) {
    const event = req.harnessEvent;
    if (!event || proxyRes.statusCode >= 400) return;
    usage.tap(proxyRes, ({ usage: counts, outputChars }) => {
        const row = usage.record({
            client: req.harnessClient,
            route: usage.routeOf(event),
            model: event.model,
            servedBy: event.servedBy,
            usage: counts,
            estimate: { input: req.harnessInputEstimate, outputChars },
        });
        monitor.recordUsage(event, row);
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

// Everything goes to the Gateway (LiteLLM), which speaks both the OpenAI and
// the Anthropic Messages formats and applies the fallback chain. The guard
// fails a request the Gateway leaves hanging, so clients get an error instead.
const toGateway = createProxyMiddleware({
    target: GATEWAY_URL,
    changeOrigin: true,
    on: {
        proxyReq: (proxyReq, req, res) => {
            for (const [name, value] of Object.entries(gatewayAuth)) proxyReq.setHeader(name, value);
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
            res.on('close', () => {
                if (!res.writableFinished && !req.harnessFailed) monitor.recordCancel(req.harnessEvent);
            });
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
        error: (err, req, res) => {
            req.harnessGuard?.clear();
            if (req.harnessFailed) return; // the guard already answered
            req.harnessFailed = true;
            const { kind, message } = gatewayGuard.answerProxyError(err, req, res);
            console.warn(`${req.path}: ${message}`);
            monitor.recordError(req.harnessEvent, new Error(message), kind);
        },
    }
});

// Control UI: monitor the stack and switch the Router's classifier.
app.use('/ui', express.static(path.join(__dirname, 'ui')));

app.get('/ui/api/status', async (req, res) => {
    res.json({ components: await monitor.checkComponents(COMPONENT_URLS), stats: monitor.stats() });
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
    if (!LOOPBACK.has(req.socket.remoteAddress) && !req.harnessAuthenticated) {
        return res.status(403).json({ error: 'controls work only from this machine, or with HARNESS_PASSWORD set' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
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

// Named routings (utils/profiles.js): the routing editor saves them, the chat
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
    try {
        const upstream = await fetch(`${GATEWAY_URL}/v1/model/info`, { headers: gatewayAuth, signal: AbortSignal.timeout(3000) });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        const body = { source: 'gateway', models: modelInfo.fromGatewayInfo((await upstream.json()).data) };
        modelInfoCache = { at: Date.now(), body };
        return body;
    } catch {
        let text = '';
        try { text = fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'); } catch {}
        return { source: 'config.yaml', models: modelInfo.fromConfig(text) };
    }
}
app.get('/ui/api/model-info', async (req, res) => res.json(await getModelInfo()));

// Read-aloud for the chat page through an OpenAI-compatible speech endpoint
// (POST {TTS_URL}/audio/speech). With an OpenRouter key and no TTS_URL it uses
// OpenRouter's speech models; TTS_URL points it at Kokoro-FastAPI, OpenAI, or
// the Gateway instead. The chat page picks the model and voice; TTS_MODEL and
// TTS_VOICE are only the defaults.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const TTS_URL = (process.env.TTS_URL || (process.env.OPENROUTER_API_KEY ? OPENROUTER_URL : '')).replace(/\/+$/, '');
const TTS_OPENROUTER = /openrouter\.ai/.test(TTS_URL);
const TTS_MODEL = process.env.TTS_MODEL || (TTS_OPENROUTER ? 'fish-audio/s2.1-pro-free:free' : 'kokoro');
const TTS_VOICE = process.env.TTS_VOICE ?? (TTS_OPENROUTER ? '' : 'af_heart'); // empty sends none: the model's default voice
const TTS_KEY = process.env.TTS_API_KEY
    || (TTS_URL.startsWith(GATEWAY_URL) ? GATEWAY_KEY : '')
    || (TTS_OPENROUTER ? process.env.OPENROUTER_API_KEY || '' : '');
const TTS_INSTRUCTIONS = process.env.TTS_INSTRUCTIONS || ''; // tone and pacing, for models that take it
const TTS_VOICES = (process.env.TTS_VOICES || '').split(',').map(v => v.trim()).filter(Boolean);
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const ttsHeaders = () => ({ 'content-type': 'application/json', ...(TTS_KEY ? { authorization: `Bearer ${TTS_KEY}` } : {}) });
const voiceIds = (list) => (list || []).map(v => (typeof v === 'string' ? v : v.id || v.voice_id || v.name)).filter(Boolean);

// Speech models the server offers, with their voices: [{ id, name, voices, free }]
let ttsModelCache = { at: 0, models: null };
async function listTtsModels() {
    if (ttsModelCache.models && Date.now() - ttsModelCache.at < 10 * 60 * 1000) return ttsModelCache.models;
    let models = [];
    if (TTS_OPENROUTER) {
        try {
            const upstream = await fetch(`${TTS_URL}/models?output_modalities=speech`, { headers: ttsHeaders(), signal: AbortSignal.timeout(8000) });
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
            const upstream = await fetch(`${TTS_URL}/audio/voices`, { headers: ttsHeaders(), signal: AbortSignal.timeout(3000) });
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
app.get('/ui/api/openrouter/models', async (req, res) => {
    if (openrouterCache.models && Date.now() - openrouterCache.at < 60 * 60 * 1000) return res.json({ models: openrouterCache.models });
    try {
        const key = process.env.OPENROUTER_API_KEY;
        const upstream = await fetch(`${OPENROUTER_URL}/models`, {
            headers: key ? { authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(10000),
        });
        if (!upstream.ok) throw new Error(`OpenRouter answered HTTP ${upstream.status}`);
        const models = openrouterCatalog.fromCatalog(await upstream.json());
        if (!models.length) throw new Error('OpenRouter listed no models');
        openrouterCache = { at: Date.now(), models };
        res.json({ models });
    } catch (err) {
        if (openrouterCache.models) return res.json({ models: openrouterCache.models, stale: true });
        res.status(502).json({ error: `Couldn't load OpenRouter's model list: ${err.message}` });
    }
});

app.get('/ui/api/tts', async (req, res) => {
    if (!TTS_URL) return res.json({ configured: false });
    res.json({ configured: true, model: TTS_MODEL, voice: TTS_VOICE, host: new URL(TTS_URL).host, models: await listTtsModels() });
});

const pcmOnlyModels = new Set(); // models that refused MP3 once

app.post('/ui/api/tts', async (req, res) => {
    if (!TTS_URL) return res.status(404).json({ error: 'No TTS server: add OPENROUTER_API_KEY or TTS_URL to .env' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
    const { text, voice, speed } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const model = typeof req.body.model === 'string' && req.body.model ? req.body.model : TTS_MODEL;
    // the default voice belongs to the default model
    const chosenVoice = (typeof voice === 'string' && voice) || (model === TTS_MODEL ? TTS_VOICE : '');
    const speak = (format) => fetch(`${TTS_URL}/audio/speech`, {
        method: 'POST',
        headers: ttsHeaders(),
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

// Tools for the chat page: MCP servers from mcp-servers.json, and read-only
// tools over a git repo a chat is linked to. The page runs the tool loop: it
// sends the definitions with each request and calls back here to run a call.
const mcp = new McpManager();

app.get('/ui/api/tools', async (req, res) => {
    await mcp.start();
    const status = mcp.status();
    const definitions = {};
    for (const s of status.servers) definitions[s.name] = mcp.definitions(status.servers.filter(o => o.name !== s.name).map(o => o.name));
    res.json({ ...status, definitions, repoDefinitions: repoTools.definitions() });
});

app.post('/ui/api/tools/reload', localJsonOnly, async (req, res) => {
    await mcp.reload();
    res.json(mcp.status());
});

app.post('/ui/api/repo', localJsonOnly, async (req, res) => {
    try {
        res.json(await repoTools.inspect(req.body?.path));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Run one tool call. A failing tool is an answer for the model, not an HTTP error.
app.post('/ui/api/tools/call', localJsonOnly, async (req, res) => {
    const { name, arguments: args, repo } = req.body || {};
    if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name is required' });
    const started = Date.now();
    try {
        let result;
        if (repoTools.isRepoTool(name)) {
            if (!repo) throw new Error('this chat is not linked to a git repo');
            result = { text: await repoTools.call(repo, name, args || {}), isError: false };
        } else {
            await mcp.start();
            result = await mcp.call(name, args || {});
        }
        res.json({ ...result, ms: Date.now() - started });
    } catch (err) {
        res.json({ text: `Error: ${err.message}`, isError: true, ms: Date.now() - started });
    }
});

// The named routing a request asked for with x-harness-profile (null: the default)
function profileOf(req) {
    const id = req.get('x-harness-profile');
    const p = profiles.get(id);
    if (id && !p) console.warn(`Unknown routing "${id}"; using the default`);
    return p;
}

// Which transforms run: the request's routing decides, else the Interceptor settings
function transformsFor(req) {
    const { caveman, headroom, contextAnchor } = req.harnessProfile || settings.get();
    return { caveman, headroom, contextAnchor };
}

// Context anchor first, on the raw results, then Headroom compression
function compressToolResults(req, messages) {
    const { headroom, contextAnchor } = transformsFor(req);
    const anchored = contextAnchor ? applyContextAnchor(messages) : messages;
    return headroom ? applyHeadroom(anchored) : anchored;
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
    const route = await routeModel(req.body, req.get('x-harness-model'), req.harnessProfile);
    route.model = profiles.currentName(route.model);
    req.body.model = route.model;
    logRoute(req.path, route);
    req.harnessClient = usage.clientOf(req);
    req.harnessInputEstimate = Math.ceil(JSON.stringify(req.body.messages || []).length / 4)
        + Math.ceil(JSON.stringify(req.body.system || '').length / 4)
        + Math.ceil(JSON.stringify(req.body.tools || []).length / 4);
    req.harnessEvent = monitor.recordRoute({
        path: req.path, ...route, tokens: estimateTokens(req.body), prompt, clientId,
        transforms: activeTransforms(req), routeMs: Date.now() - started,
    });
    // Tell the client where its request went (the chat page shows it)
    res.set('x-harness-event', String(req.harnessEvent.id));
    res.set('x-harness-model', route.model);
    res.set('x-harness-route', route.reason || (route.routerError ? 'router down'
        : `win rate ${route.winRate} vs threshold ${route.threshold}`));
    if (route.profile) res.set('x-harness-profile', encodeURIComponent(route.profile));
}

// OpenAI-compatible agents (Cursor, Aider, Continue, ...) and the chat page
app.post(['/chat/completions', '/v1/chat/completions'], async (req, res, next) => {
    req.harnessProfile = profileOf(req);
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
    req.harnessProfile = profileOf(req);
    req.body.messages = compressToolResults(req, dropUnsignedThinking(req.body.messages || []));
    if (transformsFor(req).caveman) req.body.system = withCavemanAnthropic(req.body.system);
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    await routeAndRecord(req, res);
    next();
}, toGateway);

// Anything else (token counting, model listing) passes through untouched
app.use(toGateway);

if (require.main === module) {
    app.listen(3000, () => console.log('Harness interceptor active on port 3000'));
    mcp.start().then(() => {
        for (const s of mcp.status().servers) console.log(`MCP server ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ` · ${s.tools.length} tools`}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => mcp.close().finally(() => process.exit(0)));
}

module.exports = { app, mcp, applyHeadroom, headroomCompressText, applyContextAnchor, deriveThreshold, withCavemanAnthropic, dropUnsignedThinking };
