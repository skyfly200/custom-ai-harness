// Project sharing and cross-user isolation, against a real Postgres (PGlite) running the repo migrations
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');

const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
        await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
})();
db.query = async (text, params) => { await ready; return pg.query(text, params); };
const { createChatSync } = require('../utils/chatSync');

const USERS = [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }, { name: 'gus', guest: true }];
const users = { names: () => USERS };

// One app; the signed-in person is picked per request with the x-as header
async function withApp(fn, opts = { users }) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { const as = req.get('x-as'); if (as) req.harnessUser = { name: as, ...(USERS.find((u) => u.name === as)?.guest ? { guest: true } : {}) }; next(); });
    app.use(createChatSync(opts));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const as = (who) => (method, p, body) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-as': who }, body: body && JSON.stringify(body) });
    try { await fn(as); } finally { server.close(); }
}

const msg = (id, content) => ({ id, role: 'user', content, time: 1 });
async function seedAlice(call) {
    await call('PUT', '/ui/api/sync/data/harness-projects', { value: [{ id: 'p1', name: 'Site', color: '#123456', instructions: 'be kind', repo: { path: '/secret/repo' }, skills: ['s1'] }, { id: 'p2', name: 'Private', instructions: 'nobody sees this' }], updated: 5 });
    await call('PUT', '/ui/api/sync/chats/c1/delta', { chat: { id: 'c1', title: 'shared chat', updated: 10, project: 'p1' }, order: ['u1'], upserts: [msg('u1', 'hello')], base: 0 });
    await call('PUT', '/ui/api/sync/chats/c2/delta', { chat: { id: 'c2', title: 'private chat', updated: 10, project: 'p2' }, order: ['u1'], upserts: [msg('u1', 'secret')], base: 0 });
    await call('PUT', '/ui/api/sync/chats/c3/delta', { chat: { id: 'c3', title: 'no project', updated: 10 }, order: ['u1'], upserts: [msg('u1', 'loose')], base: 0 });
}

test('private by default: nobody else sees projects, chats or data', async () => {
    await withApp(async (as) => {
        const alice = as('alice'), bob = as('bob');
        await seedAlice(alice);
        const theirs = await (await bob('GET', '/ui/api/sync')).json();
        assert.deepEqual(theirs.chats, []);
        assert.deepEqual(theirs.data, {});
        for (const id of ['c1', 'c2', 'c3']) {
            assert.equal((await bob('GET', `/ui/api/sync/chats/${id}`)).status, 404);
            assert.equal((await bob('GET', `/ui/api/sync/shared/alice/chats/${id}`)).status, 404);
        }
        const shares = await (await bob('GET', '/ui/api/sync/shares')).json();
        assert.deepEqual(shares.withMe, []);
        // writing into alice's chat through the shared route is refused too
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/chats/c1/delta', { chat: { id: 'c1', title: 'x', updated: 20, project: 'p1' }, order: ['u1'], upserts: [msg('u1', 'pwn')], base: 1 })).status, 403);
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/projects/p1', { name: 'pwned' })).status, 403);
    });
});

test('sharing with one person: they see only that project and its chats', async () => {
    await withApp(async (as) => {
        const alice = as('alice'), bob = as('bob'), carol = as('carol');
        await seedAlice(alice);
        assert.equal((await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'bob', role: 'view' }] })).status, 200);
        const seen = (await (await bob('GET', '/ui/api/sync/shares')).json()).withMe;
        assert.equal(seen.length, 1);
        assert.equal(seen[0].owner, 'alice');
        assert.equal(seen[0].role, 'view');
        assert.deepEqual(seen[0].project, { id: 'p1', name: 'Site', color: '#123456', instructions: 'be kind' }); // no repo path, no skills
        assert.deepEqual(seen[0].chats.map((c) => c.id), ['c1']);
        const chat = await (await bob('GET', '/ui/api/sync/shared/alice/chats/c1')).json();
        assert.equal(chat.messages[0].content, 'hello');
        assert.equal(chat.sharedRole, 'view');
        for (const id of ['c2', 'c3']) assert.equal((await bob('GET', `/ui/api/sync/shared/alice/chats/${id}`)).status, 404);
        // the share does not leak into bob's own listing, or to carol
        assert.deepEqual((await (await bob('GET', '/ui/api/sync')).json()).chats, []);
        assert.deepEqual((await (await carol('GET', '/ui/api/sync/shares')).json()).withMe, []);
        assert.equal((await carol('GET', '/ui/api/sync/shared/alice/chats/c1')).status, 404);
        // view cannot write
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/chats/c1/delta', { chat: { id: 'c1', title: 'x', updated: 20, project: 'p1' }, order: ['u1'], upserts: [msg('u1', 'pwn')], base: 1 })).status, 403);
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/projects/p1', { name: 'pwned' })).status, 403);
    });
});

