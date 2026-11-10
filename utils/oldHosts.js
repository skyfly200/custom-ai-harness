// Moves people from a retired address to HARNESS_PUBLIC_URL. HARNESS_OLD_HOSTS is a comma-separated list of
// host names (e.g. agents.skylerfly.com). Requests for those hosts get a 308 (keeps the method and body) to the
// same path on the public address. Health checks are left alone.
// Browser page loads (GET that accepts HTML) get a 200 page that forwards to the new address instead. The installed
// app's service worker still runs on the old address, and Chrome fails a navigation whose service-worker fetch was
// redirected (ERR_FAILED), so a plain 308 would leave the installed app stuck until it is reinstalled.
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function oldHostsRedirect(env = process.env) {
    const target = String(env.HARNESS_PUBLIC_URL || '').replace(/\/+$/, '');
    const hosts = new Set(String(env.HARNESS_OLD_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
    if (!target || !hosts.size) return (req, res, next) => next();
    return (req, res, next) => {
        const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
        if (!hosts.has(host) || req.path === '/healthz') return next();
        const to = target + req.originalUrl;
        const isPage = (req.method === 'GET' || req.method === 'HEAD') && /text\/html/.test(String(req.headers.accept || ''));
        if (!isPage) return res.redirect(308, to);
        res.status(200).type('html').send(
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<meta http-equiv="refresh" content="0;url=${escapeHtml(to)}"><title>Moved</title></head>` +
            `<body><p>This address has moved to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>.</p>` +
            `<script>location.replace(${JSON.stringify(to)});</script></body></html>`);
    };
}
module.exports = { oldHostsRedirect };
