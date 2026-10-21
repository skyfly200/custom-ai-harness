// "Auto": pick a named strategy (utils/profiles.js) for each request. A client
// asks for it with x-harness-profile: auto. Every strategy can say when it fits:
//   rules        words in the request, tools or not, which client, size
//   description  a plain sentence Jev (the Router's classifier) is asked about
// Jev goes first: each strategy with a description is put to it as a yes/no
// question and the most likely one at or above `askAt` wins. If Jev finds no
// fit (or isn't answering), the first strategy whose rules all hold, in list
// order, wins. Nothing fits: the default strategy. The autoFirst setting can put
// the rules first, so Jev is only asked when no rule holds.

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

/** A strategy's `rules`, cleaned; throws with a readable message on a bad value. */
function cleanRules(r, name = 'A strategy') {
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

/** Why a strategy's rules hold for this request, or null if one of them doesn't. */
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

function byRules(profiles, request) {
    for (const p of profiles) {
        if (!hasRules(p)) continue;
        const why = matches(p, request);
        if (why !== null) return { profile: p, how: 'rule', why, score: null };
    }
    return null;
}

/** Ask Jev about every described strategy; { pick } the best at or above askAt, else { miss } why not. */
async function byJev(profiles, { text: prompt, ask, askAt }) {
    const described = profiles.filter(p => p.description).slice(0, MAX_ASKED);
    if (!described.length || !prompt || typeof ask !== 'function') return { miss: described.length ? 'nothing to ask Jev about' : 'no strategy has a description' };
    try {
        const answers = await ask(prompt, Object.fromEntries(described.map((p, i) => [`q${i}`, question(p)])));
        let best = null;
        described.forEach((p, i) => {
            const s = Number(answers?.[`q${i}`]);
            if (Number.isFinite(s) && (!best || s > best.score)) best = { profile: p, score: s };
        });
        if (best && best.score >= askAt) return { pick: { profile: best.profile, how: 'jev', why: `Jev ${Math.round(best.score * 100)}%`, score: best.score } };
        return { miss: best ? `Jev's best was ${Math.round(best.score * 100)}%, under ${Math.round(askAt * 100)}%` : 'Jev gave no answer', score: best?.score ?? null };
    } catch (err) {
        return { miss: `Jev unavailable (${err.message})` };
    }
}

/**
 * Choose a strategy. `ask(text, { q0: question, ... })` resolves to { q0: P(yes) }
 * (the Router's /ask). `first` says which goes first: 'jev' (the default) asks
 * Jev right away and uses the rules only if Jev finds no fit; 'rules' checks
 * them first and asks Jev only when none hold. Never throws. Returns
 * { profile (null: the default), how: 'rule' | 'jev' | 'default', why, score }.
 */
async function pick(profiles, { text: prompt, tools, client, tokens, ask, jev = true, askAt = 0.5, first = 'jev' }) {
    const request = { text: prompt, tools, client, tokens };
    if (!jev || first === 'rules') {
        const rule = byRules(profiles, request);
        if (rule) return rule;
    }
    let miss = jev ? null : 'Jev is off';
    let score = null;
    if (jev) {
        const got = await byJev(profiles, { text: prompt, ask, askAt });
        if (got.pick) return got.pick;
        miss = got.miss;
        score = got.score ?? null;
        if (first !== 'rules') {
            const rule = byRules(profiles, request);
            if (rule) return rule;
        }
    }
    return { profile: null, how: 'default', why: miss, score };
}

module.exports = { AUTO, cleanRules, hasRules, matches, pick, question };
