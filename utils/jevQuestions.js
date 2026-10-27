// Extra questions Jev answers about every request, beside the classifier's
// "does this need a strong model?". Each one is a yes/no sentence with a bar
// ("from") and an effect when Jev's yes reaches it:
//   effort  lean the request up or down, like x-harness-effort (-1 to 1)
//   model   send requests without tools straight to this model
//   toolsModel  the same for requests with tools (blank: the question does not
//           redirect those, and only its effort applies)
// All questions go out in one /ask call. Effort effects add up, the most
// confident model effect wins. Examples: "risky" leans toward a stronger tier,
// "small talk" sends the message to the cheapest model.

const MAX_QUESTIONS = 6;
const MODEL_RE = /^[\w.:/@-]+$/;

const PRESETS = [
    { id: 'risky', ask: 'Would carrying out this request be risky, hard to undo, or easy to get subtly wrong?', from: 0.6, effort: 0.3 },
    { id: 'reasoning', ask: 'Does this request need careful step-by-step reasoning, such as maths, logic or debugging?', from: 0.6, effort: 0.2 },
    { id: 'small-talk', ask: 'Is this just small talk, a greeting or a trivial question with an obvious short answer?', from: 0.7, effort: -0.4 },
];

/** The list cleaned; throws with a readable message on a bad entry. */
function clean(list, who = 'Jev questions') {
    if (list === null || list === undefined || list === '') return [];
    if (!Array.isArray(list)) throw new Error(`${who} must be a list`);
    if (list.length > MAX_QUESTIONS) throw new Error(`${who}: at most ${MAX_QUESTIONS} questions`);
    const seen = new Set();
    return list.map((q, i) => {
        if (!q || typeof q !== 'object') throw new Error(`${who}: question ${i + 1} must be an object`);
        const id = String(q.id || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new Error(`${who}: question ${i + 1} needs a name of lowercase letters, digits and dashes`);
        if (seen.has(id)) throw new Error(`${who}: two questions are called “${id}”`);
        seen.add(id);
        const ask = String(q.ask || '').trim().slice(0, 300);
        if (!ask) throw new Error(`${who}: “${id}” needs a question`);
        const from = q.from === undefined || q.from === null || q.from === '' ? 0.6 : Number(q.from);
        if (!Number.isFinite(from) || from <= 0 || from > 1) throw new Error(`${who}: “${id}” needs a bar above 0 and up to 1`);
        const out = { id, ask, from: Math.round(from * 1000) / 1000, effort: 0, model: null, toolsModel: null };
        if (q.effort !== undefined && q.effort !== null && q.effort !== '') {
            const e = Number(q.effort);
            if (!Number.isFinite(e) || e < -1 || e > 1) throw new Error(`${who}: “${id}” effort must be from -1 to 1`);
            out.effort = Math.round(e * 1000) / 1000;
        }
        for (const k of ['model', 'toolsModel']) {
            const v = q[k];
            if (v === undefined || v === null || v === '') continue;
            if (typeof v !== 'string' || !MODEL_RE.test(v)) throw new Error(`${who}: “${id}” ${k} must be a model name`);
            out[k] = v;
        }
        if (!out.effort && !out.model && !out.toolsModel) throw new Error(`${who}: “${id}” needs an effect: an effort or a model`);
        return out;
    });
}

/**
 * Put every question to Jev in one call. `ask(text, { name: sentence })` is the
 * Router's /ask (resolves { name: P(yes) }). Never throws: no questions or no
 * answer gives { answers: {}, error }.
 */
async function ask(questions, text, askFn) {
    if (!questions?.length || !String(text || '').trim() || typeof askFn !== 'function') return { answers: {} };
    try {
        const got = await askFn(String(text).slice(-4000), Object.fromEntries(questions.map(q => [q.id, q.ask])));
        const answers = {};
        for (const q of questions) {
            const p = Number(got?.[q.id]);
            if (Number.isFinite(p)) answers[q.id] = Math.max(0, Math.min(1, Math.round(p * 1000) / 1000));
        }
        return { answers };
    } catch (err) {
        return { answers: {}, error: err.message };
    }
}

/**
 * What the answers do to a request: { shift, model, hits }. `hits` lists every
 * question whose yes reached its bar, most confident first; `model` is the first
 * hit's model for this kind of request (null when none redirects it).
 */
function apply(questions, answers, { tools = false } = {}) {
    const hits = (questions || []).filter(q => (answers?.[q.id] ?? -1) >= q.from)
        .map(q => ({ id: q.id, p: answers[q.id], effort: q.effort, model: tools ? q.toolsModel : q.model }))
        .sort((a, b) => b.p - a.p);
    const shift = Math.max(-1, Math.min(1, hits.reduce((n, h) => n + h.effort, 0)));
    const redirect = hits.find(h => h.model);
    return { shift: Math.round(shift * 1000) / 1000, model: redirect?.model || null, by: redirect?.id || null, hits };
}

module.exports = { MAX_QUESTIONS, PRESETS, clean, ask, apply };
