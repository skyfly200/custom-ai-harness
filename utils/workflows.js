// Workflows: recipes an agent run follows, one JSON file each in workflows/.
// A workflow has a "when" sentence and a list of stages; each stage is one
// agent loop with a role, a tool set (read | check | all), a step budget and
// an optional effort. A stage with "verdict" must start its summary with PASS
// or FAIL; FAIL sends the run back to "retryTo" (at most maxRetries times).
// pick() lets Jev choose from the goal the same way autoStrategy picks a
// routing: one yes/no question per workflow built from its "when" line.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.HARNESS_WORKFLOWS_DIR || path.join(__dirname, '..', 'workflows');
const TOOLSETS = new Set(['read', 'check', 'all']);
const EFFORTS = new Set(['min', 'low', 'medium', 'high', 'max']);
const FALLBACK = 'general';
const MAX_ASKED = 10;

function clean(raw, file) {
    const id = String(raw?.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error(`${file}: id must be lowercase letters, digits and dashes`);
    if (!Array.isArray(raw.stages) || !raw.stages.length) throw new Error(`${file}: needs at least one stage`);
    const seen = new Set();
    const stages = raw.stages.map((s, i) => {
        const sid = String(s?.id || '').trim();
        if (!sid || seen.has(sid)) throw new Error(`${file}: stage ${i + 1} needs a unique id`);
        seen.add(sid);
        if (!s.prompt) throw new Error(`${file}: stage ${sid} needs a prompt`);
        if (s.tools && !TOOLSETS.has(s.tools)) throw new Error(`${file}: stage ${sid} tools must be read, check or all`);
        if (s.effort && !EFFORTS.has(s.effort)) throw new Error(`${file}: stage ${sid} effort is not valid`);
        return {
            id: sid, role: String(s.role || sid), prompt: String(s.prompt), tools: s.tools || 'all',
            // 0 means the stage sets no step limit of its own (the run's still applies)
            maxSteps: Math.min(10000, Math.max(0, Number.isFinite(Math.floor(Number(s.maxSteps))) ? Math.floor(Number(s.maxSteps)) : 30)), effort: s.effort || null,
            verdict: Boolean(s.verdict), retryTo: s.retryTo || null, maxRetries: Math.min(3, Math.max(0, Math.floor(Number(s.maxRetries)) || 0)),
        };
    });
    for (const s of stages) if (s.retryTo && !stages.some((t) => t.id === s.retryTo)) throw new Error(`${file}: stage ${s.id} retryTo names no stage`);
    return { id, name: String(raw.name || id), when: String(raw.when || ''), fallback: Boolean(raw.fallback), stages };
}

/** Every valid workflow in the folder; broken files are reported, not fatal. */
function load(dir = DIR) {
    const list = [];
    const problems = [];
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* no folder */ }
    for (const f of names) {
        try { list.push(clean(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f)); } catch (err) { problems.push(err.message); }
    }
    return { list, problems };
}

const get = (id, dir) => load(dir).list.find((w) => w.id === id) || null;
const question = (w) => `Is this task ${w.when}?`;

/**
 * Choose a workflow for a goal. `ask(text, questions)` is the Router's /ask
 * (resolves { name: P(yes) }). Highest P at or above askAt wins; otherwise the
 * fallback. Never throws. Resolves { id, by: 'jev'|'default', p, scores, note }.
 */
async function pick(goal, { ask, askAt = 0.5, dir } = {}) {
    const { list } = load(dir);
    const fallback = list.find((w) => w.fallback) || list.find((w) => w.id === FALLBACK) || list[0];
    const candidates = list.filter((w) => w !== fallback && w.when).slice(0, MAX_ASKED);
    if (!fallback) return { id: null, by: 'default', note: 'No workflows found' };
    if (!ask || !candidates.length || !String(goal || '').trim()) return { id: fallback.id, by: 'default', note: 'Jev was not asked' };
    let answers;
    try {
        answers = await ask(String(goal).slice(-4000), Object.fromEntries(candidates.map((w, i) => [`q${i}`, question(w)])));
    } catch (err) {
        return { id: fallback.id, by: 'default', note: `Jev couldn't be asked (${err.message})` };
    }
    const scores = candidates.map((w, i) => ({ id: w.id, p: Number(answers?.[`q${i}`]) || 0 })).sort((a, b) => b.p - a.p);
    const best = scores[0];
    if (best && best.p >= askAt) return { id: best.id, by: 'jev', p: best.p, scores };
    return { id: fallback.id, by: 'default', p: best?.p ?? 0, scores, note: `No workflow reached ${Math.round(askAt * 100)}%` };
}

module.exports = { load, get, pick, question, clean, DIR, FALLBACK };
