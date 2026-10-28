// The server calling its own API as a person (a scheduled message sent while no page is open).
// Each process makes a random secret; a request from this machine that carries a signature of
// "name" made with it is treated as that person, for POST /v1/chat/completions only. The secret
// never leaves the process, so no header from outside can forge it.
const crypto = require('crypto');

const secret = crypto.randomBytes(32);
const PATHS = new Set(['/v1/chat/completions']);
const sign = (name) => crypto.createHmac('sha256', secret).update(String(name)).digest('hex');

/** Headers that make a loopback request count as `name`. */
const headersFor = (name) => ({ 'x-harness-internal-user': name, 'x-harness-internal-sig': sign(name) });

const isLoopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test((req.socket && req.socket.remoteAddress) || '');

/** Sets req.harnessInternal (and req.harnessUser when `findUser` knows the name) for a valid signature. */
function middleware(findUser) {
    return (req, res, next) => {
        const name = req.headers['x-harness-internal-user'];
        const sig = req.headers['x-harness-internal-sig'];
        if (!name || !sig) return next();
        const ok = isLoopback(req) && req.method === 'POST' && PATHS.has(req.path) && typeof sig === 'string'
            && sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(name)));
        if (!ok) return res.status(401).json({ error: 'bad internal signature' });
        req.harnessInternal = true;
        const user = findUser && findUser(String(name));
        if (user) { req.harnessUser = user; req.harnessLogin = true; }
        next();
    };
}

module.exports = { headersFor, middleware, sign };
