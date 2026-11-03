// The sandbox ledger (what cloud sandboxes and Fly Machines ran, from when to when), its prices, and the Fly Machines
// sampler. Nothing here calls a provider: the Machines API is a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SandboxLedger } = require('../runner/sandboxLedger');
const { loadRates, report, spanCost, DEFAULT_RATES } = require('../runner/sandboxCosts');
const { listMachines, startSampler } = require('../runner/flyMachines');

const MIN = 60 * 1000;
const clock = (start = 1_000_000_000_000) => {
    let t = start;
    return { now: () => t, set: (v) => { t = v; }, add: (ms) => { t += ms; } };
};

test('a sandbox span runs from open to kill, and closing twice or an unknown id does nothing', () => {
    const c = clock();
    const l = new SandboxLedger({ now: c.now });
    l.begin({ driver: 'e2b', id: 'sb1', runId: 'run-1', owner: 'ann' });
    c.add(2 * MIN);
    l.begin({ driver: 'e2b', id: 'sb1' }); // already open: the same span
    assert.equal(l.entries.length, 1);
    l.end('e2b', 'sb1');
    const span = l.entries[0];
    assert.equal(span.end - span.start, 2 * MIN);
    assert.equal(span.owner, 'ann');
    c.add(MIN);
    l.end('e2b', 'sb1');
    l.end('e2b', 'nope');
    assert.equal(span.end - span.start, 2 * MIN, 'a second close does not move the end');
});

test('a ledger with a file survives a restart, and a sandbox still open then is closed and marked recovered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    const file = path.join(dir, 'sandbox-ledger.json');
    const c = clock();
    const first = new SandboxLedger({ file, now: c.now });
    first.begin({ driver: 'sprites', id: 'harness-a' });
    c.add(5 * MIN);
    first.end('sprites', 'harness-a');
    first.begin({ driver: 'e2b', id: 'left-open' });
    c.add(10 * MIN);
    const second = new SandboxLedger({ file, now: c.now }); // the runner restarted
    const done = second.entries.find((e) => e.id === 'harness-a');
    const open = second.entries.find((e) => e.id === 'left-open');
    assert.equal(done.end - done.start, 5 * MIN);
    assert.equal(open.recovered, true);
    assert.equal(open.end, c.now());
    assert.equal(second.open.size, 0);
});

test('a damaged ledger file starts over and keeps the damaged one beside it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    const file = path.join(dir, 'sandbox-ledger.json');
    fs.writeFileSync(file, '{not json');
    const l = new SandboxLedger({ file });
    assert.deepEqual(l.entries, []);
    assert.ok(fs.existsSync(`${file}.broken`));
});

test('machine samples that touch extend one span; a gap starts a new one', () => {
    const c = clock();
    const l = new SandboxLedger({ now: c.now });
    const t0 = c.now();
    l.sample({ id: 'm1', size: 'shared-1x-256', cpus: 1, memMb: 256, start: t0, end: t0 + 5 * MIN });
    l.sample({ id: 'm1', size: 'shared-1x-256', cpus: 1, memMb: 256, start: t0 + 5 * MIN, end: t0 + 10 * MIN });
    assert.equal(l.entries.length, 1);
    assert.equal(l.entries[0].end - l.entries[0].start, 10 * MIN);
    l.sample({ id: 'm1', size: 'shared-1x-256', cpus: 1, memMb: 256, start: t0 + 20 * MIN, end: t0 + 25 * MIN });
    assert.equal(l.entries.length, 2);
});

