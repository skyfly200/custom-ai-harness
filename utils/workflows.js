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
//
// A stage has a "kind": "agent" (the default: an agent loop, as above), "branch"
// (no agent: answers yes or no, from a Jev question about the last summary, or
// from whether the last summary contains some text) or "human" (the run waits
// for a person to answer a question, with a default if nobody does in time).
// A stage's "goto" maps an outcome to the stage to run next, or "end": PASS and
// FAIL for a verdict stage, yes and no for a branch, an option for a person's
// answer. An outcome with no entry goes on to the next stage in order (a FAIL
// with no entry still follows retryTo). Every stage may run at most MAX_VISITS
// times in one run, so a loop cannot go on for ever.
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
const KINDS = new Set(['agent', 'branch', 'human']);
const MAX_VISITS = 12;      // how many times one stage may run in one run (a retry or a jump back counts)
const MAX_OPTIONS = 6;
const MAX_TIMEOUT_MINUTES = 1440;
const END = 'end';

/** The goto keys a stage may use: its outcomes. A verdict stage routes on PASS and FAIL, a branch on yes and no, a person on the options they can pick. */
function outcomesOf(s) {
    if (s.kind === 'branch') return ['yes', 'no'];
    if (s.kind === 'human') return s.options;
    if (s.kind === 'agent' && s.verdict) return ['PASS', 'FAIL'];
    return [];
}

function clean(raw, file) {
    const id = String(raw?.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error(`${file}: id must be lowercase letters, digits and dashes`);
    if (!Array.isArray(raw.stages) || !raw.stages.length) throw new Error(`${file}: needs at least one stage`);
    const seen = new Set();
    const stages = raw.stages.map((s, i) => {
        const sid = String(s?.id || '').trim();
        if (!sid || seen.has(sid)) throw new Error(`${file}: stage ${i + 1} needs a unique id`);
        seen.add(sid);
        const kind = s.kind === undefined || s.kind === null || s.kind === '' ? 'agent' : String(s.kind);
        if (!KINDS.has(kind)) throw new Error(`${file}: stage ${sid} kind must be agent, branch or human`);
        const base = { id: sid, kind, role: String(s.role || sid), prompt: '', tools: 'none', maxSteps: 0, effort: null, verdict: false, retryTo: null, maxRetries: 0, model: null, canWait: false, diff: false, maxWaitMinutes: 120,
            ask: null, contains: null, question: null, options: [], defaultOption: null, timeoutMinutes: 60, goto: cleanGotoMap(s.goto) };
        return { ...base, ...(kind === 'agent' ? cleanAgent(s, sid, file) : kind === 'branch' ? cleanBranch(s, sid, file) : cleanHuman(s, sid, file)) };
    });
    stages.forEach((s, i) => {
        if (s.retryTo) {
            const at = stages.findIndex((t) => t.id === s.retryTo);
            if (at < 0) throw new Error(`${file}: stage ${s.id} retryTo names no stage`);
            if (at > i) throw new Error(`${file}: stage ${s.id} retryTo must name this stage or an earlier one`);
        }
        cleanGoto(s, stages, file);
    });
    return { id, name: String(raw.name || id), when: String(raw.when || ''), fallback: Boolean(raw.fallback), stages };
}

// An agent stage: the loop with a prompt, tools and the rest. Its fields are checked here, as they always were.
function cleanAgent(s, sid, file) {
    if (!s.prompt) throw new Error(`${file}: stage ${sid} needs a prompt`);
    if (s.tools && !TOOLSETS.has(s.tools)) throw new Error(`${file}: stage ${sid} tools must be read, check, all or none`);
    if (s.effort && !EFFORTS.has(s.effort)) throw new Error(`${file}: stage ${sid} effort is not valid`);
    if (s.canWait && !s.model) throw new Error(`${file}: stage ${sid} has canWait, so it needs a "model" (an OpenRouter batch model id)`);
    if (s.model && !MODEL_RE.test(String(s.model))) throw new Error(`${file}: stage ${sid} model must be a model name`);
    return {
        prompt: String(s.prompt), tools: s.tools || 'all',
        // 0 (the default) means the stage sets no step limit of its own (the run's still applies, if it has one)
        maxSteps: Math.min(10000, Math.max(0, Number.isFinite(Math.floor(Number(s.maxSteps))) ? Math.floor(Number(s.maxSteps)) : 0)), effort: s.effort || null,
        verdict: Boolean(s.verdict), retryTo: s.retryTo || null, maxRetries: Math.min(MAX_RETRIES, Math.max(0, Math.floor(Number(s.maxRetries)) || 0)),
        model: s.model ? String(s.model) : null,
        // canWait: one request, no tools, sent as a half-price OpenRouter batch and waited for (maxWaitMinutes); diff: put the working diff in it.
        // tools "none" is a step with no tools but finish; in an overnight run such a step with a batch model is batched too (runner/runs.js waitsAsBatch)
        canWait: Boolean(s.canWait), diff: Boolean(s.diff), maxWaitMinutes: Math.min(1440, Math.max(1, Math.floor(Number(s.maxWaitMinutes)) || 120)),
    };
}

// A branch: yes or no from one Jev question about the last summary, or from whether that summary contains some text.
function cleanBranch(s, sid, file) {
    const ask = s.ask === undefined || s.ask === null ? '' : String(s.ask).trim();
    const contains = s.contains === undefined || s.contains === null ? '' : String(s.contains).trim();
    if (Boolean(ask) === Boolean(contains)) throw new Error(`${file}: branch ${sid} needs either "ask" (a yes/no question for Jev) or "contains" (text to look for), not both or neither`);
    if (ask.length > 500) throw new Error(`${file}: branch ${sid} ask is longer than 500 characters`);
    if (contains.length > 200) throw new Error(`${file}: branch ${sid} contains is longer than 200 characters`);
    return { tools: 'none', ask: ask || null, contains: contains || null };
}

// A person's answer: a question and either options to pick from or a free-text answer. A default is taken if nobody answers in time.
function cleanHuman(s, sid, file) {
    const question = String(s.question || '').trim();
    if (!question) throw new Error(`${file}: stage ${sid} needs a question for the person`);
    if (question.length > 1000) throw new Error(`${file}: stage ${sid} question is longer than 1000 characters`);
    const raw = Array.isArray(s.options) ? s.options : [];
    const options = [...new Set(raw.map((o) => String(o ?? '').trim()).filter(Boolean))];
    if (raw.length && !options.length) throw new Error(`${file}: stage ${sid} options must be text`);
    if (options.length > MAX_OPTIONS) throw new Error(`${file}: stage ${sid} has more than ${MAX_OPTIONS} options`);
    if (options.some((o) => o.length > 80)) throw new Error(`${file}: stage ${sid} options must be 80 characters or fewer`);
    let defaultOption = s.defaultOption === undefined || s.defaultOption === null ? '' : String(s.defaultOption).trim();
    if (options.length) {
        if (!defaultOption) defaultOption = options[0];
        if (!options.includes(defaultOption)) throw new Error(`${file}: stage ${sid} defaultOption must be one of its options`);
    } else if (defaultOption.length > 4000) throw new Error(`${file}: stage ${sid} default answer is longer than 4000 characters`);
    const minutes = Math.floor(Number(s.timeoutMinutes));
    if (s.timeoutMinutes !== undefined && (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES)) throw new Error(`${file}: stage ${sid} timeoutMinutes must be 1 to ${MAX_TIMEOUT_MINUTES}`);
    return { tools: 'none', question, options, defaultOption: defaultOption || null, timeoutMinutes: s.timeoutMinutes === undefined ? 60 : minutes };
}

// goto as stored: outcome name to stage id or "end", as text. Checked against the stage's outcomes by cleanGoto.
function cleanGotoMap(g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return {};
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [String(k), String(v ?? '')]));
}

