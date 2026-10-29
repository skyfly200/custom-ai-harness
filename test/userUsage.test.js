// Usage per person: the store (file and database), the admin sums, and that nobody sees another person's usage
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashPassword } = require('../utils/users');
const { fakeGateway } = require('./helpers/stubs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-userusage-'));
const usageFile = path.join(dir, 'usage.json');
const today = new Date().toISOString().slice(0, 10);

// A file from before per-user tracking: rows have no `user`
fs.writeFileSync(usageFile, JSON.stringify({
    since: '2026-09-01T00:00:00.000Z',
    rows: { old: { day: '2026-09-01', client: 'Chat page', route: 'Router', model: 'old-model', servedBy: 'old-model', provider: 'Groq', requests: 5, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, estimated: 0 } },
}));
process.env.HARNESS_USAGE_FILE = usageFile;
process.env.HARNESS_GATEWAY_CONFIG = path.join(__dirname, 'fixtures', 'config.yaml');
const usage = require('../utils/usage');
const UserUsage = require('../ui/userUsage');
const Costs = require('../ui/costs');

const counts = (n) => ({ input: n, output: 1, cacheRead: 0, cacheWrite: 0 });
const model = { model: 'm1', servedBy: 'm1', route: 'Router', client: 'Chat page' };

test('a file from before per-user tracking becomes the unassigned bucket', () => {
    const all = usage.byUser(0);
    assert.deepEqual(all.users.map((u) => [u.user, u.requests]), [['', 5]]);
    assert.equal(usage.summary(0, { user: '' }).rows[0].requests, 5);
    assert.equal(usage.summary(0, { user: 'alice' }).rows.length, 0);
});

test('records are kept per person, names compare without case, and a person sees only their own totals', () => {
    usage.record({ ...model, user: 'Alice', usage: counts(10) });
    usage.record({ ...model, user: 'alice', usage: counts(20) });
    usage.record({ ...model, user: 'bob', usage: counts(7), servedBy: 'm2' });
    usage.record({ ...model, usage: counts(1) }); // no person

    const alice = usage.summary(0, { user: 'ALICE' });
    assert.deepEqual([alice.rows.length, alice.rows[0].requests, alice.rows[0].input], [1, 2, 30]);
    assert.equal(usage.summary(0, { user: 'bob' }).rows[0].servedBy, 'm2');
    // everyone together is the sum, as before
    assert.equal(usage.summary(0).rows.reduce((n, r) => n + r.requests, 0), 5 + 2 + 1 + 1);

    const all = usage.byUser(7); // the 7-day view leaves the old bucket out (it is from September)
    assert.deepEqual(all.users.map((u) => u.user).sort(), ['', 'Alice', 'bob']);
    const a = all.users.find((u) => u.user === 'Alice');
    assert.deepEqual([a.requests, a.input], [2, 30]);
    assert.ok(a.last > '2026-10-01', 'last active is the time of the latest request');
    assert.equal(all.daily.filter((d) => d.user === 'bob').length, 1);
    assert.equal(usage.byUser(0).users.find((u) => u.user === '').requests, 6, 'old usage plus the person-less request');
});

test('agent run requests are told apart from the chat page', () => {
    const req = (id) => ({ path: '/v1/chat/completions', headers: { 'x-harness-request-id': id } });
    assert.equal(usage.clientOf(req('run-abc-3')), 'Agent run');
    assert.equal(usage.clientOf(req('c-1')), 'Chat page');
});

test('the saved file keeps each person apart and reloads the same', () => {
    process.emit('exit'); // writes what is waiting
    const saved = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    assert.ok(Object.values(saved.rows).some((r) => r.user === 'bob'));
    usage.load();
    assert.equal(usage.summary(0, { user: 'bob' }).rows[0].input, 7);
    assert.equal(usage.summary(0, { user: 'Alice' }).rows[0].requests, 2);
});

