// Memory: notes kept per person across chats: add, repeat check, edit, forget, limits, the prompt text, and the API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-memory-'));
process.env.HARNESS_MEMORY_FILE = path.join(dir, 'memory.json');
process.env.HARNESS_PROMPTS_FILE = path.join(dir, 'prompts.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
const memory = require('../utils/memory');

test('a note is added, repeats are not added twice, and empty or long text is refused', async () => {
    const a = await memory.add('ann', { text: '  Prefers   metric units  ' }, 1000);
    assert.equal(a.text, 'Prefers metric units');
    const again = await memory.add('ann', { text: 'prefers metric units' }, 2000);
    assert.equal(again.existing, true);
    assert.equal(again.id, a.id);
    assert.equal((await memory.list('ann')).length, 1);
    await assert.rejects(memory.add('ann', { text: '   ' }), /empty/);
    await assert.rejects(memory.add('ann', { text: 'x'.repeat(memory.MAX_TEXT + 1) }), /at most/);
});

test('notes are per person', async () => {
    await memory.add('bob', { text: 'Works in Python' });
    assert.deepEqual((await memory.list('bob')).map((n) => n.text), ['Works in Python']);
    assert.ok(!(await memory.list('ann')).some((n) => n.text === 'Works in Python'));
});

test('a note can be changed and forgotten; unknown ids are 404', async () => {
    const n = await memory.add('ann', { text: 'Lives in Oslo' }, 3000);
    const changed = await memory.update('ann', n.id, { text: 'Lives in Bergen' }, 4000);
    assert.equal(changed.text, 'Lives in Bergen');
    assert.equal(changed.updated, 4000);
    await memory.remove('ann', n.id);
    assert.ok(!(await memory.list('ann')).some((x) => x.id === n.id));
    await assert.rejects(memory.remove('ann', n.id), (e) => e.status === 404);
    await assert.rejects(memory.update('ann', 'nope', { text: 'x' }), (e) => e.status === 404);
});

test('the notes limit is enforced', async () => {
    const owner = 'cara';
    for (let i = 0; i < memory.MAX_NOTES; i++) await memory.add(owner, { text: `note ${i}` });
    await assert.rejects(memory.add(owner, { text: 'one more' }), /at most/);
});

test('the prompt text lists notes with ids and keeps the instructions when empty', () => {
    const empty = memory.promptText([]);
    assert.match(empty, /memory_save/);
    assert.match(empty, /No notes are saved yet/);
    const text = memory.promptText([{ id: 'm1', text: 'Likes tea' }]);
    assert.match(text, /- \[m1\] Likes tea/);
    assert.match(text, /memory_forget/);
});

test('the memory API: add, list, edit, forget', async () => {
    const { app } = require('../server');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (method, p, b) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    try {
        const first = await (await fetch(`${base}/ui/api/memory`)).json();
        assert.ok(Array.isArray(first.notes));
        assert.match(first.promptText, /memory_save/);
        const made = await (await json('POST', '/ui/api/memory', { text: 'Uses pnpm' })).json();
        assert.equal(made.text, 'Uses pnpm');
        const edited = await (await json('POST', `/ui/api/memory/${made.id}`, { text: 'Uses npm' })).json();
        assert.equal(edited.text, 'Uses npm');
        const listed = await (await fetch(`${base}/ui/api/memory`)).json();
        assert.ok(listed.notes.some((n) => n.id === made.id && n.text === 'Uses npm'));
        assert.match(listed.promptText, /Uses npm/);
        assert.equal((await json('POST', '/ui/api/memory', { text: '  ' })).status, 400);
        assert.equal((await fetch(`${base}/ui/api/memory/${made.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await fetch(`${base}/ui/api/memory/${made.id}`, { method: 'DELETE' })).status, 404);
    } finally { server.close(); }
});
