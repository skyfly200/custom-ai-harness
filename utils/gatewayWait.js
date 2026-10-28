// On Fly the Machine wakes in seconds but LiteLLM needs a minute or more to load, so the first request after
// a sleep finds the Gateway's port closed. Instead of answering 502, the harness waits for the port to open.
const net = require('net');

/** Seconds to wait for the Gateway (HARNESS_GATEWAY_WAIT_S); 0 or unset: fail at once, as on a laptop. */
function waitSeconds(env = process.env) {
    const n = Number(env.HARNESS_GATEWAY_WAIT_S);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function canConnect(url, timeoutMs = 1000) {
    const u = new URL(url);
    return new Promise((resolve) => {
        const socket = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) });
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** True once the Gateway's port accepts connections, false after timeoutMs. */
async function waitUntilUp(url, { timeoutMs, intervalMs = 1000, probe = canConnect } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        if (await probe(url)) return true;
        if (Date.now() + intervalMs >= end) return false;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

module.exports = { waitSeconds, waitUntilUp, canConnect };
