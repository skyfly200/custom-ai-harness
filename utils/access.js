// Optional password for the whole harness (HARNESS_PASSWORD), for running it
// on a server other people can reach. Unset, nothing changes: the pages and
// APIs stay open and the controls answer only on this machine.
//
// Browsers get a login box (HTTP Basic, any user name). Agents send the
// password as x-harness-password (Claude Code: ANTHROPIC_CUSTOM_HEADERS),
// or as their API key (Authorization: Bearer, or x-api-key).
const crypto = require('crypto');

const PASSWORD_HEADER = 'x-harness-password';

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

function passwordsFrom(req) {
    const found = [];
    const header = req.headers[PASSWORD_HEADER];
    if (header) found.push(header);
    const auth = req.headers.authorization || '';
    const space = auth.indexOf(' ');
    const scheme = space < 0 ? auth : auth.slice(0, space);
    const token = space < 0 ? '' : auth.slice(space + 1).trim();
    if (/^basic$/i.test(scheme)) {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon >= 0) found.push(decoded.slice(colon + 1));
    } else if (/^bearer$/i.test(scheme) && token) {
        found.push(token);
    }
    if (req.headers['x-api-key']) found.push(req.headers['x-api-key']);
    return found;
}

function requirePassword(password) {
    const want = digest(password);
    const matches = (value) => crypto.timingSafeEqual(digest(value), want);
    return function checkPassword(req, res, next) {
        if (!password) return next();
        if (!passwordsFrom(req).some(matches)) {
            res.set('www-authenticate', 'Basic realm="AI Harness", charset="UTF-8"');
            return res.status(401).json({ error: 'password required (HARNESS_PASSWORD)' });
        }
        req.harnessAuthenticated = true;
        // The password is the harness's own; don't pass it on to the Gateway
        delete req.headers[PASSWORD_HEADER];
        if (/^basic\s/i.test(req.headers.authorization || '')) delete req.headers.authorization;
        const bearer = (req.headers.authorization || '').replace(/^bearer\s+/i, '');
        if (bearer && matches(bearer)) delete req.headers.authorization;
        if (req.headers['x-api-key'] && matches(req.headers['x-api-key'])) delete req.headers['x-api-key'];
        next();
    };
}

module.exports = { requirePassword, PASSWORD_HEADER };
