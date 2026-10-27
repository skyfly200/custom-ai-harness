// The Runs page terminal: a run's events as terminal text, appended to as the run goes on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { transcript, keyOf } = require('../ui/terminal');

const ev = (type, extra) => ({ t: '2026-10-27T01:00:00.000Z', type, ...extra });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a command and its result read like a terminal', () => {
  const t = transcript([
    ev('tool', { name: 'run_command', args: { command: 'npm test' } }),
    ev('result', { name: 'run_command', text: 'exit code 1\nFAIL a.test.js\n' }),
    ev('tool', { name: 'run_command', args: { command: 'ls' } }),
    ev('result', { name: 'run_command', text: 'exit code 0\na.js\nb.js' }),
  ]);
  assert.equal(strip(t.text), '$ npm test\r\nFAIL a.test.js\r\n[exit code 1]\r\n$ ls\r\na.js\r\nb.js\r\n[exit code 0]\r\n');
  assert.match(t.text, /\x1b\[31m\[exit code 1\]/, 'a failing command ends in red');
  assert.equal(t.reset, false);
});

test('a timed out command, a read and an approval are told briefly', () => {
  const t = strip(transcript([
    ev('tool', { name: 'run_command', args: { command: 'sleep 999' } }),
    ev('result', { name: 'run_command', text: 'timed out after 120 s\npartial' }),
    ev('tool', { name: 'read_file', args: { path: 'a.js' } }),
    ev('result', { name: 'read_file', text: 'line one\nline two\nline three' }),
    ev('approval_needed', { text: 'rm -rf x', reason: 'deletes' }),
    ev('approval', { text: 'rm -rf x', allowed: false }),
    ev('model', { text: 'thinking' }),
  ]).text);
  assert.match(t, /partial\r\n\[timed out after 120 s\]/);
  assert.match(t, /> read_file a\.js\r\n {2}line one\r\n/);
  assert.doesNotMatch(t, /line two/, 'a file is not printed whole');
  assert.match(t, /\? waiting for you: rm -rf x \(deletes\)/);
  assert.match(t, /declined: rm -rf x/);
  assert.doesNotMatch(t, /thinking/);
});

test('only what is new is returned, and a lost place starts over', () => {
  const a = ev('tool', { name: 'run_command', args: { command: 'one' } });
  const b = { ...ev('result', { name: 'run_command', text: 'exit code 0\nout' }), t: '2026-10-27T01:00:01.000Z' };
  const first = transcript([a]);
  assert.equal(strip(first.text), '$ one\r\n');
  // the result arrives later and still knows which tool it answers
  const next = transcript([a, b], first.last);
  assert.equal(strip(next.text), 'out\r\n[exit code 0]\r\n');
  assert.equal(transcript([a, b], next.last).text, '');
  const lost = transcript([b], keyOf(a));
  assert.equal(lost.reset, true);
  assert.match(strip(lost.text), /exit code 0/);
});
