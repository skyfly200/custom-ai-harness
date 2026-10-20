// More than two routing tiers, and the effort a client asks for.
//
// Every routing has Strong (score >= threshold) and Weak. Extra tiers sit
// beside them, each with its own score cut-off: one above the threshold
// catches the hardest requests (a frontier model), one below it catches the
// middle ones (a mid-price model). The highest cut-off a request's score
// reaches wins; Strong counts as a tier starting at the threshold, Weak as one
// starting at 0, and those two keep their own tools / size-limit outputs.
//
// Effort (header x-harness-effort) moves the score before the tiers are
// matched: low and high by 0.2, min and max all the way, so a client can ask
// for cheaper or better answers without picking a model.

const MODEL_RE = /^[\w.:/@-]+$/;
const MAX_TIERS = 8;
const EFFORTS = { min: -1, low: -0.2, auto: 0, high: 0.2, max: 1 };

function modelName(v, what, required) {
    if (v === null || v === undefined || v === '') {
        if (required) throw new Error(`${what}: connect it to a model`);
        return null;
    }
    if (typeof v !== 'string' || !MODEL_RE.test(v)) throw new Error(`${what} must be a model name`);
    return v;
}

/** A routing's extra tiers, cleaned and sorted from the highest cut-off down; throws on a bad one. */
function clean(list, who = 'A routing') {
    if (list === null || list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`${who}: tiers must be a list`);
    if (list.length > MAX_TIERS) throw new Error(`${who}: at most ${MAX_TIERS} extra tiers`);
    const names = new Set(['strong', 'weak']);
    const out = list.map((t, i) => {
        if (!t || typeof t !== 'object') throw new Error(`${who}: tier ${i + 1} must be an object`);
        const name = typeof t.name === 'string' ? t.name.trim().slice(0, 40) : '';
        if (!name) throw new Error(`${who}: every tier needs a name`);
        if (names.has(name.toLowerCase())) throw new Error(`${who}: two tiers are called “${name}”`);
        names.add(name.toLowerCase());
        const from = Number(t.from);
        if (t.from === null || t.from === '' || !(from > 0 && from <= 1)) throw new Error(`${who}: tier “${name}” needs a score from above 0 up to 1`);
        return {
            name,
            from: Math.round(from * 1000) / 1000,
            model: modelName(t.model, `${who}: tier “${name}”`, true),
            tools: modelName(t.tools, `${who}: tier “${name}”, with tools`),
        };
    });
    return out.sort((a, b) => b.from - a.from);
}

/** How far effort moves the score: a name from EFFORTS or a number from -1 to 1. 0 when absent or unreadable. */
function effortShift(value) {
    if (value === null || value === undefined || value === '') return 0;
    const v = String(value).trim().toLowerCase();
    if (Object.hasOwn(EFFORTS, v)) return EFFORTS[v];
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
}

// Rounded so 0.6 - 0.2 is sent as 0.4, not 0.39999999999999997
const clamp01 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

/**
 * The extra tier a score lands in, or null when Strong or Weak takes it.
 * `score` is the classifier's win rate with effort already added.
 */
function pick(tiers, threshold, score, tools) {
    if (!tiers?.length || score === null || score === undefined) return null;
    const best = tiers.find(t => score >= t.from); // sorted highest first
    if (!best) return null;
    // Above the threshold Strong wins unless the tier starts at or above it too
    if (score >= threshold && best.from < threshold) return null;
    return { tier: best.name, model: (tools && best.tools) || best.model };
}

module.exports = { clean, pick, effortShift, clamp01, EFFORTS, MAX_TIERS };
