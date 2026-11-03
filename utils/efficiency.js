// Workflow efficiency: which steps of a run moved the work on, which went
// round in circles, and what each model tier cost per finished run.
// Pure rules only (no I/O); the runner feeds them the run's steps. See
// docs/workflow-efficiency.md for the reasoning and the numbers chosen.
'use strict';

const REPEAT_LIMIT = 3;  // the same call this many times within the last WINDOW calls is a loop
const WINDOW = 8;
const STALL_STEPS = 4;   // this many steps in a row with no progress is a stall
// a failed call, or the agent's own refusal to repeat one (runner/agent.js): neither is progress
const ERROR_RE = /^\s*(error\b|you have made this exact call)/i;

/** A fresh per-run record of what the steps did. */
function emptyTally() {
    return { steps: 0, productive: 0, wasted: 0, wastedCost: 0, wastedTokens: 0, loops: 0, escalations: 0 };
}

/**
 * The watch a run keeps while it works. Feed it each tool call with observeCall(),
 * then call checkStep() once per step. checkStep() returns null, a 'hint' the
 * model should read, or an 'escalate' request when the hint did not help.
 */
function createWatch() {
    return { recent: [], lastText: new Map(), progress: false, stalled: 0, hints: 0, escalated: 0 };
}

/** One tool call and its result: progress unless it failed or repeated an identical result. */
function observeCall(watch, sig, text) {
    const body = String(text ?? '');
    const failed = ERROR_RE.test(body);
    const sameAsBefore = watch.lastText.get(sig) === body.slice(0, 500);
    watch.lastText.set(sig, body.slice(0, 500));
    watch.recent.push(sig);
    if (watch.recent.length > WINDOW) watch.recent.shift();
    if (!failed && !sameAsBefore) watch.progress = true;
}

/** The most times one call appears in the recent window, and which call it was. */
function worstRepeat(watch) {
    const counts = new Map();
    for (const s of watch.recent) counts.set(s, (counts.get(s) || 0) + 1);
    let best = null, n = 0;
    for (const [s, c] of counts) if (c > n) { best = s, n = c; }
    return { sig: best, count: n };
}

/** The name of a call's signature (`name:arguments`), shortened for a hint. */
function describe(sig) {
    const at = sig ? sig.indexOf(':') : -1;
    const name = at > 0 ? sig.slice(0, at) : 'a tool';
    const args = at > 0 ? sig.slice(at + 1) : '';
    return args && args !== '{}' ? `${name} ${args.slice(0, 120)}` : name;
}

/**
 * Called once per step after its tool calls ran. `progress` says whether anything
 * new came of the step (set by observeCall) and resets for the next one.
 */
function checkStep(watch) {
    const progressed = watch.progress;
    watch.progress = false;
    watch.stalled = progressed ? 0 : watch.stalled + 1;
    const worst = worstRepeat(watch);
    const looping = worst.count >= REPEAT_LIMIT;
    if (!looping && watch.stalled < STALL_STEPS) return null;
    const why = looping
        ? `you have made the call ${describe(worst.sig)} ${worst.count} times in your last ${WINDOW} calls`
        : `the last ${watch.stalled} steps produced nothing new`;
    // a hint, then (if it did not help) a request for more effort
    watch.stalled = 0;
    watch.recent = [];
    if (watch.hints === 0) {
        watch.hints += 1;
        return {
            level: 'hint',
            text: `Stop and check: ${why}. Write two short lines: what you have learned so far, and a different first step (another file, a narrower command, or a different question). Then take that step. If you are blocked, call finish and say what blocks you.`,
        };
    }
    watch.escalated += 1;
    return {
        level: 'escalate',
        text: `Still going round: ${why}, even after a hint. A stronger model is taking over the next steps; keep the same goal and try a different approach.`,
    };
}