// ---- the database store, against an in-memory stand-in for utils/usageDb.js ----
function memoryStore(initial = []) {
    const rows = new Map();
    const key = (r) => [r.day, r.user, r.client, r.route, r.model, r.servedBy, r.provider].join('|');
    const put = (r) => {
        const t = rows.get(key(r)) || { ...r, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, savedAnchor: 0, savedHeadroom: 0 };
        for (const k of ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'estimated', 'savedAnchor', 'savedHeadroom']) t[k] += r[k] || 0;
        rows.set(key(r), t);
    };
    initial.forEach(put);
    return { rows, writes: 0, fail: false, async loadAll() { return [...rows.values()].map((r) => ({ ...r })); }, async add(batch) { if (this.fail) throw new Error('db down'); this.writes++; batch.forEach(put); }, async clear() { rows.clear(); } };
}

test('with a database: the file moves in once, new requests are added, and a restart reads them back', async () => {
    usage.load(); // start from the file, as the server does
    const store = memoryStore();
    await usage.useDatabase(store);
    assert.equal(store.rows.size > 0, true, 'the file moved into the empty table');
    assert.equal(usage.summary(0, { user: 'bob' }).rows[0].requests, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(usageFile, 'utf8')).rows, {}, 'the file is emptied so it is never moved in twice');

    usage.record({ ...model, user: 'bob', usage: counts(100) });
    usage.record({ ...model, user: 'bob', usage: counts(100) });
    await usage.flush();
    assert.equal(store.writes, 2, 'one for the move, one for the two new requests together');
    const bob = [...store.rows.values()].filter((r) => r.user === 'bob' && r.servedBy === 'm1');
    assert.deepEqual(bob.map((r) => [r.requests, r.input]), [[2, 200]]);

    // "restart": a new process would start with the file (now empty) and load the table
    const before = usage.byUser(0);
    await usage.useDatabase(store);
    const after = usage.byUser(0);
    assert.deepEqual(after.users.map((u) => [u.user, u.requests]).sort(), before.users.map((u) => [u.user, u.requests]).sort());
});

test('a failed database write is kept and tried again, never lost or counted twice', async () => {
    const store = memoryStore();
    await usage.useDatabase(store);
    store.fail = true;
    usage.record({ ...model, user: 'carol', usage: counts(5) });
    await usage.flush();
    assert.equal([...store.rows.values()].filter((r) => r.user === 'carol').length, 0);
    store.fail = false;
    usage.record({ ...model, user: 'carol', usage: counts(5) });
    await usage.flush();
    const carol = [...store.rows.values()].filter((r) => r.user === 'carol');
    assert.deepEqual([carol[0].requests, carol[0].input], [2, 10]);
    assert.equal(usage.summary(0, { user: 'carol' }).rows[0].requests, 2);
});

test('if the table cannot be read the file stays the store', async () => {
    usage.record({ ...model, user: 'dana', usage: counts(3) });
    const broken = { async loadAll() { throw new Error('no table'); }, async add() {}, async clear() {} };
    await assert.rejects(usage.useDatabase(broken), /no table/);
    assert.equal(usage.summary(0, { user: 'dana' }).rows[0].requests, 1, 'what was counted is kept');
    usage.record({ ...model, user: 'dana', usage: counts(3) });
    process.emit('exit');
    assert.equal(Object.values(JSON.parse(fs.readFileSync(usageFile, 'utf8')).rows).filter((r) => r.user === 'dana').reduce((n, r) => n + r.requests, 0), 2);
});

test('clearing empties the database and the file', async () => {
    const store = memoryStore();
    await usage.useDatabase(store);
    usage.record({ ...model, user: 'bob', usage: counts(1) });
    await usage.flush();
    await usage.clear();
    assert.equal(store.rows.size, 0);
    assert.equal(usage.byUser(0).users.length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(usageFile, 'utf8')).rows, {});
});

