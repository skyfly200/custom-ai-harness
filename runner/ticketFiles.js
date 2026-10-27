// A /wayfinder ticket draft as markdown files in the repo, in Matt Pocock's wayfinder
// layout: wayfinder/<map-slug>/map.md (Destination, Notes, Decisions so far, Not yet
// specified, Out of scope) and one file per ticket with a `wayfinder:<type>` label, a
// `## Question` body and its blockers. Plain files a person can read, edit and commit;
// readTicketFiles() reads the folder back into a draft a swarm can work, so the
// two directions stay interchangeable. toWayfinderMap() in tickets.js builds the text.
'use strict';

const fs = require('fs');
const path = require('path');
const { toWayfinderMap, fromTracker } = require('./tickets');

const MAX_FILED = 40;
const ROOT = 'wayfinder';

const slug = (s, fallback) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || fallback;

/** Tickets in an order where every blocker comes first; throws on a missing blocker or a loop. */
function inOrder(tickets) {
    const ids = new Set(tickets.map((t) => t.id));
    for (const t of tickets) for (const d of t.blocked_by) if (!ids.has(String(d))) throw new Error(`ticket “${t.id}” is blocked by “${d}”, which is not in the draft`);
    const out = [];
    const done = new Set();
    let left = tickets.slice();
    while (left.length) {
        const ready = left.filter((t) => t.blocked_by.every((d) => done.has(String(d))));
        if (!ready.length) throw new Error(`the tickets block each other in a loop: ${left.map((t) => t.id).join(', ')}`);
        for (const t of ready) { out.push(t); done.add(t.id); }
        left = left.filter((t) => !done.has(t.id));
    }
    return out;
}

/** What would be written, without touching disk: { dir, files: [{ name, text, title }] }. */
function plan(draft) {
    const d = typeof draft === 'string' ? JSON.parse(draft) : draft;
    const list = Array.isArray(d) ? d : d?.tickets;
    if (!Array.isArray(list) || !list.length) throw new Error('the ticket draft has no tickets');
    if (list.length > MAX_FILED) throw new Error(`a draft may hold ${MAX_FILED} tickets at most (it has ${list.length})`);
    if (list.some((t) => t && Array.isArray(t.labels))) throw new Error('these are already tracker issues; there is nothing to write');
    const seen = new Set();
    for (const t of list) {
        if (!t || typeof t.id !== 'string' || !t.id.trim()) throw new Error('every ticket needs an id');
        if (seen.has(t.id)) throw new Error(`ticket id “${t.id}” is used twice`);
        seen.add(t.id);
    }
    const filed = toWayfinderMap(Array.isArray(d) ? { tickets: d } : d);
    const tickets = inOrder(filed.tickets);
    // file names come from the ids; two ids that clean to the same name get a number
    const names = new Map();
    const taken = new Set(['map']);
    for (const t of tickets) {
        let base = slug(t.id, 'ticket');
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
        taken.add(name);
        names.set(t.id, `${name}.md`);
    }
    const link = (id) => `[${tickets.find((t) => t.id === id).title}](${names.get(id)})`;
    const files = tickets.map((t) => {
        const blockers = t.blocked_by.map(String);
        const front = ['---', `id: ${JSON.stringify(t.id)}`, `title: ${JSON.stringify(t.title)}`, `labels: ${JSON.stringify(t.labels)}`, `blocked_by: ${JSON.stringify(blockers)}`, 'status: open', '---'].join('\n');
        const text = `${front}\n\n# ${t.title}\n\n${t.body}\n${blockers.length ? `\nBlocked by: ${blockers.map(link).join(', ')}\n` : ''}\nPart of [the map](map.md)\n`;
        return { name: names.get(t.id), title: t.title, text, id: t.id, labels: t.labels, blockedBy: blockers };
    });
    const notes = files.map((f) => `- [ ] [${f.title}](${f.name})`).join('\n');
    const mapText = `---\ntitle: ${JSON.stringify(filed.map.title)}\nlabels: ${JSON.stringify(filed.map.labels)}\n---\n\n# ${filed.map.title}\n\n${filed.map.body.replace('## Notes\n\n', `## Notes\n\n${notes}\n`)}\n`;
    return { folder: slug(d.goal || filed.map.title, 'map'), files: [{ name: 'map.md', title: filed.map.title, text: mapText }, ...files] };
}

/** Write the plan under <repo>/wayfinder/<map>/ (a numbered folder if that one exists). Resolves { dir, relative, files }. */
function writeFiles(draft, repoDir) {
    const p = plan(draft);
    const base = path.join(repoDir, ROOT);
    let name = p.folder;
    for (let n = 2; fs.existsSync(path.join(base, name)); n++) name = `${p.folder}-${n}`;
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of p.files) fs.writeFileSync(path.join(dir, f.name), f.text, { flag: 'wx' });
    return { dir, relative: path.posix.join(ROOT, name), files: p.files.map((f) => f.name) };
}

/** A tiny front matter reader for the files above: `key: JSON value` lines between --- fences. */
function frontMatter(text) {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) return { data: {}, body: text };
    const data = {};
    for (const line of m[1].split('\n')) {
        const kv = /^(\w+):\s*(.*)$/.exec(line);
        if (!kv) continue;
        try { data[kv[1]] = JSON.parse(kv[2]); } catch { data[kv[1]] = kv[2]; }
    }
    return { data, body: m[2] };
}

/**
 * Read a wayfinder folder (map.md plus ticket files, written here or by hand) back into
 * a draft: { goal, tickets }, in the same shape parseTickets takes. Resolves nothing
 * outside `dir`; a file without an id is skipped and named in `skipped`.
 */
function readTicketFiles(dir) {
    const skipped = [];
    const issues = [];
    let goal = '';
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
        const { data, body } = frontMatter(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (name === 'map.md') { goal = String(data.title || '').replace(/^Map:\s*/, ''); continue; }
        if (!data.id) { skipped.push(name); continue; }
        const question = /##\s*Question\s*\n+([\s\S]*?)(?:\n\s*Blocked by:|\n\s*Part of |$)/i.exec(body);
        issues.push({ id: String(data.id), title: String(data.title || data.id), labels: Array.isArray(data.labels) ? data.labels : [], body: (question ? question[1] : body).trim(), blocked_by: (Array.isArray(data.blocked_by) ? data.blocked_by : []).map(String) });
    }
    if (!issues.length) throw new Error('that folder has no ticket files');
    return { goal, tickets: fromTracker({ tickets: issues }).tickets, skipped };
}

module.exports = { plan, writeFiles, readTicketFiles, inOrder, slug, MAX_FILED, ROOT };
