// A shell for a chat linked to a repo: one run_command tool, run in the
// repository's own working copy (not a worktree, unlike runner/sandbox.js).
// It is the runner's shell with the same trimmed environment, so a command
// can't print the harness's API keys. Every command goes past the command
// guard first; the chat page asks you on the spot when the guard says "ask".
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PowerShellSession } = require('./powershellSession');

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 900000;
const MAX_POWERSHELL_SESSIONS = 4;
// Only these reach a command: it must not be able to print the harness's API keys
const ENV_ALLOW = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'SHELL', 'TERM', 'CI'];
const powershellSessions = new Map();

const NAME = 'run_command';

const DEFINITIONS = [{
    type: 'function',
    function: {
        name: NAME,
        description: 'Run a shell command in the linked repository (bash; PowerShell on Windows) and get its output. Use it to search, run tests or install packages. A command the command guard finds risky waits for the user to allow it.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command line to run, from the repository root' },
                timeout_seconds: { type: 'integer', description: `Give up after this long (default ${DEFAULT_TIMEOUT_MS / 1000}, at most ${MAX_TIMEOUT_MS / 1000})` },
            },
            required: ['command'],
        },
    },
}];

const trimOutput = (text) => (text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n[harness: cut at ${MAX_OUTPUT} characters]`);

/**
 * Run `command` in `cwd`. Resolves { code, output, timedOut, ms }; never rejects.
 * The whole process tree is killed on timeout, so a stuck test can't hold the chat.
 */
function exec(cwd, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const win = process.platform === 'win32';
    const env = Object.fromEntries(ENV_ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    if (win) return powershellExec(cwd, command, limit, env);
    return new Promise((resolve) => {
        const started = Date.now();
        const [bin, args] = ['bash', ['-c', command]];
        let output = '';
        let timedOut = false;
        let child;
        try {
            child = spawn(bin, args, { cwd, env, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            return resolve({ code: -1, output: `could not start ${bin}: ${err.message}`, timedOut: false, ms: 0 });
        }
        const add = (d) => { if (output.length < MAX_OUTPUT * 4) output += d; };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                else process.kill(-child.pid, 'SIGKILL');
            } catch { /* already gone */ }
        }, limit);
        const finish = (code) => {
            clearTimeout(timer);
            resolve({ code, output: trimOutput(output), timedOut, ms: Date.now() - started });
        };
        child.on('error', (err) => { output += `\n${err.message}`; finish(-1); });
        child.on('close', (code) => finish(code ?? -1));
    });
}

function powershellExec(cwd, command, timeoutMs, env) {
    const key = path.resolve(cwd);
    let session = powershellSessions.get(key);
    if (!session) {
        while (powershellSessions.size >= MAX_POWERSHELL_SESSIONS) {
            const oldest = [...powershellSessions.entries()].find(([, existing]) => existing.busy === 0);
            if (!oldest) break;
            oldest[1].close();
            powershellSessions.delete(oldest[0]);
        }
        session = new PowerShellSession(key, env);
        powershellSessions.set(key, session);
    } else {
        powershellSessions.delete(key);
        powershellSessions.set(key, session);
    }
    return session.run(command, timeoutMs).then((result) => ({ ...result, output: trimOutput(result.output) }));
}

function closePowerShellSessions() {
    const closing = [...powershellSessions.values()].map(session => session.close());
    powershellSessions.clear();
    return Promise.all(closing);
}

/** The repository root for `dir`, or an Error when it isn't one. */
function repoRoot(dir) {
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('this chat is not linked to a git repo');
    const real = fs.realpathSync(path.resolve(dir.trim()));
    if (!fs.existsSync(path.join(real, '.git'))) throw new Error(`${real} is not the root of a git repository`);
    return real;
}

module.exports = { exec, repoRoot, closePowerShellSessions, definitions: () => DEFINITIONS, isShellTool: (name) => name === NAME, NAME, ENV_ALLOW, MAX_OUTPUT };
