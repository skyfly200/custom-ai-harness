// Skills page: the pure part (ui/skillsModel.js), and how an agent keeps a copy of its skills (runner/agents.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../ui/skillsModel.js');
const { AgentStore } = require('../runner/agents.js');

const skill = (over = {}) => ({ id: 's1', name: 'write-tests', description: '', body: 'Write a test first.', disabled: false, ...over });

test('a SKILL.md file gives its name, description and instructions from the frontmatter', () => {
  const text = '---\nname: "Fix bugs"\ndescription: Find the cause first\n---\n\nRead the failing test.\n';
  assert.deepStrictEqual(M.parseSkillFile(text, 'fallback'), { name: 'Fix-bugs', description: 'Find the cause first', body: 'Read the failing test.' });
});

test('a file without frontmatter takes its name from the file, and its whole text as instructions', () => {
  assert.deepStrictEqual(M.parseSkillFile('Just do it.\n', 'quick'), { name: 'quick', description: '', body: 'Just do it.' });
});

test('a skill needs a name, a free name made of word characters, unique, and instructions', () => {
  assert.match(M.problem(skill({ name: '  ' })), /needs a name/);
  assert.match(M.problem(skill({ name: 'bad/name' })), /Use letters/);
  assert.match(M.problem(skill({ id: 's2', name: 'Write-Tests' }), [skill()]), /already called/);
  assert.equal(M.problem(skill({ name: 'write-tests' }), [skill()]), null, 'a skill does not clash with itself');
  assert.match(M.problem(skill({ body: '  ' })), /needs its instructions/);
  assert.equal(M.problem(skill()), null);
});

test('a new name skips the names in use', () => {
  assert.equal(M.freeName('new-skill', []), 'new-skill');
  assert.equal(M.freeName('new-skill', [skill({ name: 'new-skill' })]), 'new-skill-2');
  assert.equal(M.freeName('new-skill', [skill({ name: 'new-skill' }), skill({ id: 's2', name: 'new-skill-2' })]), 'new-skill-3');
});

test('an agent gets a copy of the skill it is given, and drops it when the skill is off or gone', () => {
  const k = skill();
  const on = M.agentSkillsAfter({ skills: [] }, [k], { id: 's1', on: true });
  assert.deepStrictEqual(on, [{ id: 's1', name: 'write-tests', body: 'Write a test first.' }]);
  // already has the same copy: nothing to send
  assert.equal(M.agentSkillsAfter({ skills: on }, [k], null), null);
  // the skill was edited: the agent gets the new text
  assert.deepStrictEqual(M.agentSkillsAfter({ skills: on }, [{ ...k, body: 'New text.' }], null), [{ id: 's1', name: 'write-tests', body: 'New text.' }]);
  // switched off: dropped
  assert.deepStrictEqual(M.agentSkillsAfter({ skills: on }, [{ ...k, disabled: true }], null), []);
  // deleted: dropped
  assert.deepStrictEqual(M.agentSkillsAfter({ skills: on }, [], { id: 's1', on: false }), []);
});

test('a project keeps the ids of its skills, without the ones that are gone', () => {
  const skills = [skill(), skill({ id: 's2', name: 'other' })];
  assert.deepStrictEqual(M.projectSkillsAfter({ skills: ['s1', 'gone'] }, skills, { id: 's2', on: true }), ['s1', 's2']);
  assert.deepStrictEqual(M.projectSkillsAfter({ skills: ['s1', 's2'] }, skills, { id: 's1', on: false }), ['s2']);
});

test('only switched-on skills are offered to chats and agents', () => {
  assert.deepStrictEqual(M.enabled([skill(), skill({ id: 's2', disabled: true })]).map((k) => k.id), ['s1']);
});

test('an agent stores at most 30 skills, each with an id, name and instructions', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, body: 'text' }));
  assert.equal(AgentStore.fields({ skills: many }).skills.length, 30);
  assert.deepStrictEqual(AgentStore.fields({ skills: [{ id: 'a', name: 'x', body: '  body  ' }, { id: '', name: 'no id', body: 'b' }] }).skills, [{ id: 'a', name: 'x', body: 'body' }]);
  assert.deepStrictEqual(AgentStore.fields({ skills: null }).skills, []);
  assert.throws(() => AgentStore.fields({ skills: 'nope' }), /skills must be a list/);
});
