// Claude Code's own commands and skills, for importing into the chat page:
// .claude/commands/*.md and .claude/skills/NAME/SKILL.md, in this repo and in
// the home folder's .claude. Each file may start with "---" frontmatter.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 200 * 1024;

// { description, ... } from "key: value" lines between the --- lines, and the text after them
function parse(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return { meta: {}, body: text.trim() };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    return { meta, body: m[2].trim() };
}

function readText(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_BYTES) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

const slug = (s) => String(s).trim().replace(/[\s/\\]+/g, '-').slice(0, 40);

function commandsIn(dir, source) {
    const out = [];
    const walk = (folder, prefix) => {
        let entries = [];
        try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory() && prefix.length < 2) walk(path.join(folder, e.name), [...prefix, e.name]);
            else if (e.isFile() && e.name.endsWith('.md')) {
                const text = readText(path.join(folder, e.name));
                if (text === null) continue;
                const { meta, body } = parse(text);
                if (!body) continue;
                // $ARGUMENTS is Claude Code's word for what you type after the command
                out.push({ kind: 'command', name: slug([...prefix, e.name.slice(0, -3)].join('-')), description: (meta.description || '').slice(0, 200), body: body.replace(/\$ARGUMENTS/g, '{args}'), source });
            }
        }
    };
    walk(path.join(dir, 'commands'), []);
    return out;
}

function skillsIn(dir, source) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const text = readText(path.join(dir, 'skills', e.name, 'SKILL.md'));
        if (text === null) continue;
        const { meta, body } = parse(text);
        if (body) out.push({ kind: 'skill', name: slug(meta.name || e.name), description: (meta.description || '').slice(0, 200), body, source });
    }
    return out;
}

/** Everything importable: this repo's .claude first, then the home folder's. */
function list(roots = [[path.join(__dirname, '..', '.claude'), 'this repo'], [path.join(os.homedir(), '.claude'), 'your home folder']]) {
    return roots.flatMap(([dir, source]) => [...commandsIn(dir, source), ...skillsIn(dir, source)]);
}

module.exports = { list, parse };
