// The "Change this page" widget: what it tells the agent about the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, buildContext } = require('../ui/agent-widget');

test('an element is described as tag, id and up to three classes', () => {
    assert.equal(describe({ tagName: 'BUTTON', id: 'save', className: 'primary big  wide extra' }), 'button#save.primary.big.wide');
    assert.equal(describe({ tagName: 'DIV', id: '', className: '' }), 'div');
    assert.equal(describe({ tagName: 'svg', id: '', className: { baseVal: 'x' } }), 'svg');
    assert.equal(describe(null), '');
});

test('the context holds the page, the picked element, the selection and the last errors, all trimmed', () => {
    const ctx = buildContext({ page: '/ui/chat.html', title: 'Chat', element: { selector: 'button#save', text: '  Save \n  now ' }, selection: '  hello ', errors: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    assert.deepEqual(ctx, { page: '/ui/chat.html', title: 'Chat', element: { selector: 'button#save', text: 'Save now' }, selectedText: 'hello', consoleErrors: ['c', 'd', 'e', 'f', 'g'] });
    assert.deepEqual(buildContext({ page: '/', title: '', element: null, selection: ' ', errors: [] }), { page: '/', title: '' });
    assert.equal(buildContext({ page: 'x'.repeat(999), title: '' }).page.length, 300);
});
