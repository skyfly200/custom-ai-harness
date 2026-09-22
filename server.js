const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

app.post(['/chat/completions', '/v1/chat/completions'], (req, res, next) => {
    const messages = req.body.messages || [];
    const hasSystem = messages.length > 0 && messages[0].role === 'system';

    if (hasSystem) {
        messages[0].content += `\n\n${CAVEMAN_PROMPT}`;
    } else {
        messages.unshift({ role: 'system', content: CAVEMAN_PROMPT });
    }

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