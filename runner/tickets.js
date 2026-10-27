// A ticket draft (the JSON /wayfinder returns) turned into work for a swarm:
// the build tickets, in waves. A ticket joins the first wave after every ticket it
// depends on, so the tickets in one wave touch independent things and run side by
// side; a later wave starts from the branch the earlier waves were merged into.
// Other kinds (research, decision, build_parent) are not code to write; they are
// listed back so a person can see what was left out.
'use strict';

const MAX_TICKETS = 12;

/**
 * Check a draft and split it into build tickets and the rest.
 * Throws a message a person can act on when the draft is unusable.
 */
function parseTickets(input) {
    input = fromTracker(input);
    let draft = input;
    if (typeof draft === 'string') {
        try { draft = JSON.parse(draft); } catch { throw new Error('the ticket draft is not valid JSON'); }
    }
    const list = Array.isArray(draft) ? draft : draft?.tickets;
    if (!Array.isArray(list) || !list.length) throw new Error('the ticket draft has no tickets');
    const ids = new Set();
    for (const t of list) {
        if (!t || typeof t.id !== 'string' || !t.id.trim()) throw new Error('every ticket needs an id');
        if (ids.has(t.id)) throw new Error(`ticket id “${t.id}” is used twice`);
        ids.add(t.id);
    }
    const build = list.filter((t) => (t.kind || 'build') === 'build');
    const other = list.filter((t) => (t.kind || 'build') !== 'build').map((t) => ({ id: t.id, title: String(t.title || t.id), kind: t.kind }));
    if (!build.length) throw new Error('the draft has no build tickets to dispatch');
    if (build.length > MAX_TICKETS) throw new Error(`a draft may dispatch ${MAX_TICKETS} build tickets at most (it has ${build.length})`);
    const buildIds = new Set(build.map((t) => t.id));
    const tickets = build.map((t) => {
        const deps = (Array.isArray(t.depends_on) ? t.depends_on : []).map(String);
        for (const d of deps) if (!ids.has(d)) throw new Error(`ticket “${t.id}” depends on “${d}”, which is not in the draft`);
        return {
            id: t.id,
            title: String(t.title || t.id).slice(0, 80),
            task: [String(t.description || t.title || t.id).trim(), ...(Array.isArray(t.acceptance_criteria) && t.acceptance_criteria.length ? ['Acceptance criteria:', ...t.acceptance_criteria.map((c) => `- ${c}`)] : [])].join('\n').slice(0, 8000),
            // a dependency that is not code to write (a decision, research) is not waited for
            needs: deps.filter((d) => buildIds.has(d)),
            workflow: 'general',
        };
    });
    return { tickets, other, waves: waves(tickets) };
}

/**
 * Matt Pocock's wayfinder keeps tickets as tracker issues: a `wayfinder:<type>` label
 * (research, prototype, grilling, task), a `## Question` body, and blockers
 * (`blocked_by`, or a `Blocked by: #1, #2` line). Issues in that shape, as the JSON
 * `gh issue list --json number,title,body,labels` gives, are read as draft tickets here.
 * His tickets are decisions, so they are never `build`; a ticket that also carries a
 * `build` label (or a draft ticket with its own `kind`) keeps that. Anything else passes through.
 */
function fromTracker(input) {
    let draft = input;
    if (typeof draft === 'string') { try { draft = JSON.parse(draft); } catch { return input; } }
    const list = Array.isArray(draft) ? draft : draft?.tickets;
    if (!Array.isArray(list) || !list.some((t) => t && Array.isArray(t.labels))) return input;
    const names = (t) => (t.labels || []).map((l) => String(l?.name ?? l));
    const idOf = (t) => String(t.id ?? t.number);
    const tickets = list.map((t) => {
        const labels = names(t);
        const type = labels.find((l) => l.startsWith('wayfinder:'))?.slice(10);
        const body = String(t.body || '');
        const blocked = t.blocked_by || t.depends_on || [...(/^\s*Blocked by:\s*(.+)$/im.exec(body)?.[1].matchAll(/#(\d+)/g) || [])].map((m) => m[1]);
        return {
            id: idOf(t), title: t.title, kind: t.kind || (labels.includes('build') ? 'build' : type === 'map' ? 'map' : 'decision'),
            wayfinder_type: type || null,
            description: body.replace(/^\s*Blocked by:.*$/im, '').replace(/^##\s*Question\s*$/im, '').trim(),
            depends_on: blocked.map((b) => String(b?.number ?? b?.id ?? b).replace(/^#/, '')),
        };
    }).filter((t) => t.kind !== 'map');
    return { tickets };
}

const FOG_SECTIONS = ['Destination', 'Notes', 'Decisions so far', 'Not yet specified', 'Out of scope'];

/**
 * A draft from /wayfinder as the map and tickets of Matt Pocock's wayfinder, ready to
 * file on a tracker: one map body (his five sections) and a ticket per entry with the
 * `wayfinder:<type>` label, a `## Question` body and its blockers by draft id.
 */
function toWayfinderMap(draft) {
    const d = typeof draft === 'string' ? JSON.parse(draft) : draft;
    const dest = (d.destinations || []).map((x) => `- ${x.outcome}`).join('\n') || d.goal || '';
    const fog = (d.fog_of_war || []).map((f) => `- ${f.question} (${f.impact || 'affects the route'})`).join('\n');
    const map = ['## Destination', '', dest, '', '## Notes', '', '', '## Decisions so far', '', '', '## Not yet specified', '', fog, '', '## Out of scope', '', ''].join('\n');
    const typeOf = (t) => t.wayfinder_type || ({ research: 'research', decision: 'grilling', build: 'task', build_parent: 'task' }[t.kind] || 'task');
    const tickets = (d.tickets || []).map((t) => ({
        id: t.id, title: t.title, labels: [`wayfinder:${typeOf(t)}`, ...(t.kind === 'build' ? ['build'] : [])],
        body: `## Question\n\n${t.description || t.title}${(t.acceptance_criteria || []).length ? `\n\nAcceptance criteria:\n${t.acceptance_criteria.map((c) => `- ${c}`).join('\n')}` : ''}`,
        blocked_by: t.depends_on || [],
    }));
    return { map: { title: `Map: ${d.goal || 'untitled'}`, labels: ['wayfinder:map'], body: map }, tickets };
}

/** Ticket ids grouped into waves; throws on a cycle. */
function waves(tickets) {
    const done = new Set();
    let left = tickets.slice();
    const out = [];
    while (left.length) {
        const ready = left.filter((t) => t.needs.every((d) => done.has(d)));
        if (!ready.length) throw new Error(`the tickets depend on each other in a loop: ${left.map((t) => t.id).join(', ')}`);
        out.push(ready.map((t) => t.id));
        for (const t of ready) done.add(t.id);
        left = left.filter((t) => !done.has(t.id));
    }
    return out;
}

module.exports = { parseTickets, fromTracker, toWayfinderMap, FOG_SECTIONS, waves, MAX_TICKETS };
