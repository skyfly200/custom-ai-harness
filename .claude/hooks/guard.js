// PreToolUse hook: asks the harness's command guard (POST /v1/guard) about
// each Bash command and file write before Claude Code runs it. "deny" blocks
// it with the reason, "ask" makes Claude Code ask you first, "allow" leaves
// your normal permission settings in charge (it never approves on its own).
//
// Add it to ~/.claude/settings.json (every project) or a project's
// .claude/settings.json:
//   "PreToolUse": [{ "matcher": "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
//     "hooks": [{ "type": "command", "command": "node /path/to/custom-ai-harness/.claude/hooks/guard.js" }] }]
// HARNESS_GUARD_URL changes where it asks (default http://localhost:3000/v1/guard);
// HARNESS_PASSWORD is sent when set. If the harness doesn't answer within
// HARNESS_GUARD_TIMEOUT_MS (5000) the command goes ahead: set
// HARNESS_GUARD_STRICT=1 to have Claude Code ask you instead.

const fs = require('fs');

const URL = process.env.HARNESS_GUARD_URL || 'http://localhost:3000/v1/guard';
const TIMEOUT = Number(process.env.HARNESS_GUARD_TIMEOUT_MS) || 5000;

function answer(decision, reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `Harness guard: ${reason}` },
    }));
    process.exit(0);
}

async function main() {
    let input;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return process.exit(0); }
    const headers = { 'content-type': 'application/json' };
    if (process.env.HARNESS_PASSWORD) headers['x-harness-password'] = process.env.HARNESS_PASSWORD;
    let result;
    try {
        const res = await fetch(URL, {
            method: 'POST', headers,
            body: JSON.stringify({ tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd }),
            signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        result = await res.json();
    } catch (err) {
        if (process.env.HARNESS_GUARD_STRICT === '1') answer('ask', `couldn't reach ${URL} (${err.message})`);
        process.stderr.write(`Harness guard unreachable (${err.message}); not checked\n`);
        return process.exit(0);
    }
    if (result.decision === 'deny' || result.decision === 'ask') answer(result.decision, result.reason || result.decision);
    process.exit(0);
}

main();
