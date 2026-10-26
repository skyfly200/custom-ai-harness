// The advisor: a stronger model the chat's own model can call for a second
// opinion. This checks what the page sends and what comes back to the agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const advisor = require('../utils/advisor');

test('the tool the model is offered asks for a question and the context it needs', () => {
    const def = advisor.DEFINITION;
    assert.equal(def.type, 'function');
    assert.equal(def.function.name, 'ask_advisor');
    assert.deepEqual(def.function.parameters.required, ['question']);
    assert.match(def.function.description, /second opinion/i);
    // it must say the advisor cannot touch the repo, so the agent pastes what matters
    assert.match(def.function.parameters.properties.context.description, /cannot read the repo/);
});

test('the request goes straight to the advisor model, without tools and without streaming', () => {
    const r = advisor.request({ model: 'anthropic/claude-opus-5.5', effort: 'high' }, { question: 'Is this loop right?', context: 'for (;;) {}' });
    assert.equal(r.model, 'anthropic/claude-opus-5.5');
    assert.equal(r.stream, false);
    assert.equal(r.headers['x-harness-model'], 'anthropic/claude-opus-5.5');
    assert.equal(r.headers['x-harness-effort'], 'high');
    assert.equal(r.messages[0].role, 'system');
    assert.match(r.messages[0].content, /senior engineer/);
    assert.match(r.messages.at(-1).content, /^Is this loop right\?/);
    assert.match(r.messages.at(-1).content, /for \(;;\) \{\}/);
});

test('an advisor with no model set is refused with what to type', () => {
    assert.throws(() => advisor.request({}, { question: 'x' }), /\/advisor MODEL/);
});

test('a question with no text is refused', () => {
    assert.throws(() => advisor.prompt({ context: 'code' }), /question is required/);
});

test('a long context is cut, and so is a long answer', () => {
    const long = 'x'.repeat(advisor.MAX_CHARS + 500);
    const asked = advisor.prompt({ question: 'Why?', context: long });
    assert.ok(asked.length < advisor.MAX_CHARS + 200);
    assert.match(asked, /cut at 12000 characters/);
    const said = 'y'.repeat(advisor.MAX_REPLY + 500);
    const out = advisor.answer({ choices: [{ message: { content: said } }], usage: { cost: 0.02 } });
    assert.ok(out.text.length < advisor.MAX_REPLY + 200);
    assert.equal(out.cost, 0.02);
    assert.equal(out.isError, false);
});

test('an empty answer tells the agent to work it out instead', () => {
    const out = advisor.answer({ choices: [{ message: { content: '  ' } }] });
    assert.equal(out.isError, true);
    assert.match(out.text, /work it out/i);
});

test('the note from the person is part of how the advisor answers', () => {
    const r = advisor.request({ model: 'm', note: 'Be blunt, no praise.' }, { question: 'x' });
    assert.match(r.messages[0].content, /Be blunt, no praise\./);
});

test('a short name is what the page resolves before it calls; the setting keeps what was typed', () => {
    assert.deepEqual(advisor.setFrom('opus'), { model: 'opus' });
    assert.throws(() => advisor.setFrom('  '), /name a model/);
});
