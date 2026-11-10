// Sleeping when nobody is using it, and stopping on request (the Dashboard's Stop button), so a hosted
// server stops costing money. On Fly the launcher (docker/fly-start.js) exits 0 when asked to stop and the
// Machine's restart policy is "on-failure", so it stays stopped until Fly wakes it for the next request.
//
// "Using it" is a person or a program doing something: opening a page, sending a request to /v1, saving a
// chat, any change. The Dashboard polling for status or holding the live feed open does not count, or an open
// tab would keep it awake forever. A request still being answered, or a reply the server is still saving,
// keeps it awake whatever the clock says.

const POLL_MS = 30 * 1000;
// Extensions (the Server card's Extend button) add idle time on top of HARNESS_IDLE_STOP_MIN, up to this much in all
const MAX_EXTRA_MS = 4 * 60 * 60 * 1000;

/** Does this request count as someone using the server? */
function counts(req) {
    const path = String(req.path || req.url || '').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return true;
    if (path.startsWith('/v1') || path.startsWith('/openrouter-proxy')) return true;
    return path === '/' || path === '/ui' || path === '/ui/' || path.endsWith('.html') || /^(\/ui)?\/(index|chat|usage|usage-users|routing|agents|runs|prompts|skills|tools|settings|users)$/.test(path);
}

function create({ minutes = 0, stop = null, busy = [], now = () => Date.now(), poll = POLL_MS } = {}) {
    const idleAfterMs = Math.max(0, Number(minutes) || 0) * 60 * 1000;
    let last = now();
    let inflight = 0;
    let timer = null;
    let stopping = false;
    // idle time added by extend(), counted from the last use; any use or job resets it to zero
    let extraMs = 0;

    const isBusy = () => inflight > 0 || busy.some((fn) => { try { return fn(); } catch { return false; } });

    const thresholdMs = () => idleAfterMs + extraMs;

    function status() {
        const idleMs = Math.max(0, now() - last);
        const sleeps = Boolean(idleAfterMs && stop);
        return {
            canStop: Boolean(stop),
            sleepsAfterMin: idleAfterMs ? idleAfterMs / 60000 : 0,
            busy: isBusy(),
            idleMs,
            // null when it will not sleep by itself, or something is in progress
            stopsInMs: sleeps && !isBusy() ? Math.max(0, thresholdMs() - idleMs) : null,
            // the full countdown (idle time plus extensions): the ring is stopsInMs out of this
            totalMs: sleeps ? thresholdMs() : 0,
            extraMs,
            maxExtraMs: MAX_EXTRA_MS,
            canExtend: sleeps && !stopping,
            stopping,
        };
    }

    // Adds idle time before the server sleeps. Returns false when there is nothing to extend.
    function extend(ms) {
        if (!idleAfterMs || !stop || stopping) return false;
        const add = Math.max(0, Math.min(Number(ms) || 0, MAX_EXTRA_MS));
        extraMs = Math.min(MAX_EXTRA_MS, extraMs + add);
        console.log(`[idle-stop] extended by ${Math.round(add / 60000)} minutes`);
        return true;
    }

    function requestStop(reason) {
        if (!stop || stopping) return false;
        stopping = true;
        console.log(`[idle-stop] stopping: ${reason}`);
        stop(reason);
        return true;
    }

    function middleware(req, res, next) {
        if (stopping || !counts(req)) return next();
        last = now();
        extraMs = 0;
        inflight++;
        res.once('close', () => { inflight--; last = now(); });
        next();
    }

    function check() {
        if (!idleAfterMs || !stop) return;
        // a job keeps the server awake, and the clock starts again from the moment it finishes
        if (isBusy()) { last = now(); extraMs = 0; return; }
        if (now() - last >= thresholdMs()) requestStop(`idle for ${Math.round((now() - last) / 60000)} minutes`);
    }

    function start() {
        if (idleAfterMs && stop && !timer) { timer = setInterval(check, poll); timer.unref(); }
        return module.exports;
    }

    return { middleware, status, requestStop, extend, check, start };
}

module.exports = { create, counts };
