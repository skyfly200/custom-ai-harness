// The floating assistant: the page context it sends, and how the server turns that into a per-turn prompt line.
const test = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../utils/assistant');
const { gatherContext } = require('../ui/assistant-dock.js');

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
