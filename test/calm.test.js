'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.join(__dirname, '..', 'ui');
const pages = ['chat', 'index', 'usage', 'routing', 'settings', 'agents'];

test('every page loads the calm stylesheet, which only hides things on devices that can hover', () => {
  for (const p of pages) assert.match(fs.readFileSync(path.join(ui, `${p}.html`), 'utf8'), /href="calm\.css"/, p);
  const css = fs.readFileSync(path.join(ui, 'calm.css'), 'utf8');
  const outside = css.replace(/^.*:empty.*$/m, '').replace(/@media \(hover: hover\) \{[\s\S]*?\n\}\n/g, '');
  assert.doesNotMatch(outside, /opacity:\s*0\b|display:\s*none/, 'hiding rules must sit inside @media (hover: hover)');
});

test('the installed app keeps the calm stylesheet', () => {
  assert.match(fs.readFileSync(path.join(ui, 'sw.js'), 'utf8'), /'calm\.css'/);
});

test('every page loads the phone stylesheet last and the installed app keeps it', () => {
  for (const p of ['chat', 'index', 'usage', 'routing', 'settings', 'agents', 'tools', 'users']) {
    const html = fs.readFileSync(path.join(ui, `${p}.html`), 'utf8');
    assert.ok(html.indexOf('href="mobile.css"') > html.indexOf('href="calm.css"'), p);
  }
  assert.match(fs.readFileSync(path.join(ui, 'sw.js'), 'utf8'), /'mobile\.css'/);
});

test('the chats toggle sits in the chat bar, below the top bar with the brand', () => {
  const html = fs.readFileSync(path.join(ui, 'chat.html'), 'utf8');
  const top = html.match(/<header class="top">[\s\S]*?<\/header>/)[0];
  assert.doesNotMatch(top, /toggleSide/);
  assert.match(html.match(/<div class="chatbar">[\s\S]*?<\/div>/)[0], /toggleSide/);
});
