const test = require('node:test');
const assert = require('node:assert');
const { fitZoom } = require('../ui/fit');

test('a layout that already fits is not scaled', () => {
  assert.strictEqual(fitZoom(600, 300, 1200, 600), 1);
});

test('a large layout is scaled so it fits the canvas with room to spare', () => {
  const z = fitZoom(3800, 2200, 1248, 590);
  assert.ok(z < 1);
  assert.ok(3800 * z <= 1248 - 30);
  assert.ok(2200 * z <= 590 - 30);
});

test('the tighter side decides, on a phone as well', () => {
  const z = fitZoom(1000, 1800, 390, 700);
  assert.ok(1000 * z <= 390 - 30 && 1800 * z <= 700 - 30);
});

test('never below the minimum', () => {
  assert.strictEqual(fitZoom(40000, 30000, 1200, 600), 0.05);
  assert.strictEqual(fitZoom(40000, 30000, 1200, 600, { min: 0.4 }), 0.4);
});

test('an empty layout or canvas gives a sane scale', () => {
  assert.strictEqual(fitZoom(0, 0, 1200, 600), 1);
  assert.strictEqual(fitZoom(500, 500, 0, 0), 0.05);
});
