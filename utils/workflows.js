// Workflows: recipes an agent run follows, one JSON file each in workflows/.
// A workflow has a "when" sentence and a list of stages; each stage is one
// agent loop with a role, a tool set (read | check | all), a step budget and
// an optional effort. A stage with "verdict" must start its summary with PASS
// or FAIL; FAIL sends the run back to "retryTo" (at most maxRetries times, 5 at most).
// A stage with "canWait" is one request with no tools, sent as a half-price OpenRouter batch
// (utils/openrouterBatch.js) and waited for. A stage may name its own Gateway "model", so a critic can be a different model than
// the one whose work it checks (the run's own pinned model still wins).
// pick() lets Jev choose from the goal the same way autoStrategy picks a
// routing: one yes/no question per workflow built from its "when" line.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.HARNESS_WORKFLOWS_DIR || path.join(__dirname, '..', 'workflows');
const TOOLSETS = new Set(['read', 'check', 'all', 'none']);
const EFFORTS = new Set(['min', 'low', 'medium', 'high', 'max']);
const FALLBACK = 'general';
const MAX_ASKED = 10;
const MAX_RETRIES = 5;
const MODEL_RE = /^[\w.:/@-]+$/;

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
        if (s.tools && !TOOLSETS.has(s.tools)) throw new Error(`${file}: stage ${sid} tools must be read, check, all or none`);
        if (s.effort && !EFFORTS.has(s.effort)) throw new Error(`${file}: stage ${sid} effort is not valid`);
        if (s.canWait && !s.model) throw new Error(`${file}: stage ${sid} has canWait, so it needs a "model" (an OpenRouter batch model id)`);
        if (s.model && !MODEL_RE.test(String(s.model))) throw new Error(`${file}: stage ${sid} model must be a model name`);
        return {
            id: sid, role: String(s.role || sid), prompt: String(s.prompt), tools: s.tools || 'all',
            // 0 (the default) means the stage sets no step limit of its own (the run's still applies, if it has one)
            maxSteps: Math.min(10000, Math.max(0, Number.isFinite(Math.floor(Number(s.maxSteps))) ? Math.floor(Number(s.maxSteps)) : 0)), effort: s.effort || null,
            verdict: Boolean(s.verdict), retryTo: s.retryTo || null, maxRetries: Math.min(MAX_RETRIES, Math.max(0, Math.floor(Number(s.maxRetries)) || 0)),
            model: s.model ? String(s.model) : null,
            // canWait: one request, no tools, sent as a half-price batch and waited for (maxWaitMinutes); diff: put the working diff in it.
            // tools "none" is a step with no tools but finish; in an overnight run such a step with a batch model is batched too (runner/runs.js waitsAsBatch)
            canWait: Boolean(s.canWait), diff: Boolean(s.diff), maxWaitMinutes: Math.min(1440, Math.max(1, Math.floor(Number(s.maxWaitMinutes)) || 120)),
        };
    });
    stages.forEach((s, i) => {
        if (!s.retryTo) return;
        const at = stages.findIndex((t) => t.id === s.retryTo);
        if (at < 0) throw new Error(`${file}: stage ${s.id} retryTo names no stage`);
        if (at > i) throw new Error(`${file}: stage ${s.id} retryTo must name this stage or an earlier one`);
    });
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

// The file form of a workflow: only the fields that differ from the defaults, in a fixed order, so a saved file reads like the shipped ones.
function toFile(w) {
    const stages = w.stages.map((s) => {
        const o = { id: s.id, role: s.role };
        if (s.tools !== 'all') o.tools = s.tools;
        if (s.effort) o.effort = s.effort;
        if (s.model) o.model = s.model;
        if (s.canWait) o.canWait = true;
        if (s.canWait && s.maxWaitMinutes !== 120) o.maxWaitMinutes = s.maxWaitMinutes;
        if (s.diff) o.diff = true;
        if (s.maxSteps) o.maxSteps = s.maxSteps;
        if (s.verdict) o.verdict = true;
        if (s.retryTo) o.retryTo = s.retryTo;
        if (s.maxRetries) o.maxRetries = s.maxRetries;
        o.prompt = s.prompt;
        return o;
    });
    const o = { id: w.id, name: w.name };
    if (w.when) o.when = w.when;
    if (w.fallback) o.fallback = true;
    o.stages = stages;
    return o;
}

// Errors from save and remove carry a status: 400 for a bad workflow, 404 for a missing one, 409 for a name taken or a fallback removed.
function fail(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}
const fileOf = (id, dir) => path.join(dir || DIR, `${id}.json`);
const checkId = (id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(id || ''))) throw fail(400, 'id must be lowercase letters, digits and dashes');
    return String(id);
};

function write(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 4)}\n`);
    fs.renameSync(tmp, file);
}

/** Create (isNew) or replace a workflow file. Returns the saved workflow in file form. */
function save(raw, { id, isNew = false, dir } = {}) {
    const wanted = checkId(id);
    const file = fileOf(wanted, dir);
    if (isNew && fs.existsSync(file)) throw fail(409, `a workflow named ${wanted} already exists`);
    if (!isNew && !fs.existsSync(file)) throw fail(404, `no workflow named ${wanted}`);
    if (String(raw?.id || '') !== wanted) throw fail(400, `the id must stay ${wanted}`);
    let w;
    try { w = clean(raw, `${wanted}.json`); } catch (err) { throw fail(400, err.message); }
    const data = toFile(w);
    write(file, data);
    return data;
}

/** Delete a workflow file. The fallback can't go: a goal Jev doesn't place needs somewhere to run. */
function remove(id, dir) {
    const wanted = checkId(id);
    const file = fileOf(wanted, dir);
    if (!fs.existsSync(file)) throw fail(404, `no workflow named ${wanted}`);
    if (get(wanted, dir)?.fallback) throw fail(409, 'the fallback workflow is needed for goals Jev does not place, so it cannot be deleted');
    fs.unlinkSync(file);
}
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

module.exports = { load, get, pick, question, clean, toFile, save, remove, DIR, FALLBACK };
