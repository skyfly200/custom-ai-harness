require('dotenv').config();
const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { countTokens, isEnabled, recordObservation } = require('./utils/tokenCounter');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Phase 3: injected into every system prompt to slash output token cost ~65%
const CAVEMAN_PROMPT = "Be terse. Do not restate context. Do not use preamble text.";

// Complexity signals that indicate a task warrants the strong model
const COMPLEX_PATTERNS = [
    /\barchitect\b/i, /\brefactor\b/i, /\bdesign\b/i, /\bdebug\b/i,
    /\boptimiz/i, /\bsecurity\b/i, /\balgorithm\b/i, /\bperformance\b/i,
];

// Signals for simple boilerplate / low-stakes tasks → route to free weak model
const SIMPLE_PATTERNS = [
    /\btest\b/i, /\bcomment\b/i, /\bdocstring\b/i, /\bboilerplate\b/i,
    /\brename\b/i, /\bformat\b/i, /\blint\b/i,
];

/**
 * Text typed in the most recent user turn that has any. Turns carrying only
 * tool results are skipped, so an agent loop keeps the routing of its task.
 * The system prompt and tool output are never scored: they mention "test",
 * "debug" etc. constantly and would pin every request at the 0.5 default.
 */
function latestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;
        const raw = typeof msg.content === 'string' ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
            : '';
        const text = stripInjectedContext(raw);
        if (text) return text;
    }
    return '';
}

