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
const usage = require('./utils/usage');
const { pcmRate, pcmToWav } = require('./utils/audio');
const modelInfo = require('./utils/modelInfo');
const fs = require('fs');
const path = require('path');

const app = express();
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
 */
async function routeModel(body, requested) {
    const { messages } = body;
    const config = settings.get();
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const threshold = config.fixedThreshold ?? deriveThreshold(messages);
    // A client can name a model in the x-harness-model header (the chat page does)
    if (requested) return { model: requested, threshold, winRate: null, tools: hasTools, reason: 'chosen by the client' };
    if (config.pinModel) return { model: config.pinModel, threshold, winRate: null, tools: hasTools, reason: 'pinned in settings' };
    try {
        const res = await fetch(`${ROUTER_URL}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: latestUserText(messages), threshold, tokens: estimateTokens(body), tools: hasTools }),
            signal: AbortSignal.timeout(config.routerTimeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { model, win_rate } = await res.json();
        return { model, threshold, winRate: win_rate, tools: hasTools };
    } catch (err) {
        const model = hasTools ? config.routerDownToolsModel : config.routerDownModel;
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

// Everything goes to the Gateway (LiteLLM), which speaks both the OpenAI and
// the Anthropic Messages formats and applies the fallback chain.
const toGateway = createProxyMiddleware({
    target: GATEWAY_URL,
    changeOrigin: true,
    on: {
        proxyReq: (proxyReq, req, res) => {
            for (const [name, value] of Object.entries(gatewayAuth)) proxyReq.setHeader(name, value);
            fixRequestBody(proxyReq, req, res);
        },
        proxyRes: (proxyRes, req) => {
            monitor.recordResponse(req.harnessEvent, proxyRes.statusCode, proxyRes.headers);
            recordUsage(req, proxyRes);
            proxyRes.on('end', () => monitor.recordFinish(req.harnessEvent));
        },
        error: (err, req) => monitor.recordError(req.harnessEvent, err),
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

// Controls answer only on this machine, and only to JSON: a plain cross-site
// form can't send that without a CORS preflight, so another web page can't
// change settings either.
function localJsonOnly(req, res, next) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return res.status(403).json({ error: 'controls work only from this machine' });
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
app.get('/ui/api/model-info', async (req, res) => {
    if (modelInfoCache.body && Date.now() - modelInfoCache.at < 5 * 60 * 1000) return res.json(modelInfoCache.body);
    let body;
    try {
        const upstream = await fetch(`${GATEWAY_URL}/v1/model/info`, { headers: gatewayAuth, signal: AbortSignal.timeout(3000) });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        body = { source: 'gateway', models: modelInfo.fromGatewayInfo((await upstream.json()).data) };
        modelInfoCache = { at: Date.now(), body };
    } catch {
        let text = '';
        try { text = fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'); } catch {}
        body = { source: 'config.yaml', models: modelInfo.fromConfig(text) };
    }
    res.json(body);
});

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

// Context anchor first, on the raw results, then Headroom compression
function compressToolResults(messages) {
    const { headroom, contextAnchor } = settings.get();
    const anchored = contextAnchor ? applyContextAnchor(messages) : messages;
    return headroom ? applyHeadroom(anchored) : anchored;
}

// Transforms the Interceptor applied to this request, for the live feed
function activeTransforms() {
    const { caveman, headroom, contextAnchor } = settings.get();
    return [caveman && 'caveman', headroom && 'headroom', contextAnchor && 'context anchor'].filter(Boolean);
}

async function routeAndRecord(req, res) {
    const clientId = req.get('x-harness-request-id');
    const prompt = latestUserText(req.body.messages);
    monitor.recordRouting({ path: req.path, clientId, prompt });
    const started = Date.now();
    const route = await routeModel(req.body, req.get('x-harness-model'));
    req.body.model = route.model;
    logRoute(req.path, route);
    req.harnessClient = usage.clientOf(req);
    req.harnessInputEstimate = Math.ceil(JSON.stringify(req.body.messages || []).length / 4)
        + Math.ceil(JSON.stringify(req.body.system || '').length / 4)
        + Math.ceil(JSON.stringify(req.body.tools || []).length / 4);
    req.harnessEvent = monitor.recordRoute({
        path: req.path, ...route, tokens: estimateTokens(req.body), prompt, clientId,
        transforms: activeTransforms(), routeMs: Date.now() - started,
    });
    // Tell the client where its request went (the chat page shows it)
    res.set('x-harness-event', String(req.harnessEvent.id));
    res.set('x-harness-model', route.model);
    res.set('x-harness-route', route.reason || (route.routerError ? 'router down'
        : `win rate ${route.winRate} vs threshold ${route.threshold}`));
}

// OpenAI-compatible agents (Cursor, Aider, Continue, ...) and the chat page
app.post(['/chat/completions', '/v1/chat/completions'], async (req, res, next) => {
    const messages = req.body.messages || [];
    req.body.messages = compressToolResults(settings.get().caveman ? withCavemanOpenAI(messages) : messages);
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    req.body.max_completion_tokens = capMaxTokens(req.body.max_completion_tokens);
    await routeAndRecord(req, res);
    next();
}, toGateway);

// Anthropic Messages API: Claude Code with ANTHROPIC_BASE_URL=http://localhost:3000
app.post('/v1/messages', async (req, res, next) => {
    req.body.messages = compressToolResults(dropUnsignedThinking(req.body.messages || []));
    if (settings.get().caveman) req.body.system = withCavemanAnthropic(req.body.system);
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    await routeAndRecord(req, res);
    next();
}, toGateway);

// Anything else (token counting, model listing) passes through untouched
app.use(toGateway);

if (require.main === module) {
    app.listen(3000, () => console.log('Harness interceptor active on port 3000'));
}

module.exports = { applyHeadroom, headroomCompressText, applyContextAnchor, deriveThreshold, withCavemanAnthropic, dropUnsignedThinking };
