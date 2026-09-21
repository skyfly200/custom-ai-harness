const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');

const app = express();
app.use(express.json());

const CAVEMAN_PROMPT = "Be terse. Do not restate context. Do not use preamble text.";

app.use('/chat/completions', (req, res, next) => {
    const messages = req.body.messages || [];
    const hasSystem = messages.length > 0 && messages[0].role === 'system';
    
    // Inject Caveman output compression
    if (hasSystem) {
        messages[0].content += `\n\n${CAVEMAN_PROMPT}`;
    } else {
        messages.unshift({ role: 'system', content: CAVEMAN_PROMPT });
    }

    // Direct the payload to RouteLLM's intelligent classifier
    req.body.model = "route-llm"; 

    next();
}, createProxyMiddleware({
    target: 'http://localhost:6060', // RouteLLM server endpoint
    changeOrigin: true,
    on: {
        proxyReq: fixRequestBody,
    }
}));

app.listen(3000, () => console.log('Harness interceptor active on port 3000'));