// Server skills join the browser's list: added when no local skill has the same id or name; a failed fetch changes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');

const { merge, load } = require('../ui/serverSkills.js');

test('a server skill is added unless a local skill has its id or name', () => {
    const local = [{ id: 'a', name: 'Review', body: 'mine' }];
    const server = [{ id: 'a', name: 'Review', body: 'server' }, { id: 'b', name: 'review', body: 'x' }, { id: 'c', name: 'Docs', body: 'y' }];
    const merged = merge(local, server);
    assert.deepEqual(merged.map((s) => s.id), ['a', 'c']);
    assert.equal(merged[0].body, 'mine');
});

test('load uses the owner-only endpoint and keeps the local list when it fails', async () => {
    const local = [{ id: 'a', name: 'One', body: '1' }];
    const seen = [];
    const ok = await load(local, { base: 'http://h/ui/chat.html', fetchImpl: async (url) => { seen.push(url); return new Response(JSON.stringify({ skills: [{ id: 'z', name: 'Two', body: '2' }] }), { status: 200 }); } });
    assert.equal(seen[0], 'http://h/ui/api/assistant/skills');
    assert.deepEqual(ok.map((s) => s.id), ['a', 'z']);
    const denied = await load(local, { base: 'http://h/ui/chat.html', fetchImpl: async () => new Response('{}', { status: 403 }) });
    assert.equal(denied, local);
    const down = await load(local, { base: 'http://h/ui/chat.html', fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(down, local);
});
