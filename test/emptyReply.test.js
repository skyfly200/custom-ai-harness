// A model that answers with nothing at all — it thinks the whole answer and stops,
// or plans a tool call it never sends — must not leave the chat showing
// "(empty reply)" with no explanation. The page tries once more, and says why
// when that is empty too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');

// emptyNote is a plain function inside the page's closure: pull it out and run it.
function loadEmptyNote() {
    const from = SOURCE.indexOf('function emptyNote(');
    assert.ok(from > 0, 'ui/chat.js has an emptyNote');
    const to = SOURCE.indexOf('\n// Text from the model', from);
    assert.ok(to > from, 'emptyNote ends before appendText');
    return new Function(`${SOURCE.slice(from, to)}\nreturn emptyNote;`)();
}

const emptyNote = loadEmptyNote();

test('an empty reply cut off by the output cap says to raise Max tokens', () => {
    const said = emptyNote({}, { finish: 'length' });
    assert.match(said, /output cap/);
    assert.match(said, /Max tokens/);
    assert.match(said, /was tried twice/, 'it says the reply was tried twice');
});

test('an empty reply says when a tool call came through with no name', () => {
    assert.match(emptyNote({}, { finish: 'stop', droppedCalls: 2 }), /2 calls arrived with no name/);
    assert.match(emptyNote({}, { finish: 'stop', droppedCalls: 1 }), /the call arrived with no name/);
});

test('an empty reply in a repo chat with no tool list blames the harness, not the model', () => {
    assert.match(emptyNote({ toolsMissing: true }, { finish: 'stop' }), /tool list could not be loaded/);
});

test('an empty reply still names the finish reason it got', () => {
    assert.match(emptyNote({}, { finish: 'stop' }), /finish reason: stop/);
    assert.match(emptyNote({}, {}), /no finish reason/);
    assert.match(emptyNote({}, { finish: 'content_filter' }), /content filter/);
});

test('how much the model thought before stopping is part of the note', () => {
    assert.match(emptyNote({ reasoning: 'x'.repeat(1234) }, { finish: 'stop' }), /thought for 1,234 characters/);
});

// The reply loop only retries an empty round once, and only when nothing at all
// came back: no text and no tool call. A round that ran tools must not reset it.
test('the loop retries an empty round once, at the same size unless it was cut off', () => {
    const at = SOURCE.indexOf('if (!calls.length && !reply.content.slice(before).trim() && !reply.emptyRetried)');
    assert.ok(at > 0, 'runReply retries an empty round');
    const block = SOURCE.slice(at, SOURCE.indexOf('if (calls.length) toolRounds++;', at));
    assert.match(block, /reply\.emptyRetried = true/, 'the retry is remembered on the reply');
    assert.match(block, /tr\.finish === 'length'/, 'a cut-off answer asks for more room');
    assert.match(block, /moreRoom = Math\.min\(Math\.max\(maxTokens, 1024\) \* 2, 32768\)/, 'and no more than 32k');
    assert.match(block, /continue;/, 'the retry is another round');
});

test('the finish reason is read from a stream and from a plain reply', () => {
    assert.match(SOURCE, /if \(choice\?\.finish_reason\) tr\.finish = choice\.finish_reason;/, 'from the stream');
    assert.match(SOURCE, /tr\.finish = j\.choices\?\.\[0\]\?\.finish_reason;/, 'from a whole reply');
});

test('Max tool rounds counts the rounds that ran tools, not the empty retry', () => {
    assert.match(SOURCE, /if \(maxRounds && toolRounds >= maxRounds\)/);
    assert.match(SOURCE, /if \(calls\.length\) toolRounds\+\+;/);
});