test('edit: writes the owner\'s chat, starts new chats in the project, edits the project; revoking closes it', async () => {
    await withApp(async (as) => {
        const alice = as('alice'), bob = as('bob');
        await seedAlice(alice);
        await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'bob', role: 'edit' }] });
        let r = await bob('PUT', '/ui/api/sync/shared/alice/chats/c1/delta', { chat: { id: 'c1', title: 'shared chat', updated: 20, project: 'p2' }, order: ['u1', 'u2'], upserts: [msg('u2', 'from bob')], base: 1 });
        assert.equal(r.status, 200);
        let got = await (await alice('GET', '/ui/api/sync/chats/c1')).json();
        assert.deepEqual(got.messages.map((m) => m.content), ['hello', 'from bob']);
        assert.equal(got.project, 'p1'); // can't be moved out of the shared project
        // a new chat in the shared project lands with the owner
        r = await bob('PUT', '/ui/api/sync/shared/alice/chats/nb1/delta', { chat: { id: 'nb1', title: 'bob started', updated: 30, project: 'p1' }, order: ['u1'], upserts: [msg('u1', 'hi')], base: 0 });
        assert.equal(r.status, 200);
        assert.equal((await alice('GET', '/ui/api/sync/chats/nb1')).status, 200);
        // ... but not in a project that is not shared
        r = await bob('PUT', '/ui/api/sync/shared/alice/chats/nb2/delta', { chat: { id: 'nb2', title: 'x', updated: 30, project: 'p2' }, order: ['u1'], upserts: [msg('u1', 'hi')], base: 0 });
        assert.equal(r.status, 403);
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/chats/c2/delta', { chat: { id: 'c2', title: 'x', updated: 30 }, order: ['u1'], upserts: [msg('u1', 'pwn')], base: 1 })).status, 403);
        // project settings
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/projects/p1', { name: 'Site v2', instructions: 'be brief' })).status, 200);
        const mine = (await (await alice('GET', '/ui/api/sync')).json()).data['harness-projects'].value;
        assert.equal(mine[0].name, 'Site v2');
        assert.deepEqual(mine[0].repo, { path: '/secret/repo' }); // untouched
        assert.equal(mine[1].name, 'Private');
        // revoke
        await alice('PUT', '/ui/api/sync/shares/p1', { grants: [] });
        assert.equal((await bob('GET', '/ui/api/sync/shared/alice/chats/c1')).status, 404);
        assert.equal((await bob('PUT', '/ui/api/sync/shared/alice/chats/c1/delta', { chat: { id: 'c1', title: 'x', updated: 40 }, order: ['u1'], upserts: [msg('u1', 'late')], base: 3 })).status, 403);
        assert.deepEqual((await (await bob('GET', '/ui/api/sync/shares')).json()).withMe, []);
    });
});

test('everyone: explicit, view or edit, and guests are left out', async () => {
    await withApp(async (as) => {
        const alice = as('alice'), carol = as('carol'), gus = as('gus');
        await seedAlice(alice);
        await alice('PUT', '/ui/api/sync/shares/p1', { grants: [], everyone: 'view' });
        assert.equal((await carol('GET', '/ui/api/sync/shared/alice/chats/c1')).status, 200);
        assert.equal((await carol('GET', '/ui/api/sync/shared/alice/chats/c2')).status, 404);
        assert.equal((await gus('GET', '/ui/api/sync/shares')).status, 403);
        assert.equal((await gus('GET', '/ui/api/sync/shared/alice/chats/c1')).status, 404);
        // a named edit grant beats the everyone view
        await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'carol', role: 'edit' }], everyone: 'view' });
        assert.equal((await (await carol('GET', '/ui/api/sync/shares')).json()).withMe[0].role, 'edit');
        const mine = (await (await alice('GET', '/ui/api/sync/shares')).json()).mine;
        assert.deepEqual(mine.map((m) => [m.grantee, m.role]).sort(), [['*', 'view'], ['carol', 'edit']]);
    });
});

test('only the owner shares, only with existing non-guest users, and guests cannot share', async () => {
    await withApp(async (as) => {
        const alice = as('alice'), bob = as('bob'), gus = as('gus');
        await seedAlice(alice);
        assert.equal((await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'nobody', role: 'view' }] })).status, 400);
        assert.equal((await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'gus', role: 'view' }] })).status, 400);
        assert.equal((await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'alice', role: 'view' }] })).status, 400);
        assert.equal((await alice('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'bob', role: 'admin' }] })).status, 400);
        assert.equal((await alice('PUT', '/ui/api/sync/shares/nope', { grants: [] })).status, 404);
        // bob has no project p1 of his own, so he can't share alice's
        assert.equal((await bob('PUT', '/ui/api/sync/shares/p1', { grants: [{ user: 'carol', role: 'edit' }] })).status, 404);
        assert.equal((await gus('PUT', '/ui/api/sync/shares/p1', { grants: [] })).status, 403);
        assert.deepEqual((await (await alice('GET', '/ui/api/sync/shares/people')).json()).people, ['bob', 'carol']);
        assert.equal((await (await gus('GET', '/ui/api/sync')).json()).canShare, false);
        assert.equal((await (await alice('GET', '/ui/api/sync')).json()).canShare, true);
    });
});

test('without logins nothing can be shared', async () => {
    await withApp(async (as) => {
        const me = as('');
        assert.equal((await me('GET', '/ui/api/sync/shares')).status, 403);
        assert.equal((await (await me('GET', '/ui/api/sync')).json()).canShare, false);
    }, {});
});