test('the report counts only the part of a span inside the window and prices each kind', () => {
    const c = clock();
    const l = new SandboxLedger({ now: c.now });
    const now = c.now();
    // an E2B sandbox open for an hour, 2 vCPU and 512 MB by default
    l.entries.push({ kind: 'sandbox', driver: 'e2b', id: 'a', runId: 'r', owner: 'ann', start: now - 60 * MIN, end: now });
    // a Sprite with no rate: unpriced
    l.entries.push({ kind: 'sandbox', driver: 'sprites', id: 'b', owner: '', start: now - 30 * MIN, end: null });
    // a machine, with a rate for its size
    l.entries.push({ kind: 'machine', driver: 'fly-machine', id: 'm', name: 'web', size: 'shared-1x-256', cpus: 1, memMb: 256, owner: '', start: now - 2 * 60 * MIN, end: now - 60 * MIN });
    // an old span outside a 1-day window
    l.entries.push({ kind: 'sandbox', driver: 'e2b', id: 'old', owner: 'bo', start: now - 40 * 24 * 60 * MIN, end: now - 40 * 24 * 60 * MIN + 10 * MIN });
    const { rates } = loadRates({ env: { SANDBOX_RATES: JSON.stringify({ machines: { 'shared-1x-256': 0.000001 } }) } });
    const r = report(l, { days: 1, now, rates });
    const e2b = r.drivers.find((d) => d.driver === 'e2b');
    assert.equal(e2b.spans, 1, 'the 40-day-old span is out of the window');
    assert.equal(Math.round(e2b.seconds), 3600);
    const expected = 3600 * (2 * 0.000014 + 0.5 * 0.0000045);
    assert.ok(Math.abs(e2b.cost - expected) < 1e-9, `${e2b.cost} vs ${expected}`);
    const sprites = r.drivers.find((d) => d.driver === 'sprites');
    assert.equal(sprites.unpriced, 1);
    assert.equal(sprites.cost, 0);
    assert.equal(r.totals.unpriced, 1);
    const machine = r.drivers.find((d) => d.driver === 'fly-machine');
    assert.ok(Math.abs(machine.cost - 3600 * 0.000001) < 1e-12);
    assert.equal(r.owners.find((o) => o.owner === 'ann').spans, 1);
    assert.equal(r.recent[0].driver, 'sprites', 'most recent first');
});

test('a span with no rate counts as unpriced, and bad rate JSON falls back to the defaults with a message', () => {
    const r = spanCost({ kind: 'machine', driver: 'fly-machine', size: 'performance-2x-4096' }, 60, DEFAULT_RATES);
    assert.deepEqual(r, { cost: 0, unpriced: true });
    const bad = loadRates({ env: { SANDBOX_RATES: '{oops' } });
    assert.equal(bad.source, 'defaults');
    assert.match(bad.error, /not valid JSON/);
    assert.equal(bad.rates.e2b.vcpuSec, DEFAULT_RATES.e2b.vcpuSec);
});

test('listMachines reads size and state, and a failed answer throws', async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => {
        seen.push({ url, auth: opts.headers.authorization });
        return { ok: true, json: async () => [{ id: 'm1', name: 'web', state: 'started', config: { guest: { cpus: 2, memory_mb: 1024, cpu_kind: 'shared' } } }] };
    };
    const list = await listMachines({ app: 'skyler-agents', token: 'T', fetchImpl });
    assert.equal(seen[0].url, 'https://api.machines.dev/v1/apps/skyler-agents/machines');
    assert.equal(seen[0].auth, 'Bearer T');
    assert.deepEqual(list[0], { id: 'm1', name: 'web', state: 'started', cpus: 2, memMb: 1024, cpuKind: 'shared', size: 'shared-2x-1024' });
    await assert.rejects(listMachines({ app: 'a', token: 'T', fetchImpl: async () => ({ ok: false, status: 401 }) }), /401/);
});

test('the sampler records only running machines over the time since its last sample', async () => {
    const c = clock();
    const l = new SandboxLedger({ now: c.now });
    const machines = [
        { id: 'web', state: 'started', config: { guest: { cpus: 1, memory_mb: 256 } } },
        { id: 'worker', state: 'stopped', config: { guest: { cpus: 1, memory_mb: 256 } } },
    ];
    const fetchImpl = async () => ({ ok: true, json: async () => machines });
    const errors = [];
    const s = startSampler({ ledger: l, app: 'a', token: 'T', intervalMs: 5 * MIN, fetchImpl, now: c.now, onError: (e) => errors.push(e) });
    try {
        c.add(5 * MIN);
        assert.equal(await s.tick(), 1);
        c.add(5 * MIN);
        assert.equal(await s.tick(), 1);
        assert.equal(l.entries.length, 1, 'contiguous samples make one span');
        assert.equal(l.entries[0].end - l.entries[0].start, 10 * MIN);
        assert.equal(l.entries[0].id, 'web');
        // a failed answer is reported and records nothing
        const failing = startSampler({ ledger: l, app: 'a', token: 'T', intervalMs: 5 * MIN, fetchImpl: async () => ({ ok: false, status: 500 }), now: c.now, onError: (e) => errors.push(e) });
        c.add(5 * MIN);
        assert.equal(await failing.tick(), 0);
        failing.stop();
        assert.equal(errors.length, 1);
    } finally {
        s.stop();
    }
});
