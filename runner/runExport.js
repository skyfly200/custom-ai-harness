// Export a whole run as one file for debugging: what was asked, how the run was set up, every step with
// what the model said, which model answered and why, every tool call with its arguments and result, the
// tokens, cost and time of each call, and how it ended. JSON for tools and a Markdown transcript for people.
// Secrets are blanked on the way out; long text is cut with its real size noted.
'use strict';

const RESULT_CHARS = 3000;  // the run record already holds at most this much of any one text
const DIFF_CHARS = 60000;
const MD_RESULT_CHARS = 1500;

// longest first so a shorter pattern never leaves the tail of a longer one behind
const SECRETS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
    [/\b(authorization|x-api-key|api-key|x-runner-token|x-harness-password|cookie)(["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;]+/gi, '$1$2[redacted]'],
    [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
    [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|FlyV1 [^\s"']+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/g, '[redacted]'],
    [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)(\s*[=:]\s*)(?!\[redacted\])["']?[^\s"']{4,}["']?/g, '$1$2[redacted]'],
    [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@'],
];

function redact(value) {
    if (typeof value === 'string') return SECRETS.reduce((s, [re, to]) => s.replace(re, to), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
}

const num = (n) => (Number.isFinite(n) ? n : 0);
const ERROR = /^(exit code (?!0\b)-?\d+|timed out|error|blocked by|a person declined)/i;

/** A tool's result event, as { text, size, ms, truncated, error }. */
function resultOf(e) {
    if (!e) return null;
    const text = String(e.text ?? '');
    const size = num(e.size) || text.length;
    return { text, size, ms: e.ms, truncated: size > text.length || /\[\d+ more characters\]$/.test(text) || undefined, error: ERROR.test(text.trim()) || undefined };
}

/** The run's events grouped into steps: each has the model's reply, its tool calls with results, and the notes around it. */
function groupSteps(events) {
    const steps = [];
    let cur = null, open = null;
    const start = (n, t) => { cur = { step: n, t, stage: null, model: null, tools: [], notes: [] }; steps.push(cur); open = null; };
    for (const e of events || []) {
        if (e.type === 'step') { start(e.step, e.t); continue; }
        if (!cur) start(0, e.t); // notes before the first step (sandbox set-up, the pull request fetch)
        if (e.stage && !cur.stage) cur.stage = e.stage;
        if (e.type === 'model') {
            const { t, type, ...rest } = e;
            cur.model = { ...rest, at: t };
        } else if (e.type === 'tool') {
            open = { name: e.name, why: e.why, args: e.args, at: e.t, result: null };
            cur.tools.push(open);
        } else if (e.type === 'result') {
            const call = [...cur.tools].reverse().find((c) => !c.result && c.name === e.name) || open;
            if (call) call.result = resultOf(e);
        } else {
            const { type, ...rest } = e;
            cur.notes.push({ kind: type, ...rest });
        }
    }
    return steps;
}

const key = (c) => `${c.name}:${JSON.stringify(c.args)}`;
const pathOf = (c) => (c.args && typeof c.args === 'object' ? c.args.path || c.args.command : '');

/** The numbers behind "why is this taking so many steps and tokens". */
function insights(run, steps) {
    const calls = steps.flatMap((s) => s.tools.map((t) => ({ ...t, step: s.step })));
    const byTool = {};
    for (const c of calls) byTool[c.name] = (byTool[c.name] || 0) + 1;
    const dupes = {};
    for (const c of calls) { const k = key(c); (dupes[k] ||= { name: c.name, target: String(pathOf(c) || '').slice(0, 160), steps: [] }).steps.push(c.step); }
    const repeated = Object.values(dupes).filter((d) => d.steps.length > 1).sort((a, b) => b.steps.length - a.steps.length).slice(0, 10).map((d) => ({ ...d, times: d.steps.length }));
    const modelSteps = steps.filter((s) => s.model);
    const promptTokens = modelSteps.map((s) => ({ step: s.step, tokens: num(s.model.usage?.prompt_tokens), cost: num(s.model.cost) }));
    const totalIn = promptTokens.reduce((n, p) => n + p.tokens, 0);
    const firstIn = promptTokens[0]?.tokens || 0;
    const biggest = [...promptTokens].sort((a, b) => b.cost - a.cost).slice(0, 5);
    const results = calls.map((c) => c.result).filter(Boolean);
    return {
        steps: run.steps || steps.filter((s) => s.step).length,
        toolCalls: calls.length,
        callsByTool: byTool,
        failedCalls: results.filter((r) => r.error).length,
        callsWithoutWhy: calls.filter((c) => c.name !== 'finish' && !c.why).length,
        repeatedCalls: repeated,
        promptTokens: { first: firstIn, last: promptTokens.at(-1)?.tokens || 0, total: totalIn, growth: firstIn ? Number(((promptTokens.at(-1)?.tokens || 0) / firstIn).toFixed(1)) : null },
        costliestSteps: biggest,
        resultCharsTotal: results.reduce((n, r) => n + r.size, 0),
        warnings: steps.flatMap((s) => s.notes.filter((n) => n.kind === 'warning')).length,
        escalations: steps.flatMap((s) => s.notes.filter((n) => n.kind === 'note' && /stronger model/i.test(n.text || ''))).length,
        eventsDropped: Math.max(0, num(run.steps) - steps.filter((s) => s.step).length) || undefined,
    };
}

const SETTINGS = ['workflow', 'workflowName', 'profile', 'model', 'effort', 'escalate', 'maxTier', 'sandbox', 'plan', 'maxSteps', 'softSteps', 'maxMinutes', 'maxCost', 'autoDebug', 'test', 'agent', 'app', 'editable', 'moreRepos', 'kind', 'parent', 'carriesOn', 'continues', 'debugOf'];

/**
 * run: the run record. extra: { diff, commits, environment } the manager gathered from the repo.
 * Resolves a plain object, secrets already blanked.
 */
function buildExport(run, { diff = '', commits = [], environment = {} } = {}) {
    const steps = groupSteps(run.events);
    const ended = Date.parse(run.ended || '') || Date.now();
    const out = {
        format: 'harness-run-export', version: 1, exportedAt: new Date().toISOString(),
        note: 'Texts are cut to the sizes shown; secrets are blanked. Tool results hold at most the first characters the runner recorded.',
        environment,
        run: {
            id: run.id, goal: run.goal, status: run.status, repo: run.repo, branch: run.branch, base: run.base,
            created: run.created, started: run.started, ended: run.ended, durationMs: run.started ? ended - Date.parse(run.started) : null,
            settings: Object.fromEntries(SETTINGS.filter((k) => run[k] !== undefined && run[k] !== null && run[k] !== '').map((k) => [k, run[k]])),
            totals: { steps: run.steps, tokens: run.tokens, cost: run.cost, unpricedCalls: run.unpricedCalls || 0, models: run.models || {}, bumps: run.bumps || 0 },
            error: run.error || null, warning: run.warning || null, outOfSteps: run.outOfSteps || false, outOfBudget: run.outOfBudget || false,
        },
        insights: insights(run, steps),
        steps,
        result: run.result ? {
            summary: run.result.summary, commit: run.result.commit, diffStat: run.result.diffStat, tests: run.result.tests, outside: run.result.outside, salvaged: run.result.salvaged,
            commits, diff: diff.length > DIFF_CHARS ? `${diff.slice(0, DIFF_CHARS)}\n[... diff cut: ${diff.length} characters in all ...]` : diff, diffSize: diff.length,
        } : null,
    };
    return redact(out);
}

const secs = (ms) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const usd = (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const fence = (text, n = MD_RESULT_CHARS) => {
    const body = text.length > n ? `${text.slice(0, n)}\n[... ${text.length - n} more characters in the JSON export ...]` : text;
    return `\`\`\`\n${body.replaceAll('```', '`​``')}\n\`\`\``;
};
const oneLine = (v, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** The export as a Markdown transcript a person (or a model asked to diagnose the run) can read top to bottom. */
function toMarkdown(x) {
    const r = x.run, i = x.insights, o = [];
    o.push(`# Run ${r.id}: ${oneLine(String(r.goal).split('\n')[0], 120)}`, '');
    o.push(`- Status: **${r.status}**${r.error ? ` (${oneLine(r.error, 200)})` : ''}${r.warning ? ` · warning at step ${r.warning.step}` : ''}`);
    o.push(`- Branch ${r.branch} from ${String(r.base || '').slice(0, 10)} in ${r.repo}`);
    o.push(`- ${r.totals.steps || 0} steps, ${(r.totals.tokens?.in || 0).toLocaleString('en')} tokens in, ${(r.totals.tokens?.out || 0).toLocaleString('en')} out, ${usd(r.totals.cost || 0)}${r.durationMs != null ? `, ${secs(r.durationMs)}` : ''}`);
    o.push(`- Settings: ${Object.entries(r.settings).map(([k, v]) => `${k}=${oneLine(v, 60)}`).join(', ') || 'defaults'}`);
    const env = Object.entries(x.environment || {}).map(([k, v]) => `${k}=${oneLine(v, 60)}`).join(', ');
    if (env) o.push(`- Environment: ${env}`);
    o.push('', '## Prompt', '', fence(String(r.goal), 6000), '', '## What stands out', '');
    o.push(`- ${i.toolCalls} tool calls (${Object.entries(i.callsByTool).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); ${i.failedCalls} failed; ${i.callsWithoutWhy} without a stated reason.`);
    if (i.promptTokens.first) o.push(`- The prompt grew from ${i.promptTokens.first.toLocaleString('en')} to ${i.promptTokens.last.toLocaleString('en')} tokens per call (${i.promptTokens.growth}×); ${i.promptTokens.total.toLocaleString('en')} sent in all.`);
    for (const d of i.repeatedCalls.slice(0, 5)) o.push(`- Repeated ${d.times}×: ${d.name} ${oneLine(d.target, 100)} (steps ${d.steps.join(', ')})`);
    if (i.costliestSteps.length) o.push(`- Costliest steps: ${i.costliestSteps.map((s) => `${s.step} (${usd(s.cost)}, ${s.tokens.toLocaleString('en')} in)`).join(', ')}`);
    if (i.warnings || i.escalations) o.push(`- ${i.warnings} step-budget warnings, ${i.escalations} escalations to a stronger model.`);
    if (i.eventsDropped) o.push(`- ${i.eventsDropped} steps are missing from the record (it keeps the latest 2,000 events).`);
    o.push('', '## Steps', '');
    for (const s of x.steps) {
        const m = s.model;
        o.push(`### ${s.step ? `Step ${s.step}` : 'Before step 1'}${s.stage ? ` · ${s.stage}` : ''}${m ? ` · ${m.route?.model || m.model || 'model'}` : ''}`);
        if (m) {
            const u = m.usage || {};
            o.push(`${(u.prompt_tokens || 0).toLocaleString('en')} in / ${(u.completion_tokens || 0).toLocaleString('en')} out${m.cost != null ? ` · ${usd(m.cost)}` : ''}${m.ms != null ? ` · ${secs(m.ms)}` : ''}${m.route?.tier ? ` · tier ${m.route.tier}` : ''}${m.route?.effort ? ` · effort ${m.route.effort}` : ''}${m.route?.bumps ? ` (escalated ${m.route.bumps}×)` : ''}`);
            if (m.route?.reason) o.push(`Routing: ${m.route.reason}`);
            if (m.text) o.push('', ...String(m.text).split('\n').map((l) => `> ${l}`));
        }
        for (const n of s.notes) o.push('', `*${n.kind}${n.allowed === false ? ' declined' : ''}:* ${oneLine(n.text || n.why || n.reason || n.args || '', 400)}`);
        for (const t of s.tools) {
            o.push('', `- **${t.name}**${t.why ? ` — ${t.why}` : ''} \`${oneLine(t.args, 240)}\``);
            if (t.result) o.push(`  ${t.result.error ? '✗' : '→'} ${t.result.size.toLocaleString('en')} characters${t.result.ms != null ? `, ${secs(t.result.ms)}` : ''}${t.result.truncated ? ', cut' : ''}`, '', fence(t.result.text));
        }
        o.push('');
    }
    if (x.result) {
        o.push('## Result', '', fence(String(x.result.summary || '(no report)'), 4000), '');
        if (x.result.diffStat) o.push('```', x.result.diffStat, '```', '');
        if (x.result.tests) o.push(`Tests: ${x.result.tests.passed ? 'passed' : 'failed'} (\`${x.result.tests.command}\`)`, '');
        if (x.result.commits?.length) o.push('Commits:', ...x.result.commits.map((c) => `- ${c}`), '');
    }
    return o.join('\n');
}

module.exports = { buildExport, toMarkdown, redact, groupSteps, insights };
