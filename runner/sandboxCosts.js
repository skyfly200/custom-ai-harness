// What the runner's compute costs, from the ledger (runner/sandboxLedger.js): seconds of each sandbox or machine
// span, priced with the rates below. The rates are estimates, not the bill: the provider's invoice is the truth.
//
// Rates come from SANDBOX_RATES (a JSON string) or sandbox-rates.json in the data folder, merged over the defaults:
//   {
//     "e2b":     { "vcpuSec": 0.000014, "gibSec": 0.0000045, "cpus": 2, "memMb": 512 },
//     "sprites": { "vcpuSec": 0.00001, "gibSec": 0.000004, "cpus": 1, "memMb": 1024 },
//     "machines": { "shared-1x-256": 0.00000075 }   // $ per second, keyed by cpu kind, cpus and memory
//   }
// A span with no rate counts as unpriced (the page says how many), not as free.
'use strict';

const fs = require('fs');
const path = require('path');

// E2B's list rates (https://e2b.dev/docs/pricing). Its default sandbox size is not settled in its docs (2 vCPU with
// 512 MiB in the billing docs, 4 GiB on the pricing page), so the default here is 512 MiB and the setting is easy to change.
// Sprites and Fly Machines have no rate here: their prices change, so they stay unpriced until a rate is set.
const DEFAULT_RATES = {
    e2b: { vcpuSec: 0.000014, gibSec: 0.0000045, cpus: 2, memMb: 512 },
    sprites: { vcpuSec: null, gibSec: null, cpus: 1, memMb: 1024 },
    machines: {},
};

function loadRates({ env = process.env, file = '' } = {}) {
    let given = null;
    let source = 'defaults';
    try {
        if (env.SANDBOX_RATES) { given = JSON.parse(env.SANDBOX_RATES); source = 'SANDBOX_RATES'; }
        else if (file && fs.existsSync(file)) { given = JSON.parse(fs.readFileSync(file, 'utf8')); source = path.basename(file); }
    } catch (err) {
        return { rates: mergeRates(null), source: 'defaults', error: `The sandbox rates are not valid JSON (${err.message}); the defaults are used.` };
    }
    return { rates: mergeRates(given), source };
}

function mergeRates(given) {
    const out = { e2b: { ...DEFAULT_RATES.e2b }, sprites: { ...DEFAULT_RATES.sprites }, machines: { ...DEFAULT_RATES.machines } };
    if (!given || typeof given !== 'object') return out;
    for (const driver of ['e2b', 'sprites']) if (given[driver] && typeof given[driver] === 'object') Object.assign(out[driver], given[driver]);
    if (given.machines && typeof given.machines === 'object') Object.assign(out.machines, given.machines);
    return out;
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** The cost of `seconds` for one span: { cost, unpriced }. */
function spanCost(span, seconds, rates) {
    if (span.kind === 'machine') {
        const perSec = finite(rates.machines[span.size]);
        return perSec == null ? { cost: 0, unpriced: true } : { cost: seconds * perSec, unpriced: false };
    }
    const r = rates[span.driver];
    if (!r || finite(r.vcpuSec) == null || finite(r.gibSec) == null) return { cost: 0, unpriced: true };
    const cpus = span.cpus || r.cpus || 1;
    const gib = (span.memMb || r.memMb || 512) / 1024;
    return { cost: seconds * (cpus * r.vcpuSec + gib * r.gibSec), unpriced: false };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The report the admin page draws. days=0 means everything kept. A span is counted for the part of it inside the
 * window, and a day is the day it started (a span that crosses midnight is not split).
 */
function report(ledger, { days = 30, now = Date.now(), rates = DEFAULT_RATES, source = 'defaults', error = '' } = {}) {
    const since = days > 0 ? now - days * 24 * 60 * 60 * 1000 : 0;
    const byDay = new Map();
    const byDriver = {};
    const byOwner = {};
    const recent = [];
    const totals = { seconds: 0, cost: 0, unpriced: 0, spans: 0, sandboxes: 0, machineSpans: 0 };
    for (const span of ledger.entries) {
        const end = span.end ?? now;
        const lo = Math.max(span.start, since);
        const hi = Math.min(end, now);
        if (hi <= lo) continue;
        const seconds = (hi - lo) / 1000;
        const { cost, unpriced } = spanCost(span, seconds, rates);
        const key = span.driver;
        const d = byDriver[key] ||= { driver: key, spans: 0, seconds: 0, cost: 0, unpriced: 0 };
        d.spans += 1; d.seconds += seconds; d.cost += cost; if (unpriced) d.unpriced += 1;
        const day = byDay.get(dayOf(lo)) || { day: dayOf(lo), cost: 0, seconds: 0, byDriver: {} };
        day.cost += cost; day.seconds += seconds;
        day.byDriver[key] = (day.byDriver[key] || 0) + cost;
        byDay.set(day.day, day);
        const owner = span.owner || '';
        const o = byOwner[owner] ||= { owner, spans: 0, seconds: 0, cost: 0 };
        o.spans += 1; o.seconds += seconds; o.cost += cost;
        totals.seconds += seconds; totals.cost += cost; totals.spans += 1; if (unpriced) totals.unpriced += 1;
        if (span.kind === 'machine') totals.machineSpans += 1; else totals.sandboxes += 1;
        recent.push({ kind: span.kind, driver: key, id: span.id, name: span.name || '', runId: span.runId || '', owner, size: span.size || '', cpus: span.cpus || null, memMb: span.memMb || null, start: new Date(span.start).toISOString(), end: span.end == null ? null : new Date(span.end).toISOString(), open: span.end == null, recovered: Boolean(span.recovered), seconds: Math.round(seconds), cost, unpriced });
    }
    recent.sort((a, b) => (a.start < b.start ? 1 : -1));
    const days_ = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    return {
        days, since: since || null, now,
        rates: { e2b: rates.e2b, sprites: rates.sprites, machines: rates.machines, source, error },
        totals,
        drivers: Object.values(byDriver).sort((a, b) => b.cost - a.cost || b.seconds - a.seconds),
        owners: Object.values(byOwner).sort((a, b) => b.cost - a.cost || b.seconds - a.seconds),
        byDay: days_,
        recent: recent.slice(0, 50),
        note: 'Estimates from the rates above, from when each sandbox opened to when it was killed. Sprites and Fly Machines are unpriced until a rate is set.',
    };
}

module.exports = { DEFAULT_RATES, loadRates, mergeRates, spanCost, report };
