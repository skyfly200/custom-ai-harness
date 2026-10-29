// Moves people from a retired address to HARNESS_PUBLIC_URL. HARNESS_OLD_HOSTS is a comma-separated list of
// host names (e.g. agents.skylerfly.com). Requests for those hosts get a 308 (keeps the method and body) to the
// same path on the public address. Health checks are left alone.
function oldHostsRedirect(env = process.env) {
    const target = String(env.HARNESS_PUBLIC_URL || '').replace(/\/+$/, '');
    const hosts = new Set(String(env.HARNESS_OLD_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
    if (!target || !hosts.size) return (req, res, next) => next();
    return (req, res, next) => {
        const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
        if (!hosts.has(host) || req.path === '/healthz') return next();
        res.redirect(308, target + req.originalUrl);
    };
}
module.exports = { oldHostsRedirect };
