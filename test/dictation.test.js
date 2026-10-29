const test = require('node:test');
const assert = require('node:assert');
const { sessionText, compose, describeError, wantsContinuous } = require('../ui/dictation');

const f = (transcript) => ({ transcript, isFinal: true });
const i = (transcript) => ({ transcript, isFinal: false });

test('desktop style: separate finals are joined, trailing interim kept', () => {
  assert.deepStrictEqual(sessionText([f('hello there'), f('how are you'), i('doing')]),
    { final: 'hello there how are you', interim: 'doing' });
});

test('android style: cumulative finals collapse to the longest', () => {
  const s = sessionText([f('hello'), f('hello how'), f('hello how are you')]);
  assert.deepStrictEqual(s, { final: 'hello how are you', interim: '' });
});

test('a stale shorter repeat after a longer final is ignored', () => {
  assert.strictEqual(sessionText([f('hello how are you'), f('hello how')]).final, 'hello how are you');
});

test('case and spacing differences still count as the same text', () => {
  assert.strictEqual(sessionText([f('Hello'), f(' hello  world')]).final, 'hello world');
});

test('interim that repeats the final is dropped; one that extends it keeps only the new part', () => {
  assert.strictEqual(sessionText([f('hello world'), i('world')]).interim, '');
  assert.deepStrictEqual(sessionText([f('hello'), i('hello world')]), { final: 'hello', interim: 'world' });
});

test('repeated partials of one utterance do not stack', () => {
  assert.strictEqual(sessionText([i('he'), i('hello'), i('hello wor')]).interim, 'hello wor');
});

test('empty results give empty text', () => {
  assert.deepStrictEqual(sessionText([]), { final: '', interim: '' });
  assert.deepStrictEqual(sessionText([f('  ')]), { final: '', interim: '' });
});

test('compose keeps what was typed and adds one space', () => {
  assert.strictEqual(compose('note: ', { final: 'buy milk', interim: '' }), 'note: buy milk');
  assert.strictEqual(compose('note:', { final: 'buy', interim: 'milk' }), 'note: buy milk');
  assert.strictEqual(compose('typed', { final: '', interim: '' }), 'typed');
});

test('errors: blocked mic stops with help, silence does not', () => {
  assert.strictEqual(describeError('not-allowed').stop, true);
  assert.match(describeError('audio-capture').text, /microphone/i);
  assert.strictEqual(describeError('no-speech').stop, false);
  assert.match(describeError('weird').text, /weird/);
});

test('android requests one phrase at a time', () => {
  assert.strictEqual(wantsContinuous('Mozilla/5.0 (Linux; Android 14) Chrome/130'), false);
  assert.strictEqual(wantsContinuous('Mozilla/5.0 (Windows NT 10.0) Chrome/130'), true);
});
