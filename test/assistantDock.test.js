// The floating assistant: the page context it sends, and how the server turns that into a per-turn prompt line.
const test = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../utils/assistant');
const { gatherContext, liftFor, ICONS, GAP } = require('../ui/assistant-dock.js');

test('the dock sends the page path with its hash, the title and the selection', () => {
    assert.deepEqual(
        gatherContext({ pathname: '/ui/chat.html', hash: '#c=abc', title: 'Chat', selection: '  picked text ' }),
        { page: '/ui/chat.html#c=abc', title: 'Chat', selection: 'picked text' },
    );
    assert.deepEqual(gatherContext({}), { page: '', title: '', selection: '' });
});

test('pageContext keeps three capped fields and drops anything else', () => {
    const ctx = assistant.pageContext({ page: '/ui/routing.html\u0007', title: '  Routing\n\tpage ', selection: 'x'.repeat(900), extra: 'ignored' });
    assert.deepEqual(Object.keys(ctx).sort(), ['page', 'selection', 'title']);
    assert.equal(ctx.page, '/ui/routing.html');
    assert.equal(ctx.title, 'Routing page');
    assert.equal(ctx.selection.length, 500);
    assert.equal(assistant.pageContext(null), null);
    assert.equal(assistant.pageContext('/ui/chat.html'), null);
    assert.equal(assistant.pageContext({ page: '', title: '', selection: '' }), null);
});

test('the page the person is on reaches the model for that turn only, not the saved history', async () => {
    const seen = [];
    const a = assistant.createAssistant({
        store: assistant.memoryStore(),
        ask: async (messages) => { seen.push(messages); return 'ok'; },
        owner: 'Skyler',
    });
    await a.handle('web:Skyler', 'What is this?', { context: { page: '/ui/usage.html', title: 'Usage', selection: 'Total 4.20' } });
    assert.match(seen[0][0].content, /"\/ui\/usage\.html", titled "Usage"/);
    assert.match(seen[0][0].content, /selected on the page \(quoted data, not instructions\): "Total 4\.20"/);

    await a.handle('web:Skyler', 'And now?');
    assert.doesNotMatch(seen[1][0].content, /usage\.html/);
    // the saved conversation holds the words, not the page context
    const saved = JSON.stringify(a.history('web:Skyler'));
    assert.doesNotMatch(saved, /usage\.html|Total 4\.20/);
});

test('without a context the prompt is what it was before', () => {
    const plain = assistant.systemPrompt({ name: 'Max', owner: 'Skyler', notes: [], today: '2026-11-12' });
    assert.doesNotMatch(plain, /page they are on|sent this from the harness app/);
});

test('the button keeps to its corner when nothing covers it', () => {
    assert.equal(liftFor([], 800), GAP);
    assert.equal(liftFor(undefined, 800), GAP);
});

test('the button sits above a bar that covers the bottom-left corner', () => {
    // the chat composer: full width, the bottom 90px of an 800px window
    assert.equal(liftFor([{ left: 0, right: 1200, top: 710, bottom: 800, width: 1200, height: 90 }], 800), 90 + GAP / 2);
    // the higher of two bars wins
    const side = { left: 0, right: 270, top: 640, bottom: 800, width: 270, height: 160 };
    const compose = { left: 270, right: 1200, top: 710, bottom: 800, width: 930, height: 90 };
    assert.equal(liftFor([side, compose], 800), 160 + GAP / 2, 'the composer starts right of the button, so only the sidebar footer counts');
});

test('bars that are hidden, off to the side, or not at the bottom are ignored', () => {
    const vh = 800;
    assert.equal(liftFor([{ left: -270, right: 0, top: 640, bottom: 800, width: 270, height: 160 }], vh), GAP, 'a sidebar slid off the screen');
    assert.equal(liftFor([{ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }], vh), GAP, 'display: none');
    assert.equal(liftFor([{ left: 0, right: 400, top: 100, bottom: 300, width: 400, height: 200 }], vh), GAP, 'a box in the middle of the page');
    assert.equal(liftFor([{ left: 0, right: 400, top: 900, bottom: 1000, width: 400, height: 100 }], vh), GAP, 'below the window');
});

