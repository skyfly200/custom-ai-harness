const test = require('node:test');
const assert = require('node:assert');
const { parsePrefs, shouldNotify, newWaiting, TEXT, DEFAULTS } = require('../ui/notify');

const away = { hidden: true, focused: false, permission: 'granted' };

test('preferences fall back to defaults when missing or broken', () => {
  assert.deepEqual(parsePrefs(null), DEFAULTS);
  assert.deepEqual(parsePrefs('{nope'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"on":true,"reply":false,"x":1}'), { on: true, approval: true, reply: false });
});

test('notifies only when on, allowed, the kind is enabled and you are away', () => {
  const on = { on: true, approval: true, reply: true };
  assert.equal(shouldNotify(on, 'reply', away), true);
  assert.equal(shouldNotify(on, 'run', away), true);
  assert.equal(shouldNotify({ ...on, on: false }, 'reply', away), false);
  assert.equal(shouldNotify({ ...on, reply: false }, 'reply', away), false);
  assert.equal(shouldNotify({ ...on, approval: false }, 'approval', away), false);
  assert.equal(shouldNotify(on, 'reply', { ...away, permission: 'default' }), false);
  assert.equal(shouldNotify(on, 'reply', { hidden: false, focused: true, permission: 'granted' }), false);
  assert.equal(shouldNotify(on, 'reply', { hidden: false, focused: false, permission: 'granted' }), true);
  assert.equal(shouldNotify(on, 'bogus', away), false);
});

test('only runs that newly wait on you are reported', () => {
  const seen = new Set();
  const w = (id) => ({ id, status: 'waiting', pending: { text: 'rm -rf x' } });
  assert.deepEqual(newWaiting(seen, [w('a'), { id: 'b', status: 'running' }]), ['a']);
  assert.deepEqual(newWaiting(seen, [w('a'), w('c')]), ['c']);
  assert.deepEqual(newWaiting(seen, []), []);
  assert.deepEqual(newWaiting(seen, [w('a')]), ['a']);
});

test('notification text carries no command or reply content', () => {
  for (const { title, body } of Object.values(TEXT)) assert.doesNotMatch(`${title} ${body}`, /\$|rm |`/);
});
