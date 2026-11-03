// The run page's plain-English status, the trace filter and the workflow help (ui/runview.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const RV = require('../ui/runview');

const ev = (type, extra) => ({ t: '2026-10-30T10:00:00.000Z', type, ...extra });
const events = [
  ev('stage', { text: 'Investigator' }),
  ev('model', { text: 'Looking at the test' }),
  ev('tool', { name: 'read_file', args: { path: 'a.test.js' } }),
  ev('result', { text: 'line one' }),
  ev('tool', { name: 'run_command', args: { command: 'npm test' } }),
  ev('result', { text: 'exit code 1\nFAIL' }),
  ev('stage', { text: 'Implementer' }),
  ev('tool', { name: 'edit_file', args: { path: 'a.js' } }),
  ev('result', { text: 'edited a.js' }),
  ev('tool', { name: 'run_command', args: { command: 'npm test' } }),
  ev('result', { text: 'exit code 0\nok' }),
];

test('the quick line says what a running agent is doing, and how a finished one ended', () => {
  assert.equal(RV.quickLine({ status: 'running', events }), 'Running npm test');
  assert.equal(RV.quickLine({ status: 'running', events: [ev('tool', { name: 'edit_file', args: { path: 'x.js' } })] }), 'Editing x.js');
  assert.match(RV.quickLine({ status: 'waiting', events, pending: { text: 'rm -rf build' } }), /Waiting for you.*rm -rf build/);
  assert.match(RV.quickLine({ status: 'done', events, result: { commit: 'abc' } }), /saved on its branch/);
  assert.match(RV.quickLine({ status: 'incomplete', events, outOfBudget: true }), /cost limit/);
  assert.match(RV.quickLine({ status: 'failed', events, error: 'model call failed: 502' }), /Failed: model call failed: 502/);
});

test('the summary counts what the run did and reports its result', () => {
  const s = RV.summarize({ status: 'done', events, steps: 7, workflowName: 'Fix a bug', result: { summary: 'Fixed the off-by-one.', diffStat: ' a.js | 2 +-\n 1 file changed, 1 insertion(+)', tests: { passed: true } } });
  assert.match(s, /read 1 file, changed 1 file and run 2 commands in 7 steps/);
  assert.match(s, /1 step hit a problem, but it carried on/);
  assert.match(s, /changes 1 file and the tests pass/);
  assert.match(s, /Fixed the off-by-one/);
  assert.match(RV.summarize({ status: 'running', events: [], steps: 0 }), /has taken 0 steps and has not touched the repo yet/);
  assert.match(RV.summarize({ status: 'failed', events: [], steps: 2, error: 'boom' }), /stopped with an error: boom/);
});

test('the trace filter works by type, tool, stage and errors', () => {
  const items = RV.annotate(events);
  assert.equal(items[3].tool, 'read_file', 'a result belongs to the tool before it');
  assert.equal(items[8].stage, 'Implementer');
  assert.equal(RV.filterEvents(items, { type: 'model' }).length, 1);
  assert.equal(RV.filterEvents(items, { type: 'tool' }).length, 8);
  assert.equal(RV.filterEvents(items, { tool: 'run_command' }).length, 4);
  assert.equal(RV.filterEvents(items, { stage: 'Investigator' }).length, 6);
  assert.deepEqual(RV.filterEvents(items, { errors: true }).map((i) => i.i), [5]);
  assert.equal(RV.filterEvents(items, {}).length, events.length);
  assert.ok(RV.isError(ev('approval', { allowed: false })));
  assert.ok(!RV.isError(ev('result', { text: 'exit code 0' })));
});

test('every workflow file and the built-in ways of working have a plain explanation', () => {
  const dir = path.join(__dirname, '..', 'workflows');
  for (const f of fs.readdirSync(dir)) {
    const w = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const h = RV.help(w);
    assert.ok(h.what && h.use && h.feel, `${w.id} has what, use and feel`);
  }
  for (const id of ['auto', 'swarm', 'chatdev']) assert.ok(RV.help(id).what);
  assert.match(RV.help({ id: 'mine', when: 'a thing', stages: [{ role: 'A' }, { role: 'B' }] }).what, /A → B/);
});

test('the Wayfinder app board groups tickets by state, escapes text and links each worker', () => {
  const run = { appTickets: [
    { id: 'a', kind: 'build', title: 'Scaffold <b>', status: 'done', attempts: 1, note: 'merged', depends_on: [], decision: null, child: 'w1', diffStat: ' server.js | 4 ++--' },
    { id: 'db', kind: 'decision', title: 'Which database', status: 'done', attempts: 0, note: 'decided', depends_on: [], decision: 'Postgres & friends', child: null, diffStat: '' },
    { id: 'api', kind: 'build', title: 'API', status: 'needs_advice', attempts: 2, note: 'failed (tests)', depends_on: ['db'], decision: null, child: 'w2', diffStat: '' },
    { id: 'ui', kind: 'build', title: 'UI', status: 'skipped', attempts: 0, note: 'needs “api”', depends_on: ['api'], decision: null, child: null, diffStat: '' },
  ] };
  const html = RV.appBoard(run, [{ id: 'w1' }]);
  assert.match(html, /Ticket board/);
  assert.match(html, /<h4>Done <span class="muted">2<\/span>/);
  assert.match(html, /<h4>Needs advice/);
  assert.match(html, /<h4>Left out/);
  assert.doesNotMatch(html, /<h4>Running/);
  assert.match(html, /Scaffold &lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /Decided: Postgres &amp; friends/);
  assert.match(html, /data-go="w1"/);
  assert.match(html, /data-go="w2"/);
  assert.match(html, /try 2/);
  assert.match(html, /server\.js \| 4 \+\+--/);
  assert.equal(RV.appBoard({ appTickets: [] }), '');
});
