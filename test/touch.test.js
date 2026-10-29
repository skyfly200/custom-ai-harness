const test = require('node:test');
const assert = require('node:assert');
const T = require('../ui/touch');

test('pinching apart scales up and together scales down, within limits', () => {
  assert.strictEqual(T.pinchZoom(1, 100, 150, { min: 0.1, max: 2 }), 1.5);
  assert.strictEqual(T.pinchZoom(1, 100, 50, { min: 0.1, max: 2 }), 0.5);
  assert.strictEqual(T.pinchZoom(1, 100, 900, { min: 0.1, max: 2 }), 2);
  assert.strictEqual(T.pinchZoom(0.2, 100, 10, { min: 0.1, max: 2 }), 0.1);
});

test('a pinch with no distance leaves the scale alone', () => {
  assert.strictEqual(T.pinchZoom(0.7, 0, 50), 0.7);
  assert.strictEqual(T.pinchZoom(0.7, 50, 0), 0.7);
});

test('zoom buttons step by a quarter and stop at the limits', () => {
  assert.strictEqual(T.stepZoom(1, 1, { min: 0.1, max: 2 }), 1.25);
  assert.strictEqual(T.stepZoom(1, -1, { min: 0.1, max: 2 }), 0.8);
  assert.strictEqual(T.stepZoom(2, 1, { min: 0.1, max: 2 }), 2);
  assert.strictEqual(T.stepZoom(0.1, -1, { min: 0.1, max: 2 }), 0.1);
});

test('scroll delta keeps the point under the fingers where it was', () => {
  assert.strictEqual(T.scrollDelta(300, 1, 2), 300);
  assert.strictEqual(T.scrollDelta(300, 1, 0.5), -150);
  assert.strictEqual(T.scrollDelta(300, 0, 2), 0);
});

test('distance and midpoint of two fingers', () => {
  assert.strictEqual(T.distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.deepStrictEqual(T.midpoint({ x: 0, y: 10 }, { x: 10, y: 20 }), { x: 5, y: 15 });
});

test('a small wobble is a tap, a real move is a drag', () => {
  assert.ok(T.isTap(3, 3));
  assert.ok(!T.isTap(10, 0));
});
