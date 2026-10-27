const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');

function loadToolCallsHtml() {
    const from = SOURCE.indexOf('function toolCallsHtml(');
    const end = SOURCE.indexOf('\n}\n\n// Whether the conversation', from) + 2;
    assert.ok(from > 0 && end > from, 'ui/chat.js has a toolCallsHtml function');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const toolLabel = () => ['shell', 'run_command'];
    const argsSummary = (s) => s || '';
    const prettyArgs = (s) => s || '';
    const fmtMs = (n) => `${n}ms`;
    return new Function('esc', 'toolLabel', 'argsSummary', 'prettyArgs', 'fmtMs', 'SHOW_RESULT', `${SOURCE.slice(from, end)}\nreturn toolCallsHtml;`)(
        esc, toolLabel, argsSummary, prettyArgs, fmtMs, 6000,
    );
}

const toolCallsHtml = loadToolCallsHtml();

test('a pending Allow tool call is surfaced with an expanded approval indicator', () => {
    const html = toolCallsHtml([{ calls: [{
        id: 'pending-1',
        name: 'run_command',
        arguments: '{"command":"npm test"}',
        approval: { state: 'ask', reason: 'The command needs approval.' },
    }] }]);

    assert.match(html, /class="tool-calls now needs-input"[^>]* open>/);
    assert.match(html, /Needs your input: allow or decline/);
    assert.match(html, /data-approve="allow"/);
    assert.match(html, /data-approve="decline"/);
    assert.match(html, /waiting for you/);
});

test('tool calls that do not need approval keep their usual summary', () => {
    const html = toolCallsHtml([{ calls: [{ id: 'call-1', name: 'run_command', arguments: '{}', result: 'done' }] }]);

    assert.match(html, /class="tool-calls ok"/);
    assert.doesNotMatch(html, /needs-input|Needs your input/);
    assert.doesNotMatch(html, /class="tool-calls ok"[^>]* open>/);
});
