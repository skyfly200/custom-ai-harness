// The server-side skill store: saving by id or name, the Skills page's own checks, and a file that will not parse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillStore = require('../utils/skillStore');

test('a skill is created, then changed by name, and a second name clash is refused', () => {
    const k = skillStore.createSkillStore({ store: skillStore.memoryStore() });
    const first = k.save({ name: 'Review PR', description: 'Review', body: 'Check tests.' });
    assert.equal(first.name, 'Review-PR');
    assert.equal(first.updated, 'created');
    assert.equal(k.save({ name: 'review-pr', body: 'Check tests and docs.' }).updated, 'changed');
    assert.equal(k.list().length, 1);
    assert.equal(k.list()[0].description, 'Review');
    assert.throws(() => k.save({ name: 'bad name!', body: 'x' }), /Use letters/);
    assert.throws(() => k.save({ name: 'empty', body: '   ' }), /needs its instructions/);
});

test('a skill can be removed by id, and a missing id says so', () => {
    const k = skillStore.createSkillStore({ store: skillStore.memoryStore() });
    const s = k.save({ name: 'one', body: 'x' });
    k.remove(s.id);
    assert.equal(k.list().length, 0);
    assert.throws(() => k.remove(s.id), /no skill with id/);
});

test('the file store keeps a file that will not parse, and creates the file on first save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const file = path.join(dir, 'skills.json');
    const k = skillStore.createSkillStore({ store: skillStore.fileStore(file) });
    assert.deepEqual(k.list(), []);
    k.save({ name: 'one', body: 'x' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).skills.length, 1);
    fs.writeFileSync(file, '{not json');
    assert.throws(() => k.list());
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});
