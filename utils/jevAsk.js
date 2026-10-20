// Asking Jev a question about a text too long to put in an agent's context:
// split it into windows the classifier can read, ask each window the same
// question, and combine the answers. Used by POST /v1/jev/ask, which the
// ask_jev_file tools (scripts/jev-files-mcp.js) call.
//
// Jev answers a yes/no question with P(yes). "bool" turns that into
// true/false at a threshold; "scale" returns the number itself (0 to 1) for a
// statement to rate, such as "This code is hard to follow". Questions about
// the whole file ("does it contain...") take the strongest window, so one hit
// anywhere counts.

const QUESTION = 'q';
const DEFAULT_WINDOW = 2000;
const MAX_WINDOWS = 12;

function windows(text, size) {
    const out = [];
    for (let start = 0; start < text.length; start += size) out.push({ start, end: Math.min(start + size, text.length) });
    return out;
}

function line(text, offset) {
    let n = 1;
    for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * `ask(text, { q: question })` resolves to { q: P(yes) } (the Router's /ask).
 * Returns { mode, answer (bool only), score, windows, scanned, truncated, best: { line, score } }.
 */
async function askText({ text, question, mode = 'bool', ask, window = DEFAULT_WINDOW, maxWindows = MAX_WINDOWS, threshold = 0.5 }) {
    if (!['bool', 'scale'].includes(mode)) throw new Error('mode must be bool or scale');
    if (typeof question !== 'string' || !question.trim()) throw new Error('question is required');
    if (typeof text !== 'string') throw new Error('text is required');
    const size = Math.max(200, Math.floor(window) || DEFAULT_WINDOW);
    const all = windows(text, size);
    if (!all.length) all.push({ start: 0, end: 0 });
    const used = all.slice(0, Math.max(1, maxWindows));
    const scores = await Promise.all(used.map(async (w) => {
        const answers = await ask(text.slice(w.start, w.end), { [QUESTION]: question });
        const p = Number(answers?.[QUESTION]);
        if (!Number.isFinite(p)) throw new Error('the classifier gave no answer');
        return p;
    }));
    let best = 0;
    scores.forEach((p, i) => { if (p > scores[best]) best = i; });
    const score = Math.round(scores[best] * 1000) / 1000;
    const result = {
        mode, score,
        windows: all.length, scanned: used.length, truncated: used.length < all.length,
        best: { line: line(text, used[best].start), score },
    };
    if (mode === 'bool') result.answer = score >= threshold;
    return result;
}

module.exports = { askText, windows, DEFAULT_WINDOW, MAX_WINDOWS };
