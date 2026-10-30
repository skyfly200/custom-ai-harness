// Command guard: checks a shell command or a file write before an agent runs
// it. Rules first (guard-rules.json: deny or ask, no model call), then Jev for
// commands the rules don't cover, asked through the Router's /ask. Jev's
// confidence decides: at or above guardAskAt the agent has to ask you, at or
// above guardDenyAt (off unless set) it is blocked. Read-only commands on the
// rules file's safe list skip Jev, so `ls` and `git status` cost nothing.
// Called by POST /v1/guard; .claude/hooks/guard.js wires it into Claude Code.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, 'guard-rules.local.json');
const FILE = process.env.HARNESS_GUARD_RULES || (fs.existsSync(LOCAL) ? LOCAL : path.join(ROOT, 'guard-rules.json'));
const MAX_LOG = 200;

// Jev reads the command and answers each with P(yes)
const QUESTIONS = {
    destructive: 'Would running this shell command delete or overwrite data, rewrite git history, change a remote system or a shared environment, or do something else that is hard to undo?',
    exfiltrate: 'Does this shell command send secrets, keys, credentials or private files to another machine or the internet?',
};

let rules = { bash: [], write: [], safe: [] };
const log = [];

function compile(list, kind) {
    const out = [];
    for (const r of Array.isArray(list) ? list : []) {
        if (!r || typeof r.pattern !== 'string' || !['deny', 'ask'].includes(r.decision)) continue;
        try { out.push({ ...r, re: new RegExp(r.pattern, 'i') }); } catch (err) { console.warn(`Guard rule ${r.id || '?'} (${kind}) skipped: ${err.message}`); }
    }
    return out;
}

function load() {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (err) { console.warn(`Guard rules not read from ${FILE}: ${err.message}`); }
    rules = {
        bash: compile(data.bash, 'bash'),
        write: compile(data.write, 'write'),
        safe: Array.isArray(data.safe) ? data.safe.filter(s => typeof s === 'string') : DEFAULT_SAFE,
    };
}

// Programs that only read. A command is safe when every part of it (split on
// ; && || |) starts with one of these and nothing is redirected into a file.
const DEFAULT_SAFE = ['ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'less', 'wc', 'grep', 'rg', 'find', 'tree', 'echo', 'which', 'where',
    'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote', 'git rev-parse', 'git blame', 'git fetch',
    'node --version', 'npm --version', 'python --version', 'python3 --version', 'get-childitem', 'get-content', 'select-string'];

function isSafe(command) {
    if (/>|`|\$\(|(^|\s)-(delete|exec|execdir|ok|fprint\w*)\b/.test(command)) return false;
    const parts = command.split(/;|&&|\|\||\|/).map(s => s.trim().toLowerCase()).filter(Boolean);
    return parts.length > 0 && parts.every(p => rules.safe.some(s => p === s || p.startsWith(s + ' ')));
}

// Claude Code tool names and plain kinds -> 'bash' or 'write'
function kindOf(tool) {
    const t = String(tool || '').toLowerCase();
    if (['bash', 'shell', 'powershell', 'sh', 'exec', 'command'].includes(t)) return 'bash';
    if (['write', 'edit', 'multiedit', 'notebookedit', 'file'].includes(t)) return 'write';
    return null;
}

/** The worst rule a text matches: deny over ask, else null. */
function matchRule(kind, text) {
    let found = null;
    for (const r of rules[kind] || []) {
        if (!r.re.test(text)) continue;
        if (r.decision === 'deny') return r;
        found = found || r;
    }
    return found;
}

/**
 * Check one action. `input` is { tool, command } or { tool, path }; Claude
 * Code's hook shape { tool_name, tool_input } works too. `ask(text, questions)`
 * calls Jev and resolves to { name: P(yes) }. Never throws.
 */
async function check(input, { ask, jev = true, askAt = 0.5, denyAt = null } = {}) {
    const started = Date.now();
    const tool = input?.tool ?? input?.tool_name;
    const ti = input?.tool_input || {};
    const kind = kindOf(tool);
    const text = String(kind === 'write' ? (input?.path ?? ti.file_path ?? ti.notebook_path ?? '') : (input?.command ?? ti.command ?? '')).slice(0, 4000);
    const done = (result) => record({ tool: String(tool || ''), kind, text, ...result, ms: Date.now() - started });
    if (!kind) return done({ decision: 'allow', reason: 'Not a command or a file write, so not checked' });
    if (!text.trim()) return done({ decision: 'allow', reason: 'Nothing to check' });
    const rule = matchRule(kind, text);
    if (rule) return done({ decision: rule.decision, reason: rule.reason, rule: rule.id });
    if (kind === 'write') return done({ decision: 'allow', reason: 'No rule matches this file' });
    if (isSafe(text)) return done({ decision: 'allow', reason: 'Read-only command' });
    if (!jev || !ask) return done({ decision: 'allow', reason: 'No rule matches; Jev check is off' });
    let answers;
    try {
        answers = await ask(text, QUESTIONS);
    } catch (err) {
        // Fail open: the agent's own permission prompts still apply
        return done({ decision: 'allow', reason: `No rule matches; Jev couldn't be asked (${err.message})`, jevError: err.message });
    }
    const [worst, p] = Object.entries(answers || {}).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const what = worst === 'exfiltrate' ? 'sends private data out' : 'is destructive or hard to undo';
    const jevNote = { answers, worst };
    if (denyAt !== null && denyAt !== undefined && p >= denyAt) return done({ decision: 'deny', reason: `Jev is ${Math.round(p * 100)}% sure it ${what}`, jev: jevNote });
    if (p >= askAt) return done({ decision: 'ask', reason: `Jev is ${Math.round(p * 100)}% sure it ${what}`, jev: jevNote });
    return done({ decision: 'allow', reason: `Jev: ${Math.round(p * 100)}% likely to be risky`, jev: jevNote });
}

/**
 * Whether Jev is asked about this action. The master switch (guardJev) turns
 * it off everywhere. Inside that, a run's own choice (`jev`: 'on' or 'off')
 * wins; without one, a cloud sandbox run follows guardJevCloud (off by
 * default: the sandbox is the boundary) and everything else is asked.
 * `input.sandbox` is 'cloud' or 'local', sent by the runner.
 */
function jevOn(input, { guardJev = true, guardJevCloud = false } = {}) {
    if (!guardJev) return false;
    if (input?.jev === 'on') return true;
    if (input?.jev === 'off') return false;
    if (input?.sandbox === 'cloud') return !!guardJevCloud;
    return true;
}

function record(entry) {
    const e = { time: new Date().toISOString(), ...entry };
    log.push(e);
    if (log.length > MAX_LOG) log.shift();
    return e;
}

const recent = (n = 50) => log.slice(-n).reverse();
const counts = () => ({ bash: rules.bash.length, write: rules.write.length, safe: rules.safe.length });

load();

module.exports = { check, jevOn, load, recent, counts, isSafe, matchRule, kindOf, QUESTIONS, FILE };
