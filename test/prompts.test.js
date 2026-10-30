// Saved prompts: variables, versions and restore, per-person storage, the API, and the shared browser helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prompts-'));
process.env.HARNESS_PROMPTS_FILE = path.join(dir, 'prompts.json');
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
const prompts = require('../utils/prompts');
const lib = require('../ui/promptlib');

test('variables are found once each and filled where a value is given', () => {
    const t = 'Fix {{symptom}} in {{ repo }}. Then re-check {{repo}} and {{ unfilled }}.';
    assert.deepEqual(prompts.variables(t), ['symptom', 'repo', 'unfilled']);
    assert.equal(prompts.render(t, { symptom: 'the crash', repo: 'app', unfilled: '' }), 'Fix the crash in app. Then re-check app and {{ unfilled }}.');
    // the page's copy of the helpers agrees with the server's
    assert.deepEqual(lib.variables(t), prompts.variables(t));
    assert.equal(lib.render(t, { repo: 'x' }), prompts.render(t, { repo: 'x' }));
    assert.equal(lib.tokens('x'.repeat(40)), prompts.estimateTokens('x'.repeat(40)));
});

test('saving makes versions only when the text changes, and restore adds a new one', async () => {
    const a = await prompts.save('ann', { name: ' Fix it ', text: 'Fix {{bug}}', tags: 'Fix, fix, Big Job' }, 1000);
    assert.equal(a.name, 'Fix it');
    assert.deepEqual(a.tags, ['fix', 'big-job']);
    assert.deepEqual(a.variables, ['bug']);
    assert.equal(a.versions.length, 1);
    const same = await prompts.save('ann', { id: a.id, name: 'Fix it now', text: 'Fix {{bug}}' }, 2000);
    assert.equal(same.versions.length, 1);
    const changed = await prompts.save('ann', { id: a.id, name: 'Fix it now', text: 'Fix {{bug}} with a test', note: 'asks for a test' }, 3000);
    assert.deepEqual(changed.versions.map((v) => v.n), [1, 2]);
    assert.equal(changed.versions[1].note, 'asks for a test');
    const back = await prompts.restore('ann', a.id, 1, 4000);
    assert.equal(back.text, 'Fix {{bug}}');
    assert.deepEqual(back.versions.map((v) => v.n), [1, 2, 3]);
    assert.equal((await prompts.get('ann', a.id)).history[2].text, 'Fix {{bug}}');
    await assert.rejects(prompts.restore('ann', a.id, 9), /no such version/);
});

test('each person has their own library; empty or oversized prompts are refused', async () => {
    await prompts.save('bob', { name: 'Bob only', text: 'hello' });
    assert.ok(!(await prompts.list('ann')).some((p) => p.name === 'Bob only'));
    assert.deepEqual((await prompts.list('bob')).map((p) => p.name), ['Bob only']);
    await assert.rejects(prompts.save('bob', { name: '', text: 'x' }), /name/);
    await assert.rejects(prompts.save('bob', { name: 'x', text: '  ' }), /empty/);
    await assert.rejects(prompts.save('bob', { name: 'x', text: 'y'.repeat(prompts.MAX_TEXT + 1) }), /at most/);
    await assert.rejects(prompts.save('bob', { id: 'nope', name: 'x', text: 'y' }), /no such prompt/);
    const [p] = await prompts.list('bob');
    await prompts.remove('bob', p.id);
    assert.deepEqual(await prompts.list('bob'), []);
    await assert.rejects(prompts.remove('bob', p.id), /no such prompt/);
});

test('every starter has a name, text and a workflow that exists', () => {
    const ids = fs.readdirSync(path.join(__dirname, '..', 'workflows')).map((f) => f.replace(/\.json$/, ''));
    for (const s of prompts.STARTERS) {
        assert.ok(s.name && s.text.length > 50, s.id);
        assert.ok(ids.includes(s.suits.workflow), `${s.id} suits ${s.suits.workflow}`);
    }
});

test('the improve request keeps the prompt and the notes', () => {
    const m = prompts.improveMessages('Make it faster {{x}}', 'add checks');
    assert.equal(m[0].role, 'system');
    assert.match(m[0].content, /exactly as written/);
    assert.match(m[1].content, /Make it faster \{\{x\}\}/);
    assert.match(m[1].content, /add checks/);
    assert.throws(() => prompts.improveMessages('  '), /write the prompt first/);
});

test('the API saves, lists, restores and deletes, and the page helper names a prompt from its first line', async () => {
    const { app } = require('../server');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    try {
        const first = await (await fetch(`${base}/ui/api/prompts`)).json();
        assert.equal(first.prompts.length, 0);
        assert.ok(first.starters.length >= 5 && first.starters[0].variables.length);
        const made = await (await post('/ui/api/prompts', { name: 'Mine', text: 'Do {{it}}', tags: ['a'] })).json();
        assert.deepEqual(made.variables, ['it']);
        const bad = await post('/ui/api/prompts', { name: 'Mine', text: '' });
        assert.equal(bad.status, 400);
        await post('/ui/api/prompts', { id: made.id, name: 'Mine', text: 'Do {{it}} well' });
        const back = await (await post(`/ui/api/prompts/${made.id}/restore`, { version: 1 })).json();
        assert.equal(back.text, 'Do {{it}}');
        assert.equal((await (await fetch(`${base}/ui/api/prompts/${made.id}`)).json()).history.length, 3);
        const imp = await (await post('/ui/api/prompts-improve', { text: 'Do it', notes: 'clearer' })).json();
        assert.equal(imp.messages.length, 2);
        assert.equal((await fetch(`${base}/ui/api/prompts/${made.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await fetch(`${base}/ui/api/prompts/${made.id}`)).status, 404);
    } finally { server.close(); }
    assert.equal(lib.nameFrom('Fix the {{thing}} bug\nmore text'), 'Fix the thing bug');
});