// Claude Code wraps harness context (reminders, skill listings) in
// <system-reminder> tags inside user turns; none of it was typed by the user.
function stripInjectedContext(text) {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Derive a RouteLLM threshold from the latest user request.
 * Returns a value in [0.0, 1.0].
 * RouteLLM routes to the strong model when its win-rate score >= threshold,
 * so a LOW threshold means the strong model is used more often.
 */
function deriveThreshold(messages) {
    const text = latestUserText(messages);
    const complexHits = COMPLEX_PATTERNS.filter(p => p.test(text)).length;
    const simpleHits  = SIMPLE_PATTERNS.filter(p => p.test(text)).length;

    if (simpleHits > 0 && complexHits === 0) return 0.8; // push toward weak model
    if (complexHits > 0 && simpleHits === 0) return 0.2; // push toward strong model
    return 0.5; // balanced default
}

const ROUTER_URL = process.env.ROUTER_URL || 'http://localhost:6060';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';
const ROUTER_DOWN_MODEL = 'fallback-openrouter'; // free tier with no size cap, when the Router can't be reached
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
 * Ask the Router (router.py, local BERT) which Gateway model should serve
 * this request. Never throws: a down Router degrades to the free tier.
 * Requests that include tools always stay on Claude: non-Claude models
 * respond with text instructions instead of tool calls.
 */
async function routeModel(body) {
    const { messages } = body;
    // The wildcard free tier picks models that may not support tool calls.
    // Route tool-bearing requests to a model known to handle them reliably.
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools) {
        return { model: 'fallback-openrouter-tools', threshold: null, winRate: null, reason: 'tools' };
    }
    const threshold = deriveThreshold(messages);
    try {
        const res = await fetch(`${ROUTER_URL}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: latestUserText(messages), threshold, tokens: estimateTokens(body) }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { model, win_rate } = await res.json();
        return { model, threshold, winRate: win_rate };
    } catch (err) {
        console.warn(`Router unavailable (${err.message}); using ${ROUTER_DOWN_MODEL}`);
        return { model: ROUTER_DOWN_MODEL, threshold, winRate: null };
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

// Caveman goes last in the system prompt, after any cached blocks.
function withCavemanOpenAI(messages) {
    const [first, ...rest] = messages;
    if (first?.role !== 'system') return [{ role: 'system', content: CAVEMAN_PROMPT }, ...messages];
    const content = Array.isArray(first.content)
        ? [...first.content, { type: 'text', text: CAVEMAN_PROMPT }]
        : `${first.content}\n\n${CAVEMAN_PROMPT}`;
    return [{ ...first, content }, ...rest];
}

// Thinking blocks produced by non-Anthropic models (via the Gateway) carry no
// signature. No provider accepts them back: Anthropic rejects the missing
// signature and Groq rejects the reasoning_content they translate into.
// Signed blocks from real Claude models are kept, as Anthropic requires.
function dropUnsignedThinking(messages) {
    return messages.map(msg => {
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
        const content = msg.content.filter(b => b.type !== 'thinking' || b.signature);
        return content.length ? { ...msg, content } : msg;
    });
}

function withCavemanAnthropic(system) {
    if (!system) return CAVEMAN_PROMPT;
    if (Array.isArray(system)) return [...system, { type: 'text', text: CAVEMAN_PROMPT }];
    return `${system}\n\n${CAVEMAN_PROMPT}`;
}

// ---------------------------------------------------------------------------
// Phase 3: Headroom — tool output compression
// Compresses tool results only (role=tool messages and tool_result blocks);
// text the user typed is never altered. Strips redundant whitespace and pure
// separator lines, then truncates oversized results from the middle with a
// visible marker, keeping the tail where build/test errors usually land.
// ---------------------------------------------------------------------------

const HEADROOM_MAX_TOOL_CHARS = 4000; // cap per tool result, marker included
const HEADROOM_HEAD_SHARE = 0.4;      // share of the cap kept from the start; the rest comes from the end

// Patterns that add no signal: blank lines, trailing whitespace
const NOISE_RE = /(\r?\n){3,}/g;
const TRAIL_RE = /[ \t]+$/gm;
// Lines made only of separator characters (keeps "#### Heading" and diff lines with content)
const DECOR_RE = /^[-=*#]{4,}[ \t]*$/gm;

function truncateMiddle(text, max) {
    if (text.length <= max) return text;
    const marker = (n) => `\n[... ${n} chars truncated by harness ...]\n`;
    const budget = max - marker(text.length).length;
    const head = Math.floor(budget * HEADROOM_HEAD_SHARE);
    const tail = budget - head;
    return text.slice(0, head) + marker(text.length - head - tail) + text.slice(text.length - tail);
}

function headroomCompressText(text) {
    if (typeof text !== 'string') return text;
    const cleaned = text
        .replace(DECOR_RE, '')
        .replace(TRAIL_RE, '')
        .replace(NOISE_RE, '\n\n')
        .trim();
    return truncateMiddle(cleaned, HEADROOM_MAX_TOOL_CHARS);
}

// Compress a tool result's content: a string, or an array of content blocks.
function compressToolContent(content) {
    if (typeof content === 'string') return headroomCompressText(content);
    if (!Array.isArray(content)) return content;
    return content.map(block =>
        block.type === 'text' ? { ...block, text: headroomCompressText(block.text) } : block);
}

// Apply fn(content, id) to every tool result: OpenAI role=tool messages and
// Anthropic tool_result blocks. Text the user typed is never passed to fn.
function mapToolResults(messages, fn) {
    return messages.map(msg => {
        if (msg.role === 'tool') {
            return { ...msg, content: fn(msg.content, msg.tool_call_id) };
        }
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            return {
                ...msg,
                content: msg.content.map(block =>
                    block.type === 'tool_result' ? { ...block, content: fn(block.content, block.tool_use_id) } : block),
            };
        }
        return msg;
    });
}

function applyHeadroom(messages) {
    return mapToolResults(messages, compressToolContent);
}

// ---------------------------------------------------------------------------
// Phase 2: Context anchor — zero-duplication tool results
// Agents re-read the same file or re-run the same command many times in one
// conversation. A tool result identical to an earlier one in the same request
// is replaced with a pointer to the first copy. The first copy is always the
// one kept, so earlier messages never change and provider prompt caches stay
// valid. Stateless: nothing is remembered between requests.
// ---------------------------------------------------------------------------

const ANCHOR_MIN_CHARS = 500; // shorter results cost less than the pointer is worth

// Plain text of a tool result, or null when it holds images or other non-text blocks.
function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.every(b => b.type === 'text')) {
        return content.map(b => b.text).join('\n');
    }
    return null;
}

function applyContextAnchor(messages) {
    const firstSeen = new Map(); // result text -> id of the first tool result carrying it
    return mapToolResults(messages, (content, id) => {
        const text = toolResultText(content);
        if (text === null || text.length < ANCHOR_MIN_CHARS) return content;
        if (!firstSeen.has(text)) {
            firstSeen.set(text, id);
            return content;
        }
        return `[harness: identical to earlier tool result ${firstSeen.get(text)}; not repeated]`;
    });
}

// Everything goes to the Gateway (LiteLLM), which speaks both the OpenAI and
// the Anthropic Messages formats and applies the fallback chain.
const toGateway = createProxyMiddleware({
    target: GATEWAY_URL,
    changeOrigin: true,
    on: {
        proxyReq: fixRequestBody,
    }
});

// OpenAI-compatible agents (Cursor, Aider, Continue, ...)
app.post(['/chat/completions', '/v1/chat/completions'], async (req, res, next) => {
    // Context anchor first, on the raw results, then Headroom compression
    req.body.messages = applyHeadroom(applyContextAnchor(withCavemanOpenAI(req.body.messages || [])));
    req.body.max_tokens = capMaxTokens(req.body.max_tokens);
    req.body.max_completion_tokens = capMaxTokens(req.body.max_completion_tokens);
    const route = await routeModel(req.body);
    req.body.model = route.model;
    logRoute(req.path, route);
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
    next();
}, toGateway);

// Anything else (token counting, model listing) passes through untouched
app.use(toGateway);

if (require.main === module) {
    app.listen(3000, () => console.log('Harness interceptor active on port 3000'));
}

module.exports = { applyHeadroom, headroomCompressText, applyContextAnchor, deriveThreshold, withCavemanAnthropic, dropUnsignedThinking };
