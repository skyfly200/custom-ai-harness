const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');

const app = express();
// Increase the JSON payload limit to handle large context windows from Claude Code
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const CAVEMAN_PROMPT = "Be terse. Do not restate context. Do not use preamble text.";

// Use app.post instead of app.use to prevent Express from stripping the path
app.post(['/chat/completions', '/v1/chat/completions'], (req, res, next) => {
    const messages = req.body.messages || [];
    const hasSystem = messages.length > 0 && messages[0].role === 'system';
    
    // Inject Caveman output compression
    if (hasSystem) {
        messages[0].content += `\n\n${CAVEMAN_PROMPT}`;
    } else {
        messages.unshift({ role: 'system', content: CAVEMAN_PROMPT });
    }

    // Direct the payload to RouteLLM's intelligent classifier
    // Note: RouteLLM typically expects a specific format like "router-mf-0.5" 
    req.body.model = "router-bert-0.5"; 

    next();
}, createProxyMiddleware({
    target: 'http://localhost:6060', // RouteLLM server endpoint
    changeOrigin: true,
    pathRewrite: (path, req) => '/v1/chat/completions', // Force the correct target endpoint
    on: {
        proxyReq: fixRequestBody,
    }
}));

app.listen(3000, () => console.log('Harness interceptor active on port 3000'));