// ---- the sums behind the admin page ----
const prices = { m1: { inputCost: 1e-6, outputCost: 2e-6 }, m2: { free: true } };
const row = (user, servedBy, extra = {}) => ({ user, client: 'Chat page', route: 'Router', model: servedBy, servedBy, provider: 'X', requests: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, estimated: 0, ...extra });

test('aggregate totals, prices and ranks each person, with the people who have no usage', () => {
    const data = {
        rows: [row('alice', 'm1'), row('Alice', 'm1', { client: 'Agent run', input: 2000 }), row('bob', 'm2'), row('bob', 'mystery'), row('', 'm1', { requests: 4 })],
        users: [{ user: 'alice', last: '2026-10-28T10:00:00.000Z' }, { user: 'bob', last: '2026-10-29T10:00:00.000Z' }],
        people: [{ name: 'alice', role: 'admin' }, { name: 'bob', role: 'user', guest: true }, { name: 'erin', role: 'user' }],
        credit: { bob: { capUsd: 1, spentUsd: 0.25, reservedUsd: 0, leftUsd: 0.75 } },
    };
    const agg = UserUsage.aggregate(data, prices);
    const by = Object.fromEntries(agg.people.map((p) => [p.user || '', p]));
    assert.deepEqual(Object.keys(by).sort(), ['', 'alice', 'bob', 'erin']);
    assert.equal(by.alice.requests, 2);
    assert.ok(Math.abs(by.alice.cost - (1000 * 1e-6 + 100 * 2e-6 + 2000 * 1e-6 + 100 * 2e-6)) < 1e-12);
    assert.ok(Math.abs(by.alice.agentCost - (2000 * 1e-6 + 100 * 2e-6)) < 1e-12);
    assert.equal(by.bob.unpriced, 1, 'a model with no known price is counted, not charged');
    assert.equal(by.bob.free, 1);
    assert.equal(by.bob.left, 0.75);
    assert.equal(by.bob.guest, true);
    assert.equal(by.erin.requests, 0);
    assert.equal(by.alice.last, '2026-10-28T10:00:00.000Z');
    assert.deepEqual(by.alice.models.map((m) => m.name), ['m1']);
    assert.equal(agg.total.active, 3);
    assert.equal(agg.total.requests, 2 + 2 + 4);
    assert.equal(agg.total.unpriced, 1);
});

test('people sort by any column, empty values last', () => {
    const people = [
        { user: 'b', requests: 2, cost: 5, last: '2026-10-02', left: 0.5 },
        { user: 'a', requests: 9, cost: 1, last: null, left: undefined },
        { user: 'c', requests: 2, cost: 9, last: '2026-10-03', left: 2 },
    ];
    const order = (key, dir) => UserUsage.sorted(people, key, dir).map((p) => p.user).join('');
    assert.equal(order('cost', -1), 'cba');
    assert.equal(order('requests', -1), 'abc', 'ties fall back to the name');
    assert.equal(order('name', 1), 'abc');
    assert.equal(order('last', -1), 'cba', 'never active goes last');
    assert.equal(order('last', 1), 'bca');
    assert.equal(order('left', 1), 'bca', 'no credit goes last');
});

test('per-day stacks fill the whole range and merge the small series', () => {
    const daily = ['p', 'q', 'r'].flatMap((u, i) => [{ day: today, user: u, servedBy: 'm1', requests: i + 1, input: 10, output: 1, cost: i + 1 }]);
    const s = UserUsage.stack(daily, { days: 7, today, measure: 'requests', keyOf: (r) => r.user, top: 2 });
    assert.equal(s.days.length, 7);
    assert.equal(s.days[6], today);
    assert.deepEqual(s.series.map((x) => x.label), ['r', 'q', 'Others']);
    assert.equal(s.series[2].values[6], 1);
    assert.equal(UserUsage.dayList(0, today, today).length, 1);
    assert.equal(UserUsage.stack(daily, { days: 30, today, measure: 'cost', keyOf: (r) => r.user }).days.length, 30);
});
