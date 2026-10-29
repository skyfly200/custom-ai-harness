'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.join(__dirname, '..', 'ui');
const files = fs.readdirSync(ui).filter((f) => /\.(js|html)$/.test(f) && f !== 'dialogs.js' && f !== 'sw.js');

test('the web UI never calls the browser alert, confirm or prompt (use ui.toast, ui.confirm, ui.prompt)', () => {
  const found = [];
  for (const f of files) {
    fs.readFileSync(path.join(ui, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/(^|[^.\w$])(window\.)?(alert|confirm|prompt)\s*\(/.test(line)) found.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(found, []);
});

test('every page that has scripts loads dialogs.js before them', () => {
  for (const f of fs.readdirSync(ui).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ui, f), 'utf8');
    if (!/<script src=/.test(html)) continue;
    const at = html.indexOf('src="dialogs.js"');
    assert.ok(at >= 0, `${f} must load dialogs.js`);
    assert.strictEqual(html.indexOf('<script'), html.lastIndexOf('<script', at), `${f}: dialogs.js must be the first script`);
  }
});

test('dialogs.js is cached by the installed app', () => {
  assert.match(fs.readFileSync(path.join(ui, 'sw.js'), 'utf8'), /'dialogs\.js'/);
});
