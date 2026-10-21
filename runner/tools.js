// The tools an agent run can use, in OpenAI's function format, and the code
// that runs them in a sandbox. Every command and every file write goes past
// the command guard first: "deny" is refused, "ask" waits for a person to
// allow it on the Runs page, and an unreachable guard counts as "ask" (a
// run nobody is watching must not fail open).
'use strict';

const MAX_READ = 40000;
// What a workflow stage may use: read looks only, check also runs commands, all writes too
const TOOLSETS = {
    read: ['list_files', 'read_file', 'finish'],
    check: ['list_files', 'read_file', 'run_command', 'finish'],
    all: ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command', 'finish'],
};

const definitions = [
    { type: 'function', function: { name: 'list_files', description: 'List the files and folders in a directory of the workspace (not recursive).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory, default the workspace root' } } } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a text file, with line numbers. Use start and end (1-based, inclusive) for a part of a long file.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: 'Create a file or replace it completely.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'edit_file', description: 'Replace one exact piece of text in a file with another. "old" must appear exactly once; include enough surrounding lines to make it unique.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the workspace (bash; PowerShell on Windows). Use it to search (grep), run tests, install packages. Output is cut when long.',
        parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'Default 120' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'finish', description: 'Say the task is done, or cannot be done, and summarise what you did and anything the person should check.',
        parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
];

/**
 * `sandbox` is a LocalSandbox. `check(kind, text)` is the guard: resolves
 * { decision, reason }. `approve({ kind, text, reason })` resolves true when a
 * person allows it. Returns { definitions, call(name, args) } where call
 * resolves { text, finished? }.
 */
function makeTools({ sandbox, check, approve, toolset = 'all' }) {
    async function gate(kind, text) {
        let verdict;
        try {
            verdict = await check(kind, text);
        } catch (err) {
            verdict = { decision: 'ask', reason: `the command guard could not be reached (${err.message})` };
        }
        if (verdict.decision === 'deny') return `Blocked by the command guard: ${verdict.reason}. Choose another way.`;
        if (verdict.decision === 'ask') {
            const allowed = await approve({ kind, text, reason: verdict.reason });
            if (!allowed) return `A person declined this (${verdict.reason}). Choose another way, or call finish and say what is blocked.`;
        }
        return null;
    }

    const numbered = (text, start = 1) => text.split('\n').map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');

    const run = {
        async list_files({ path = '.' }) { return sandbox.listDir(path).join('\n') || '(empty)'; },
        async read_file({ path, start, end }) {
            const lines = sandbox.readFile(path).split('\n');
            const from = Math.max(1, start || 1), to = Math.min(lines.length, end || lines.length);
            let text = numbered(lines.slice(from - 1, to).join('\n'), from);
            if (text.length > MAX_READ) text = `${text.slice(0, MAX_READ)}\n[... cut at ${MAX_READ} characters; read the rest with start and end ...]`;
            return `${path} (${lines.length} lines)\n${text}`;
        },
        async write_file({ path, content }) {
            const blocked = await gate('write', sandbox.resolve(path));
            if (blocked) return blocked;
            sandbox.writeFile(path, String(content));
            return `Wrote ${path} (${String(content).length} characters).`;
        },
        async edit_file({ path, old: oldText, new: newText }) {
            const content = sandbox.readFile(path);
            const at = content.indexOf(oldText);
            if (!oldText || at < 0) return `"old" was not found in ${path}. Read the file again and copy the text exactly.`;
            if (content.indexOf(oldText, at + 1) >= 0) return `"old" appears more than once in ${path}. Include more surrounding lines.`;
            const blocked = await gate('write', sandbox.resolve(path));
            if (blocked) return blocked;
            sandbox.writeFile(path, content.slice(0, at) + newText + content.slice(at + oldText.length));
            return `Edited ${path}.`;
        },
        async run_command({ command, timeout_seconds }) {
            const blocked = await gate('bash', String(command));
            if (blocked) return blocked;
            const r = await sandbox.exec(String(command), { timeoutMs: Math.min(Math.max(timeout_seconds || 120, 1), 900) * 1000 });
            const status = r.timedOut ? `timed out after ${Math.round(r.ms / 1000)} s` : `exit code ${r.code}`;
            return `${status}\n${r.output}`.trimEnd();
        },
        async finish({ summary }) { return String(summary || ''); },
    };

    const allowed = TOOLSETS[toolset] || TOOLSETS.all;
    return {
        definitions: definitions.filter((d) => allowed.includes(d.function.name)),
        async call(name, args) {
            if (!Object.hasOwn(run, name) || !allowed.includes(name)) return { text: `Unknown tool ${name}. Available: ${allowed.join(', ')}.` };
            try {
                return { text: await run[name](args || {}), finished: name === 'finish' };
            } catch (err) {
                return { text: `Error: ${err.message}` };
            }
        },
    };
}

module.exports = { makeTools, definitions, TOOLSETS };
