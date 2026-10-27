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

module.exports = { parseTickets, waves, MAX_TICKETS };
