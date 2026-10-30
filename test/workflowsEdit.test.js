// The Workflows page: saving, creating and deleting workflow files, and the
// editor's pure rules (plain-English lines, moving and renaming stages, checks).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workflows = require('../utils/workflows');
const M = require('../ui/workflowsModel.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wf-edit-'));
const body = (over = {}) => ({
  id: 'pair', name: 'Pair', when: 'a small change that needs a second check',
  stages: [
    { id: 'build', role: 'Builder', tools: 'all', prompt: 'Make the change.' },
    { id: 'check', role: 'Checker', tools: 'check', verdict: true, retryTo: 'build', maxRetries: 2, prompt: 'Say PASS or FAIL.' },
  ],
  ...over,
});

test('a saved workflow writes only the fields that differ from the defaults, and loads back the same', () => {
  const dir = tmp();
  const file = workflows.save(body(), { id: 'pair', isNew: true, dir });
  assert.deepEqual(file.stages[0], { id: 'build', role: 'Builder', prompt: 'Make the change.' }, 'tools "all" is the default, so it is left out');
  assert.equal(file.stages[1].retryTo, 'build');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pair.json'), 'utf8'));
  assert.deepEqual(onDisk, file);
  const back = workflows.get('pair', dir);
  assert.equal(back.stages[1].maxRetries, 2);
  assert.equal(back.stages[1].tools, 'check');
});

test('create refuses a name in use, and save refuses a missing file or a changed id', () => {
  const dir = tmp();
  workflows.save(body(), { id: 'pair', isNew: true, dir });
  assert.throws(() => workflows.save(body(), { id: 'pair', isNew: true, dir }), (err) => err.status === 409);
  assert.throws(() => workflows.save(body({ id: 'other' }), { id: 'pair', dir }), (err) => err.status === 400);
  assert.throws(() => workflows.save(body(), { id: 'nothere', dir }), (err) => err.status === 404);
  assert.throws(() => workflows.save(body(), { id: '../escape', dir }), (err) => err.status === 400);
});

test('a stage that retries must name itself or an earlier stage, and a batch stage needs a model', () => {
  const dir = tmp();
  const later = body({ stages: [{ id: 'a', role: 'A', prompt: 'p', verdict: true, retryTo: 'b' }, { id: 'b', role: 'B', prompt: 'p' }] });
  assert.throws(() => workflows.save(later, { id: 'pair', isNew: true, dir }), (err) => err.status === 400 && /earlier one/.test(err.message));
  const batch = body({ stages: [{ id: 'a', role: 'A', prompt: 'p', tools: 'none', canWait: true }] });
  assert.throws(() => workflows.save(batch, { id: 'pair', isNew: true, dir }), (err) => err.status === 400 && /model/.test(err.message));
});

test('delete removes a workflow file, but never the fallback', () => {
  const dir = tmp();
  workflows.save(body(), { id: 'pair', isNew: true, dir });
  workflows.save({ id: 'general', name: 'General', fallback: true, stages: [{ id: 'w', role: 'W', prompt: 'p' }] }, { id: 'general', isNew: true, dir });
  workflows.remove('pair', dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['general.json']);
  assert.throws(() => workflows.remove('general', dir), (err) => err.status === 409);
  assert.throws(() => workflows.remove('pair', dir), (err) => err.status === 404);
});

test('the shipped recipes survive a round trip through the editor’s file form', () => {
  const dir = tmp();
  for (const w of workflows.load().list) {
    const saved = workflows.save(JSON.parse(JSON.stringify(workflows.toFile(w))), { id: w.id, isNew: true, dir });
    assert.deepEqual(workflows.toFile(workflows.clean(saved, `${w.id}.json`)), saved, w.id);
  }
});

test('the ChatDev template is a planner, a programmer and two checks that send FAIL back to the programmer', () => {
  const stages = M.TEMPLATES.chatdev.stages();
  assert.deepEqual(stages.map((s) => s.role), ['CEO', 'Programmer', 'Reviewer', 'Tester']);
  assert.deepEqual(stages.filter((s) => s.verdict).map((s) => s.retryTo), ['programmer', 'programmer']);
  assert.deepEqual(M.problems({ id: 'dev', name: 'Dev', stages }), []);
});

test('plain-English lines describe where a stage sits, what it may do and where FAIL goes', () => {
  const stages = M.TEMPLATES.chatdev.stages();
  const first = M.explain(stages, 0).join(' ');
  assert.match(first, /^CEO can look at files/);
  assert.match(first, /It starts the run\./);
  assert.match(first, /handed to Programmer/);
  const check = M.explain(stages, 2).join(' ');
  assert.match(check, /FAIL sends the run back to Programmer with what was wrong, up to 2 times/);
  assert.match(M.explain(stages, 3).join(' '), /Its finish summary is the run/);
});

test('moving a stage clears any FAIL line that would point forward, and renaming follows FAIL lines', () => {
  const stages = M.TEMPLATES.chatdev.stages();
  const moved = M.moveStage(stages, 1, -1);
  assert.deepEqual(moved.map((s) => s.id), ['programmer', 'ceo', 'reviewer', 'tester']);
  assert.equal(moved[0].retryTo, null, 'the Programmer no longer sits after its FAIL target');
  assert.equal(M.moveStage(stages, 0, -1), stages, 'the first stage cannot move earlier');
  const renamed = M.renameStage(stages, 1, 'coder');
  assert.equal(renamed[1].id, 'coder');
  assert.equal(renamed[2].retryTo, 'coder');
});

test('a unique stage id is made from the role, and the retry choices are only the earlier stages', () => {
  const stages = [M.stage({ id: 'programmer', role: 'Programmer' })];
  assert.equal(M.uniqueId(stages, 'Programmer'), 'programmer-2');
  assert.equal(M.uniqueId(stages, 'Tester'), 'tester');
  assert.deepEqual(M.retryChoices(M.TEMPLATES.chatdev.stages(), 2).map((s) => s.id), ['ceo', 'programmer', 'reviewer']);
});

test('the checks name what must be fixed before a save', () => {
  const stages = [
    M.stage({ id: 'a', role: 'A', prompt: '' }),
    M.stage({ id: 'a', role: 'B', prompt: 'p', canWait: true, verdict: true, retryTo: 'zz' }),
    M.stage({ id: 'c', role: 'C', prompt: 'p', retryTo: 'a' }),
  ];
  const text = M.problems({ id: 'bad id', name: '', stages }).join('\n');
  assert.match(text, /lowercase letters/);
  assert.match(text, /Give the workflow a name/);
  assert.match(text, /A: write what the stage should do/);
  assert.match(text, /the id a is used by another stage/);
  assert.match(text, /B: a batch stage needs a model/);
  assert.match(text, /B: pick this stage or an earlier one/);
  assert.match(text, /C: only a stage that says PASS or FAIL can send work back/);
});
