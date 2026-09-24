require('dotenv').config();
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
 * Text typed in the most recent user turn that has any. Turns carrying only
 * tool results are skipped, so an agent loop keeps the routing of its task.
 * The system prompt and tool output are never scored: they mention "test",
 * "debug" etc. constantly and would pin every request at the 0.5 default.
 */
function latestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
            if (text) return text;
        }
    }
    return '';
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

app.post(['/chat/completions', '/v1/chat/completions'], (req, res, next) => {
    let messages = req.body.messages || [];
    const hasSystem = messages.length > 0 && messages[0].role === 'system';

    if (hasSystem) {
        messages[0].content += `\n\n${CAVEMAN_PROMPT}`;
    } else {
        messages.unshift({ role: 'system', content: CAVEMAN_PROMPT });
    }

    // Context anchor first, on the raw results, then Headroom compression
    messages = applyHeadroom(applyContextAnchor(messages));
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

if (require.main === module) {
    app.listen(3000, () => console.log('Harness interceptor active on port 3000'));
}

module.exports = { applyHeadroom, headroomCompressText, applyContextAnchor, deriveThreshold };