'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(ui, f), 'utf8');

test('every routing dialog sets its own text colour (a dialog does not inherit it, so dark mode was black on dark)', () => {
  const html = read('routing.html');
  const css = read('routing.css');
  assert.match(css, /dialog\.card\s*\{[^}]*color:\s*var\(--text\)/);
  for (const id of html.match(/<dialog id="\w+" class="card/g)) assert.ok(id, 'dialogs use the card class');
  assert.match(html, /<input type="text" id="newName"/, 'the name box is a typed text field, so it gets the themed field style');
});

test('model boxes keep numbers, provider models and fallbacks behind a Details row that survives redraws', () => {
  const js = read('routing.js');
  assert.match(js, /<details class="more" data-more=/);
  assert.match(js, /const openMore = new Set\(\)/);
  assert.match(js, /addEventListener\('toggle'/);
});
