const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');

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
 * Derive a RouteLLM threshold from message content.
 * Returns a value in [0.0, 1.0]; lower = more likely to use weak model.
 * RouteLLM routes to the strong model when complexity score > threshold,
 * so a LOW threshold means the strong model is used more often.
 */
function deriveThreshold(messages) {
    const text = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join(' ');
    const complexHits = COMPLEX_PATTERNS.filter(p => p.test(text)).length;
    const simpleHits  = SIMPLE_PATTERNS.filter(p => p.test(text)).length;

    if (simpleHits > 0 && complexHits === 0) return 0.8; // push toward weak model
    if (complexHits > 0 && simpleHits === 0) return 0.2; // push toward strong model
    return 0.5; // balanced default
}

/**
 * Build a valid three-part RouteLLM model string.
 * Format required: router-bert-<threshold>
 * Prevents ValueError crashes in the RouteLLM parser.
 */
function buildRouteLLMModel(threshold) {
    const clamped = Math.min(1.0, Math.max(0.0, threshold));
    return `router-bert-${clamped.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Phase 3: Headroom — tool output / file / log compression
// Intercepts tool_result and tool messages before they are forwarded,
// stripping redundant whitespace, truncating oversized payloads, and removing
// boilerplate patterns that contribute nothing to model understanding.
// Targets up to 92% reduction on code-search and file-read tool outputs.
// ---------------------------------------------------------------------------

const HEADROOM_MAX_TOOL_CHARS = 4000; // hard cap per tool result block
const HEADROOM_MAX_ARRAY_ITEMS = 20;  // cap repeated list items (e.g. grep results)

// Patterns that add no signal: blank lines, trailing whitespace, repeated dashes/equals
const NOISE_RE = /(\r?\n){3,}/g;
const TRAIL_RE = /[ \t]+$/gm;
// Long runs of decoration characters used as visual separators
const DECOR_RE = /^[-=*#]{4,}.*$/gm;

function headroomCompressText(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(DECOR_RE, '')
        .replace(TRAIL_RE, '')
        .replace(NOISE_RE, '\n\n')
        .trim()
        .slice(0, HEADROOM_MAX_TOOL_CHARS);
}

function headroomCompressContent(content) {
    if (typeof content === 'string') return headroomCompressText(content);
    if (!Array.isArray(content)) return content;

    const trimmed = content.slice(0, HEADROOM_MAX_ARRAY_ITEMS);
    return trimmed.map(block => {
        if (block.type === 'text')        return { ...block, text: headroomCompressText(block.text) };
        if (block.type === 'tool_result') return { ...block, content: headroomCompressContent(block.content) };
        return block;
    });
}

function applyHeadroom(messages) {
    return messages.map(msg => {
        // Compress tool result messages (role=tool) and any user turn carrying tool_result blocks
        if (msg.role === 'tool' || msg.role === 'user') {
            return { ...msg, content: headroomCompressContent(msg.content) };
        }
        return msg;
    });
}

app.post(['/chat/completions', '/v1/chat/completions'], (req, res, next) => {
    let messages = req.body.messages || [];
    const hasSystem = messages.length > 0 && messages[0].role === 'system';

    if (hasSystem) {
        messages[0].content += `\n\n${CAVEMAN_PROMPT}`;
    } else {
        messages.unshift({ role: 'system', content: CAVEMAN_PROMPT });
    }

    // Headroom: compress tool outputs and file payloads before forwarding
    messages = applyHeadroom(messages);
    req.body.messages = messages;

    const threshold = deriveThreshold(messages);
    req.body.model = buildRouteLLMModel(threshold);

    next();
}, createProxyMiddleware({
    target: 'http://localhost:6060', // RouteLLM BERT classifier (port 6060)
    changeOrigin: true,
    pathRewrite: () => '/v1/chat/completions',
    on: {
        proxyReq: fixRequestBody,
    }
}));

app.listen(3000, () => console.log('Harness interceptor active on port 3000'));