'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.join(__dirname, '..', 'ui');
const pages = ['chat', 'index', 'usage', 'routing', 'settings', 'runs'];

test('every page loads the calm stylesheet, which only hides things on devices that can hover', () => {
  for (const p of pages) assert.match(fs.readFileSync(path.join(ui, `${p}.html`), 'utf8'), /href="calm\.css"/, p);
  const css = fs.readFileSync(path.join(ui, 'calm.css'), 'utf8');
  const outside = css.replace(/^.*:empty.*$/m, '').replace(/@media \(hover: hover\) \{[\s\S]*?\n\}\n/g, '');
  assert.doesNotMatch(outside, /opacity:\s*0\b|display:\s*none/, 'hiding rules must sit inside @media (hover: hover)');
});

test('the installed app keeps the calm stylesheet', () => {
  assert.match(fs.readFileSync(path.join(ui, 'sw.js'), 'utf8'), /'calm\.css'/);
});
