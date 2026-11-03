// Samples the Fly Machines of this app (the hosted server's Machine, and any others in the app) with the Machines API,
// and records the ones seen running in the sandbox ledger. A machine that is asleep is not running, so it adds nothing:
// the sampler runs inside the Machine, so it only sees machines while this one is awake. Needs FLY_API_TOKEN, a token
// that can read this app's machines (set it as a Fly secret; the harness sends it only to api.machines.dev).
// FLY_APP_NAME is set by Fly on every Machine.
'use strict';

const API = 'https://api.machines.dev/v1';
const RUNNING = new Set(['started', 'starting', 'replacing']);

/** The app's machines as { id, name, state, cpus, memMb, cpuKind, size }. Throws on a failed answer. */
async function listMachines({ app, token, fetchImpl = fetch }) {
    const res = await fetchImpl(`${API}/apps/${encodeURIComponent(app)}/machines`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`the Fly Machines API answered ${res.status}`);
    const list = await res.json();
    return (Array.isArray(list) ? list : []).map((m) => {
        const guest = m.config?.guest || {};
        const cpus = Number(guest.cpus) || 1;
        const memMb = Number(guest.memory_mb) || 256;
        const cpuKind = guest.cpu_kind || 'shared';
        return { id: String(m.id), name: m.name || String(m.id), state: m.state || '', cpus, memMb, cpuKind, size: `${cpuKind}-${cpus}x-${memMb}` };
    });
}

/**
 * Starts sampling every `intervalMs`. Each sample covers the time since the last one; if more than two intervals went
 * by (the process was paused), only one interval is counted. Returns { stop, tick }; tick() runs one sample now.
 */
function startSampler({ ledger, app, token, intervalMs = 5 * 60 * 1000, fetchImpl = fetch, now = () => Date.now(), onError = () => {} }) {
    let last = now();
    let busy = false;
    const tick = async () => {
        if (busy) return 0;
        busy = true;
        try {
            const at = now();
            const start = at - last > 2 * intervalMs ? at - intervalMs : last;
            const machines = await listMachines({ app, token, fetchImpl });
            let counted = 0;
            for (const m of machines) {
                if (!RUNNING.has(m.state)) continue;
                ledger.sample({ id: m.id, name: m.name, size: m.size, cpus: m.cpus, memMb: m.memMb, start, end: at });
                counted += 1;
            }
            last = at;
            return counted;
        } catch (err) {
            onError(err);
            return 0;
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(() => { tick(); }, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer), tick };
}

module.exports = { listMachines, startSampler, RUNNING };
