// A /wayfinder ticket draft as wayfinder markdown files in the repo, and back again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const tf = require('../runner/ticketFiles');
const { parseTickets } = require('../runner/tickets');
const { createApp } = require('../runner/server');

const draft = {
    goal: 'Add export',
    destinations: [{ outcome: 'Users can export CSV' }],
    fog_of_war: [{ question: 'Which columns?', impact: 'changes the schema' }],
    tickets: [
        { id: 'ui', kind: 'build', title: 'Export button', description: 'Add the button', depends_on: ['api'], acceptance_criteria: ['it downloads'] },
        { id: 'api', kind: 'build', title: 'Export endpoint', description: 'Add GET /export' },
        { id: 'cols', kind: 'decision', title: 'Choose columns', description: 'Which?' },
    ],
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tf-'));

test('the plan has a map and one file per ticket, blockers first, linked to each other', () => {
    const p = tf.plan(draft);
    assert.equal(p.folder, 'add-export');
    assert.deepEqual(p.files.map((f) => f.name), ['map.md', 'api.md', 'cols.md', 'ui.md']);
    const ui = p.files.find((f) => f.name === 'ui.md').text;
    assert.match(ui, /^---\nid: "ui"\ntitle: "Export button"\nlabels: \["wayfinder:task","build"\]\nblocked_by: \["api"\]\nstatus: open\n---/);
    assert.match(ui, /## Question\n\nAdd the button\n\nAcceptance criteria:\n- it downloads/);
    assert.match(ui, /Blocked by: \[Export endpoint\]\(api\.md\)/);
    assert.match(ui, /Part of \[the map\]\(map\.md\)/);
    const map = p.files[0].text;
    assert.match(map, /## Destination\n\n- Users can export CSV/);
    assert.match(map, /## Notes\n\n- \[ \] \[Export endpoint\]\(api\.md\)\n- \[ \] \[Choose columns\]\(cols\.md\)\n- \[ \] \[Export button\]\(ui\.md\)/);
});

test('bad drafts are refused', () => {
    assert.throws(() => tf.plan({ tickets: [{ id: 'a', title: 'A', depends_on: ['zz'] }] }), /not in the draft/);
    assert.throws(() => tf.plan({ tickets: [{ id: 'a', title: 'A', depends_on: ['b'] }, { id: 'b', title: 'B', depends_on: ['a'] }] }), /loop/);
    assert.throws(() => tf.plan({ tickets: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }), /used twice/);
    assert.throws(() => tf.plan({ tickets: [{ id: '1', title: 'x', labels: [{ name: 'wayfinder:research' }] }] }), /already tracker issues/);
    assert.throws(() => tf.plan({ tickets: [] }), /no tickets/);
});

test('ids that clean to the same file name get a number, and a second save goes to a new folder', () => {
    const repo = tmp();
    const d = { goal: 'x', tickets: [{ id: 'A b', title: 'one' }, { id: 'a-b', title: 'two' }] };
    const first = tf.writeFiles(d, repo);
    assert.deepEqual(first.files, ['map.md', 'a-b.md', 'a-b-2.md']);
    const second = tf.writeFiles(d, repo);
    assert.equal(second.relative, 'wayfinder/x-2');
    assert.ok(fs.existsSync(path.join(repo, 'wayfinder', 'x', 'map.md')));
});

test('what is written reads back into the same tickets, ready for a swarm', () => {
    const repo = tmp();
    const { dir } = tf.writeFiles(draft, repo);
    const back = tf.readTicketFiles(dir);
    assert.equal(back.goal, 'Add export');
    const byId = Object.fromEntries(back.tickets.map((t) => [t.id, t]));
    assert.deepEqual(byId.ui.depends_on, ['api']);
    assert.equal(byId.ui.kind, 'build');
    assert.equal(byId.cols.kind, 'decision');
    assert.match(byId.ui.description, /^Add the button\n\nAcceptance criteria:\n- it downloads$/);
    // a swarm takes the build tickets, api first
    const parsed = parseTickets({ tickets: back.tickets });
    assert.deepEqual(parsed.waves, [['api'], ['ui']]);
    assert.deepEqual(parsed.other.map((t) => t.id), ['cols']);
    // a hand-written file without front matter is skipped, not fatal
    fs.writeFileSync(path.join(dir, 'notes.md'), '# my notes\n');
    assert.deepEqual(tf.readTicketFiles(dir).skipped, ['notes.md']);
    assert.throws(() => tf.readTicketFiles(tmp()), /no ticket files/);
});

test('the runner previews, writes after confirm, and reads back inside the repo only', async () => {
    const repo = fs.realpathSync(tmp());
    let handler;
    const server = await new Promise((r) => { const s = http.createServer((q, a) => handler(q, a)).listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    handler = createApp({ checkRepo: (r) => { if (r !== repo) throw new Error('not a repo'); return repo; } }, { port });
    const post = (p, body) => fetch(`http://127.0.0.1:${port}/tickets/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
        const preview = await (await post('files', { tickets: draft, repo })).json();
        assert.equal(preview.folder, 'wayfinder/add-export');
        assert.ok(!fs.existsSync(path.join(repo, 'wayfinder')), 'a preview writes nothing');
        const made = await post('files', { tickets: draft, repo, confirm: true });
        assert.equal(made.status, 201);
        assert.equal((await made.json()).relative, 'wayfinder/add-export');
        const read = await (await post('read', { repo, folder: 'wayfinder/add-export' })).json();
        assert.equal(read.tickets.length, 3);
        assert.equal((await post('read', { repo, folder: '../../etc' })).status, 400);
        assert.equal((await post('files', { tickets: draft, repo: '/nowhere' })).status, 400);
    } finally { server.close(); }
});