/** Counts one run event into the run's tally. Returns the tally. */
function tally(t, e) {
    if (!t || !e) return t;
    if (e.type === 'step') { t.steps += 1; t.stepCost = 0; t.stepTokens = 0; }
    if (e.type === 'model' && e.usage) {
        t.stepCost = (t.stepCost || 0) + (Number(e.cost) || 0);
        t.stepTokens = (t.stepTokens || 0) + (e.usage.prompt_tokens || 0) + (e.usage.completion_tokens || 0);
    }
    if (e.type === 'step-end') {
        if (e.progress) t.productive += 1;
        else {
            t.wasted += 1;
            t.wastedCost = round(t.wastedCost + (t.stepCost || 0));
            t.wastedTokens += t.stepTokens || 0;
        }
        t.stepCost = 0; t.stepTokens = 0;
    }
    if (e.type === 'loop' && e.level === 'hint') t.loops += 1;
    if (e.type === 'loop' && e.level === 'escalate') t.escalations += 1;
    return t;
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** The model that made the most calls in a run's `models` map, or 'unknown'. */
function primaryModel(models) {
    let best = 'unknown', n = -1;
    for (const [name, m] of Object.entries(models || {})) if ((m?.calls || 0) > n) { best = name, n = m.calls; }
    return best;
}

/**
 * One row per primary model across runs. Each run: { status, models, cost, efficiency }.
 * Cost per success divides all the spend in the rows by the successful runs, so the
 * failed and looping runs count against the model that ran them.
 */
function byModel(runs) {
    const rows = new Map();
    for (const r of runs || []) {
        const key = primaryModel(r.models);
        const row = rows.get(key) || { model: key, runs: 0, done: 0, cost: 0, steps: 0, productive: 0, wastedCost: 0, loopRuns: 0, escalatedRuns: 0, escalatedDone: 0 };
        const eff = r.efficiency || emptyTally();
        row.runs += 1;
        const ok = r.status === 'done';
        if (ok) row.done += 1;
        row.cost = round(row.cost + (Number(r.cost) || 0));
        row.steps += eff.steps || 0;
        row.productive += eff.productive || 0;
        row.wastedCost = round(row.wastedCost + (eff.wastedCost || 0));
        if (eff.loops) row.loopRuns += 1;
        if (eff.escalations) { row.escalatedRuns += 1; if (ok) row.escalatedDone += 1; }
        rows.set(key, row);
    }
    return [...rows.values()].map((row) => ({
        ...row,
        successRate: row.runs ? round(row.done / row.runs) : 0,
        costPerSuccess: row.done ? round(row.cost / row.done) : null,
        stepsPerSuccess: row.done ? round(row.steps / row.done) : null,
        wastedShare: row.cost ? round(row.wastedCost / row.cost) : 0,
    })).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
}

/** The numbers one run is compared on. */
function profile(r) {
    const eff = r.efficiency || emptyTally();
    const steps = eff.steps || 0;
    const cost = Number(r.cost) || 0;
    const tokens = (r.tokens?.in || 0) + (r.tokens?.out || 0);
    return {
        model: primaryModel(r.models),
        status: r.status,
        done: r.status === 'done',
        steps,
        productive: eff.productive || 0,
        wasted: eff.wasted || 0,
        wastedShare: steps ? round(eff.wasted / steps) : null,
        cost: round(cost),
        tokens,
        costPerStep: steps ? round(cost / steps) : null,
        tokensPerStep: steps ? Math.round(tokens / steps) : null,
        costPerProductiveStep: eff.productive ? round(cost / eff.productive) : null,
        loops: eff.loops || 0,
        escalations: eff.escalations || 0,
        unpricedCalls: r.unpricedCalls || 0,
    };
}

// For each compared number: which way is better
const METRICS = [
    ['done', 'Finished', 'high'],
    ['steps', 'Steps', 'low'],
    ['productive', 'Steps that moved it on', 'high'],
    ['wasted', 'Wasted steps', 'low'],
    ['wastedShare', 'Wasted share of steps', 'low'],
    ['cost', 'Cost', 'low'],
    ['tokens', 'Tokens', 'low'],
    ['costPerStep', 'Cost per step', 'low'],
    ['tokensPerStep', 'Tokens per step', 'low'],
    ['costPerProductiveStep', 'Cost per step that moved it on', 'low'],
    ['loops', 'Loop hints', 'low'],
    ['escalations', 'Escalations', 'low'],
];

/**
 * Two runs of one prompt, side by side. `sameTask` is false when the goals or repos differ,
 * so the numbers are not like for like. `split` says where the cost gap comes from: more
 * steps (at the other run's cost per step) or dearer steps (over the same number of steps).
 */
function compareRuns(a, b) {
    const pa = profile(a), pb = profile(b);
    const sameTask = a.goal === b.goal && (a.repo || null) === (b.repo || null);
    const rows = METRICS.map(([key, label, better]) => {
        const x = pa[key], y = pb[key];
        let winner = null;
        if (typeof x === 'number' && typeof y === 'number' && x !== y) {
            winner = (better === 'high') === (x > y) ? 'a' : 'b';
        } else if (typeof x === 'boolean' && x !== y) winner = x ? 'a' : 'b';
        return { key, label, a: x, b: y, winner };
    });
    let split = null;
    if (pa.steps && pb.steps && pa.costPerStep !== null && pb.costPerStep !== null) {
        split = {
            costGap: round(pa.cost - pb.cost),
            fromSteps: round((pa.steps - pb.steps) * pb.costPerStep),
            fromCostPerStep: round(pa.steps * (pa.costPerStep - pb.costPerStep)),
        };
    }
    return { sameTask, a: pa, b: pb, rows, split, verdict: verdict(pa, pb, sameTask) };
}

function verdict(pa, pb, sameTask) {
    if (!sameTask) return 'These runs have different goals or repos, so the numbers are not like for like.';
    const name = (p) => p.model;
    const usd = (n) => `$${(n || 0).toFixed(4)}`;
    if (pa.done && pb.done) {
        const [cheap, dear] = pa.cost <= pb.cost ? [pa, pb] : [pb, pa];
        if (cheap.cost === dear.cost) return `Both finished for ${usd(cheap.cost)}; ${name(pa)} wasted ${pa.wasted} of ${pa.steps} steps, ${name(pb)} wasted ${pb.wasted} of ${pb.steps}.`;
        const less = dear.cost ? Math.round((1 - cheap.cost / dear.cost) * 100) : 0;
        return `Both finished. ${name(cheap)} cost ${usd(cheap.cost)}, ${less}% less than ${name(dear)} (${usd(dear.cost)}), with ${cheap.wasted} wasted steps against ${dear.wasted}.`;
    }
    if (pa.done !== pb.done) {
        const ok = pa.done ? pa : pb, other = pa.done ? pb : pa;
        return `${name(ok)} finished; ${name(other)} ended as ${other.status} after ${other.steps} steps and ${usd(other.cost)}.`;
    }
    return `Neither finished (${name(pa)}: ${pa.status}, ${name(pb)}: ${pb.status}).`;
}

module.exports = { REPEAT_LIMIT, WINDOW, STALL_STEPS, emptyTally, createWatch, observeCall, checkStep, tally, primaryModel, byModel, describe, profile, compareRuns };
