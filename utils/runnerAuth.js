// The task runner calling the Interceptor on behalf of a person, on a hosted server (RUNNER_HOSTED=1 on the
// runner). It proves itself with RUNNER_TOKEN (shared by the launcher with both processes) from this machine,
// names the run's owner, and may use only the few paths a run needs. Requests then count as that person, so
// their credit or own OpenRouter credential pays, not the server owner's key.
'use strict';

const crypto = require('crypto');

const ALLOWED = [
    ['POST', /^\/v1\/chat\/completions$/],
    ['POST', /^\/v1\/run-keys$/],
    ['DELETE', /^\/v1\/run-keys\/[^/]+$/],
    ['POST', /^\/v1\/guard$/],
    ['POST', /^\/v1\/batch$/],
    ['GET', /^\/v1\/batch\/[^/]+$/],
    ['GET', /^\/ui\/api\/model-info$/],
];
const isLoopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test((req.socket && req.socket.remoteAddress) || '');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function middleware(findUser, token = () => process.env.RUNNER_TOKEN || '') {
    return (req, res, next) => {
        const sent = req.headers['x-runner-token'];
        const want = token();
        if (!sent || !want) return next();
        if (!isLoopback(req) || !ALLOWED.some(([m, re]) => m === req.method && re.test(req.path)) || !crypto.timingSafeEqual(digest(sent), digest(want))) {
            return res.status(401).json({ error: 'the runner token is not valid for this request' });
        }
        req.harnessRunner = true;
        const owner = req.headers['x-harness-run-owner'];
        const user = owner && findUser && findUser(String(owner));
        if (user) { req.harnessUser = user; req.harnessLogin = true; }
        next();
    };
}

module.exports = { middleware };
