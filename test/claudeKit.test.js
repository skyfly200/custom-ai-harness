// Importing Claude Code's commands and skills into the chat page
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { list, parse } = require('../utils/claudeKit');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kit-'));
const write = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

test('frontmatter is split from the body', () => {
    assert.deepEqual(parse('---\ndescription: "Hi"\nmodel: x\n---\nBody'), { meta: { description: 'Hi', model: 'x' }, body: 'Body' });
    assert.deepEqual(parse('Just text'), { meta: {}, body: 'Just text' });
});

test('commands and skills are read; $ARGUMENTS becomes {args}', () => {
    write('commands/plan.md', '---\ndescription: Plan it\nmodel: claude-sonnet-4-6\n---\nPlan: $ARGUMENTS');
    write('commands/team/review.md', 'Review $ARGUMENTS now');
    write('commands/empty.md', '---\ndescription: none\n---\n');
    write('skills/checker/SKILL.md', '---\nname: checker\ndescription: Checks things\n---\nCheck carefully.');
    write('skills/nofile/readme.txt', 'x');
    const items = list([[dir, 'test']]);
    const by = Object.fromEntries(items.map(i => [`${i.kind}:${i.name}`, i]));
    assert.deepEqual(Object.keys(by).sort(), ['command:plan', 'command:team-review', 'skill:checker']);
    assert.equal(by['command:plan'].body, 'Plan: {args}');
    assert.equal(by['command:plan'].description, 'Plan it');
    assert.equal(by['skill:checker'].body, 'Check carefully.');
    assert.equal(by['skill:checker'].source, 'test');
});

test('a missing folder gives nothing', () => {
    assert.deepEqual(list([[path.join(dir, 'nope'), 'x']]), []);
});
