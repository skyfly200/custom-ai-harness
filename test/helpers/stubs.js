// Shared fake servers for tests. Each returns an http.Server; call `.listen(0, '127.0.0.1', cb)` as usual.
const http = require('node:http');

// An OpenAI-style Gateway that answers every request with a one-line reply.
// `onRequest(req, body)` sees each request with its parsed JSON body (null when empty or not JSON).
function fakeGateway(onRequest = () => {}, content = 'hi') {
    return http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            let body = null;
            try { body = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
            onRequest(req, body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
        });
    });
}

// A Gateway for agent runs: each chat request gets the next entry of `replies`, a list of
// [tool, args] calls. /v1/guard allows everything; /v1/jev/ask answers `jev(text, question)`.
// `calls` records every request as { url, body }. Running out of replies is a 500; a `jev` that throws is a 502.
function scriptedGateway({ replies = [], jev = () => false } = {}) {
    const guard = require('../../utils/guard');
    const calls = [];
    const server = http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', async () => {
            const body = data ? JSON.parse(data) : null;
            calls.push({ url: req.url, body });
            res.setHeader('content-type', 'application/json');
            if (req.url === '/ui/api/model-info') return res.end(JSON.stringify({ models: {} }));
            if (req.url === '/v1/guard') return res.end(JSON.stringify(await guard.check(body, { jev: false })));
            if (req.url === '/v1/jev/ask') {
                let answer;
                try { answer = Boolean(jev(body.text, body.question)); } catch (err) { res.statusCode = 502; return res.end(JSON.stringify({ error: err.message })); }
                return res.end(JSON.stringify({ mode: 'bool', score: answer ? 0.9 : 0.1, answer, windows: 1, scanned: 1, truncated: false, best: { line: 1, score: answer ? 0.9 : 0.1 } }));
            }
            const next = replies.shift();
            if (!next) { res.statusCode = 500; return res.end('{"error":"script ran out"}'); }
            res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 2 },
                choices: [{ message: { role: 'assistant', content: '', tool_calls: next.map(([name, args], i) => ({ id: `c${calls.length}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }));
        });
    });
    return { server, calls, replies };
}

module.exports = { fakeGateway, scriptedGateway };
