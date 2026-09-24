const test = require('node:test');
const assert = require('node:assert/strict');
const { applyContextAnchor, applyHeadroom, deriveThreshold } = require('../server');

const FILE = 'const x = 1;\n'.repeat(100); // well over the anchor minimum

test('routing scores the latest typed request, not the system prompt', () => {
    const messages = [
        { role: 'system', content: 'You can debug, refactor, and design. Always test your work.' },
        { role: 'user', content: 'rename this variable' },
    ];
    assert.equal(deriveThreshold(messages), 0.8);
});

test('routing reads Anthropic-style text blocks', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'refactor the parser' }] }];
    assert.equal(deriveThreshold(messages), 0.2);
});

test('routing skips tool-result-only turns and keeps the task routing', () => {
    const messages = [
        { role: 'user', content: 'debug the crash' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'lint ok, tests ok' }] },
    ];
    assert.equal(deriveThreshold(messages), 0.2);
});

test('anchor keeps the first copy and points later copies at it', () => {
    const out = applyContextAnchor([
        { role: 'tool', tool_call_id: 'a', content: FILE },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: FILE }] },
    ]);
    assert.equal(out[0].content, FILE);
    assert.equal(out[1].content[0].content, '[harness: identical to earlier tool result a; not repeated]');
});

test('anchor treats text-block arrays like the same string', () => {
    const out = applyContextAnchor([
        { role: 'tool', tool_call_id: 'a', content: FILE },
        { role: 'tool', tool_call_id: 'b', content: [{ type: 'text', text: FILE }] },
    ]);
    assert.match(out[1].content, /identical to earlier tool result a/);
});

test('anchor leaves short, differing, and image results alone', () => {
    const image = [{ type: 'image', source: {} }];
    const messages = [
        { role: 'tool', tool_call_id: 'a', content: 'ok' },
        { role: 'tool', tool_call_id: 'b', content: 'ok' },
        { role: 'tool', tool_call_id: 'c', content: FILE },
        { role: 'tool', tool_call_id: 'd', content: FILE + 'changed' },
        { role: 'tool', tool_call_id: 'e', content: image },
        { role: 'tool', tool_call_id: 'f', content: image },
    ];
    assert.deepEqual(applyContextAnchor(messages), messages);
});

test('anchor never touches text the user typed', () => {
    const messages = [
        { role: 'user', content: FILE },
        { role: 'user', content: [{ type: 'text', text: FILE }] },
    ];
    assert.deepEqual(applyContextAnchor(messages), messages);
});

test('Headroom still compresses tool results after the refactor', () => {
    const out = applyHeadroom([{ role: 'tool', tool_call_id: 'a', content: 'x'.repeat(10000) }]);
    assert.ok(out[0].content.length <= 4000);
    assert.match(out[0].content, /chars truncated by harness/);
});
