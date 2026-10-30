'use strict';
// {{name}}: a page, a JSON health check and a chat route. The route holds the harness key
// on the server, so the page never sees it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = '{{name}}';
const PORT = Number(process.env.PORT) || 3200;
const HARNESS_URL = (process.env.HARNESS_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const HARNESS_APP_KEY = process.env.HARNESS_APP_KEY || '';
const HARNESS_PROFILE = process.env.HARNESS_PROFILE || '';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 16 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('the message is too long')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('send JSON')); } });
    req.on('error', reject);
  });
}

async function chat(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }); }
  const message = String(body.message || '').trim();
  if (!message) return send(res, 400, { error: 'say something first' });
  if (!HARNESS_APP_KEY) return send(res, 503, { error: 'Set HARNESS_APP_KEY in .env to chat.' });
  try {
    const up = await fetch(`${HARNESS_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${HARNESS_APP_KEY}`,
        ...(HARNESS_PROFILE && { 'x-harness-profile': HARNESS_PROFILE }),
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: message }] }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await up.json().catch(() => ({}));
    if (!up.ok) return send(res, up.status, { error: data.error?.message || data.error || `the harness answered ${up.status}` });
    return send(res, 200, { reply: data.choices?.[0]?.message?.content || '' });
  } catch (err) {
    return send(res, 502, { error: `The harness is not answering (${err.cause?.code || err.message}).` });
  }
}

function page(req, res) {
  const url = req.url.split('?')[0];
  let rel;
  try { rel = url === '/' ? 'index.html' : decodeURIComponent(url.slice(1)); } catch { return send(res, 400, 'bad path', 'text/plain'); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/health') return send(res, 200, { ok: true, name: APP_NAME });
    if (req.method === 'POST' && url === '/api/chat') return chat(req, res);
    if (req.method === 'GET') return page(req, res);
    send(res, 405, { error: 'method not allowed' });
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`${APP_NAME} on http://localhost:${PORT}`));
}

module.exports = { createServer };