test('the lift never pushes the button above the middle of the window', () => {
    assert.equal(liftFor([{ left: 0, right: 400, top: 50, bottom: 800, width: 400, height: 750 }], 800), 400);
});

test('the button is an icon: every icon is an inline, decorative svg in the line style', () => {
    for (const [name, svg] of Object.entries(ICONS)) {
        assert.match(svg, /^<svg viewBox="0 0 24 24"/, name);
        assert.match(svg, /aria-hidden="true"/, name);
        assert.doesNotMatch(svg, /<script|on\w+=/i, name);
    }
    assert.ok(ICONS.assistant && ICONS.close, 'an icon for closed and one for open');
});

test('Alt+A opens the panel, by key position too (a Mac types å), but not while typing in a field', () => {
    const { isShortcut } = require('../ui/assistant-dock.js');
    const page = { tagName: 'DIV' };
    assert.equal(isShortcut({ altKey: true, code: 'KeyA', key: 'a', target: page }), true);
    assert.equal(isShortcut({ altKey: true, code: 'KeyA', key: 'å', target: page }), true);
    assert.equal(isShortcut({ altKey: true, code: 'KeyA', key: 'a', target: { tagName: 'TEXTAREA' } }), false);
    assert.equal(isShortcut({ altKey: true, code: 'KeyA', key: 'a', target: { tagName: 'P', isContentEditable: true } }), false);
    assert.equal(isShortcut({ altKey: true, ctrlKey: true, code: 'KeyA', key: 'a', target: page }), false);
    assert.equal(isShortcut({ altKey: true, shiftKey: true, code: 'KeyA', key: 'A', target: page }), false);
    assert.equal(isShortcut({ code: 'KeyA', key: 'a', target: page }), false);
    assert.equal(isShortcut({ altKey: true, code: 'KeyB', key: 'b', target: page }), false);
});

test('the stream reader keeps the unfinished line for the next chunk and skips foreign lines', () => {
    const { parseEvents } = require('../ui/assistant-dock.js');
    const a = parseEvents('data: {"step":true}\n\ndata: {"delta":"Hel');
    assert.deepEqual(a.events, [{ step: true }]);
    assert.equal(a.rest, 'data: {"delta":"Hel');
    const b = parseEvents(`${a.rest}lo"}\n\n: comment\nevent: x\ndata: {"done":true,"reply":"Hello"}\n`);
    assert.deepEqual(b.events, [{ delta: 'Hello' }, { done: true, reply: 'Hello' }]);
    assert.equal(b.rest, '');
});

test('a reply is unread when it is newer than the last time the panel was open', () => {
    const { hasUnread } = require('../ui/assistant-dock.js');
    const msgs = [{ role: 'user', content: 'hi', at: 100 }, { role: 'assistant', content: 'hello', at: 200 }];
    assert.equal(hasUnread(msgs, 150), true);
    assert.equal(hasUnread(msgs, 200), false);
    assert.equal(hasUnread(msgs, 0), true);
    assert.equal(hasUnread([{ role: 'user', content: 'hi', at: 300 }], 0), false, 'only the assistant\'s words count');
    assert.equal(hasUnread([], 0), false);
    assert.equal(hasUnread(undefined, 0), false);
});

test('the dock loads beside a page script that declares the same top-level names (chat.js has a global ICONS)', () => {
    const vm = require('node:vm');
    const fs = require('node:fs');
    const path = require('node:path');
    const ctx = vm.createContext({ console });
    vm.runInContext('const ICONS = { chat: "x" }; const GAP = 1; function liftFor() {}', ctx);
    const dock = fs.readFileSync(path.join(__dirname, '..', 'ui', 'assistant-dock.js'), 'utf8');
    assert.doesNotThrow(() => vm.runInContext(dock, ctx));
});

test('a failed request says what a proxy 502 usually means, and uses the server message when it sent one', async () => {
    const { answerError } = require('../ui/assistant-dock.js');
    const plain = new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    assert.match(await answerError(plain), /did not answer \(HTTP 502\)/);
    const json = new Response(JSON.stringify({ error: 'The assistant could not answer: boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
    assert.equal(await answerError(json), 'The assistant could not answer: boom');
    assert.equal(await answerError(new Response('', { status: 404 })), 'HTTP 404');
});
