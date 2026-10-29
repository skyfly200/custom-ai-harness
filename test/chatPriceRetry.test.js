// The chat page must not keep a "no price" answer: after a wake from sleep the
// price list loads late, so a saved null cost is worked out again and
// model-info is asked again until the Gateway's list is in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');

test('a reply whose saved cost is null is priced again', () => {
    assert.match(src, /const replyCost = \(m\) => \(m\.cost != null && !m\.streaming/);
});

test('model-info is asked again while the Gateway or OpenRouter list is missing', () => {
    const fn = src.slice(src.indexOf('function loadModelInfo()'), src.indexOf('const fresh = (m)'));
    assert.match(fn, /j\.source === 'gateway'/);
    assert.match(fn, /j\.openrouter\.ok/);
    assert.match(fn, /setTimeout\(loadModelInfo/);
});