// goto: each outcome the stage can have, to a stage in the workflow or "end". Only outcomes the stage really has are allowed.
function cleanGoto(s, stages, file) {
    const g = s.goto;
    const keys = Object.keys(g);
    if (!keys.length) return;
    const allowed = outcomesOf(s);
    if (!allowed.length) throw new Error(`${file}: stage ${s.id} can only choose where to go next if it says PASS or FAIL, is a branch, or asks a person`);
    for (const k of keys) {
        if (!allowed.includes(k)) throw new Error(`${file}: stage ${s.id} has no outcome ${k}`);
        const target = String(g[k] || '');
        if (target !== END && !stages.some((t) => t.id === target)) throw new Error(`${file}: stage ${s.id} goes to ${target || 'nothing'}, which names no stage`);
    }
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
        const o = { id: s.id };
        if (s.kind && s.kind !== 'agent') o.kind = s.kind;
        o.role = s.role;
        if (s.kind === 'branch') {
            if (s.ask) o.ask = s.ask;
            else o.contains = s.contains;
        } else if (s.kind === 'human') {
            o.question = s.question;
            if (s.options.length) o.options = s.options;
            if (s.defaultOption) o.defaultOption = s.defaultOption;
            if (s.timeoutMinutes !== 60) o.timeoutMinutes = s.timeoutMinutes;
        } else {
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
        }
        if (Object.keys(s.goto || {}).length) o.goto = { ...s.goto };
        if (s.kind === 'agent') o.prompt = s.prompt;
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

module.exports = { load, get, pick, question, clean, toFile, save, remove, outcomesOf, DIR, FALLBACK, MAX_VISITS, END };
