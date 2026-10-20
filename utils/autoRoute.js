// "Auto": pick a named routing (utils/profiles.js) for each request. A client
// asks for it with x-harness-profile: auto. Every routing can say when it fits:
//   rules        words in the request, tools or not, which client, size
//   description  a plain sentence Jev (the Router's classifier) is asked about
// Rules go first, in the order the routings are listed, and the first routing
// whose rules all hold wins. If none does, each routing with a description is
// put to Jev as a yes/no question and the most likely one at or above `askAt`
// wins. No match, or Jev not answering: the default routing.

const AUTO = 'auto';
const MAX_ASKED = 8;
const MAX_WORDS = 20;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const count = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number`);
    return n;
};

/** A routing's `rules`, cleaned; throws with a readable message on a bad value. */
function cleanRules(r, name = 'A routing') {
    const rules = r && typeof r === 'object' ? r : {};
    const list = (v) => [...new Set((Array.isArray(v) ? v : []).map(s => text(s, 60).toLowerCase()).filter(Boolean))].slice(0, MAX_WORDS);
    const tools = ['yes', 'no'].includes(rules.tools) ? rules.tools : 'any';
    const out = {
        words: list(rules.words),
        tools,
        clients: list(rules.clients),
        minTokens: count(rules.minTokens, `${name}: the smallest size`),
        maxTokens: count(rules.maxTokens, `${name}: the largest size`),
    };
    if (out.minTokens !== null && out.maxTokens !== null && out.minTokens > out.maxTokens) throw new Error(`${name}: the smallest size is above the largest`);
    return out;
}

const hasRules = (p) => !!p.rules && (p.rules.words.length > 0 || p.rules.tools !== 'any' || p.rules.clients.length > 0 || p.rules.minTokens !== null || p.rules.maxTokens !== null);

/** Why a routing's rules hold for this request, or null if one of them doesn't. */
function matches(p, { text: prompt, tools, client, tokens }) {
    const r = p.rules;
    const why = [];
    if (r.words.length) {
        const lower = (prompt || '').toLowerCase();
        const hit = r.words.find(w => lower.includes(w));
        if (!hit) return null;
        why.push(`“${hit}” in the request`);
    }
    if (r.tools !== 'any') {
        if ((r.tools === 'yes') !== !!tools) return null;
        why.push(tools ? 'has tools' : 'no tools');
    }
    if (r.clients.length) {
        const c = (client || '').toLowerCase();
        const hit = r.clients.find(w => c.includes(w));
        if (!hit) return null;
        why.push(`from ${client}`);
    }
    if (r.minTokens !== null) { if (tokens < r.minTokens) return null; why.push(`${r.minTokens}+ tokens`); }
    if (r.maxTokens !== null) { if (tokens > r.maxTokens) return null; why.push(`under ${r.maxTokens} tokens`); }
    return why.join(', ');
}

const question = (p) => `Is this request something like: ${p.description}?`;

/**
 * Choose a routing. `ask(text, { q0: question, ... })` resolves to { q0: P(yes) }
 * (the Router's /ask). Never throws. Returns
 * { profile (null: the default), how: 'rule' | 'jev' | 'default', why, score }.
 */
async function pick(profiles, { text: prompt, tools, client, tokens, ask, jev = true, askAt = 0.5 }) {
    const request = { text: prompt, tools, client, tokens };
    for (const p of profiles) {
        if (!hasRules(p)) continue;
        const why = matches(p, request);
        if (why !== null) return { profile: p, how: 'rule', why, score: null };
    }
    const described = profiles.filter(p => p.description).slice(0, MAX_ASKED);
    if (!jev || !described.length || !prompt || typeof ask !== 'function') {
        return { profile: null, how: 'default', why: described.length && jev ? 'nothing to ask Jev about' : 'no routing fits', score: null };
    }
    try {
        const questions = Object.fromEntries(described.map((p, i) => [`q${i}`, question(p)]));
        const answers = await ask(prompt, questions);
        let best = null;
        described.forEach((p, i) => {
            const s = Number(answers?.[`q${i}`]);
            if (Number.isFinite(s) && (!best || s > best.score)) best = { profile: p, score: s };
        });
        if (best && best.score >= askAt) return { profile: best.profile, how: 'jev', why: `Jev ${Math.round(best.score * 100)}%`, score: best.score };
        return { profile: null, how: 'default', why: best ? `Jev's best was ${Math.round(best.score * 100)}%, under ${Math.round(askAt * 100)}%` : 'no routing fits', score: best?.score ?? null };
    } catch (err) {
        return { profile: null, how: 'default', why: `Jev unavailable (${err.message})`, score: null };
    }
}

module.exports = { AUTO, cleanRules, hasRules, matches, pick, question };
