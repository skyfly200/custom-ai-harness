// The thinking pane's header row must not share a class with a global rule
// (".live" made it inline-flex and squeezed the label into a column).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ui = path.join(__dirname, '..', 'ui');
const js = fs.readFileSync(path.join(ui, 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(ui, 'chat.css'), 'utf8');

test('reasoning pane modifier is not a class a global rule styles', () => {
  const m = /class="reasoning\$\{live \? ' ([\w-]+)' : ''\}"/.exec(js);
  assert.ok(m, 'reasoningHtml builds the reasoning class');
  const modifier = m[1];
  const globalRule = new RegExp(`(^|[\\s,}])\\.${modifier}\\s*\\{`, 'm');
  assert.ok(!globalRule.test(css), `chat.css styles a bare .${modifier} that the pane would inherit`);
});

test('the live text box keeps a fixed height and scrolls inside', () => {
  assert.match(css, /\.reasoning\.thinking-now > pre \{[^}]*height: 200px/);
  assert.match(css, /\.reasoning pre \{[^}]*overflow: auto/);
});
