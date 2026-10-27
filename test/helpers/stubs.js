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

module.exports = { fakeGateway };
