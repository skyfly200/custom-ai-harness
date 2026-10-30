// Saved prompts: a person's library of task prompts for agents and chats. Each has a name, text, tags,
// optional {{variables}} filled in when it is used, what it suits (an agent or a workflow), and a history
// of its earlier texts. Kept per person in user_data (key "prompts") when there is a database, else in
// prompts.json next to the other local state (HARNESS_PROMPTS_FILE), keyed by name.
// The page's "improve" button asks a model itself; this module only holds the instructions (IMPROVE_SYSTEM).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const KEY = 'prompts';
const LOCAL = '_local';
const MAX_PROMPTS = 200;
const MAX_TEXT = 20000;
const MAX_VERSIONS = 30;
const MAX_TAGS = 8;

const file = () => process.env.HARNESS_PROMPTS_FILE || path.join(__dirname, '..', 'prompts.json');
const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// ---- storage ----
let chain = Promise.resolve(); // read-modify-write one at a time
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

async function load(owner) {
    if (db.enabled()) {
        const { rows } = await db.query('SELECT value FROM user_data WHERE owner = $1 AND key = $2', [owner, KEY]);
        return rows[0] ? rows[0].value : { prompts: [] };
    }
    try { return JSON.parse(fs.readFileSync(file(), 'utf8'))[owner] || { prompts: [] }; } catch { return { prompts: [] }; }
}
async function store(owner, value) {
    if (db.enabled()) {
        await db.query(
            `INSERT INTO user_data (owner, key, value, updated) VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (owner, key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated`,
            [owner, KEY, JSON.stringify(value), Date.now()]);
        return;
    }
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first save */ }
    all[owner] = value;
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

// ---- pure helpers ----
/** The variable names in a text, in order of first use. */
function variables(text) {
    const seen = [];
    for (const m of String(text || '').matchAll(VAR)) if (!seen.includes(m[1])) seen.push(m[1]);
    return seen;
}
/** The text with each {{name}} replaced by its value; names without a value stay as written. */
function render(text, values = {}) {
    return String(text || '').replace(VAR, (whole, name) => (Object.prototype.hasOwnProperty.call(values, name) && String(values[name]).length ? String(values[name]) : whole));
}
/** Rough size: about 4 characters a token. */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

function cleanTags(tags) {
    const list = (Array.isArray(tags) ? tags : String(tags || '').split(','))
        .map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24)).filter(Boolean);
    return [...new Set(list)].slice(0, MAX_TAGS);
}
function cleanSuits(s) {
    const out = {};
    for (const k of ['agent', 'workflow']) if (s && typeof s[k] === 'string' && s[k].trim()) out[k] = s[k].trim().slice(0, 60);
    return out;
}
const uid = () => `p${crypto.randomBytes(5).toString('hex')}`;

/** What the page shows: the prompt with its variables and size worked out, without the history texts. */
function view(p) {
    const { versions = [], ...rest } = p;
    return { ...rest, variables: variables(p.text), tokens: estimateTokens(p.text), versions: versions.map((v) => ({ n: v.n, at: v.at, note: v.note, tokens: estimateTokens(v.text) })) };
}

// ---- operations (owner = the signed-in name, or _local on your own machine) ----
async function list(owner = LOCAL) {
    const { prompts = [] } = await load(owner);
    return prompts.map(view).sort((a, b) => b.updated - a.updated);
}
async function get(owner, id) {
    const { prompts = [] } = await load(owner);
    const p = prompts.find((x) => x.id === id);
    return p ? { ...view(p), history: p.versions } : null;
}

/** Create (no id) or update. A changed text adds a version; `note` says why. */
function save(owner = LOCAL, input = {}, now = Date.now()) {
    return serial(async () => {
        const data = await load(owner);
        const prompts = data.prompts || [];
        const name = String(input.name || '').trim().slice(0, 80);
        const text = String(input.text ?? '');
        if (!name) throw Object.assign(new Error('give the prompt a name'), { status: 400 });
        if (!text.trim()) throw Object.assign(new Error('the prompt is empty'), { status: 400 });
        if (text.length > MAX_TEXT) throw Object.assign(new Error(`a prompt is at most ${MAX_TEXT} characters`), { status: 400 });
        let p = input.id ? prompts.find((x) => x.id === input.id) : null;
        if (input.id && !p) throw Object.assign(new Error('no such prompt'), { status: 404 });
        if (!p) {
            if (prompts.length >= MAX_PROMPTS) throw Object.assign(new Error(`at most ${MAX_PROMPTS} saved prompts`), { status: 400 });
            p = { id: uid(), created: now, versions: [{ n: 1, text, at: now, note: String(input.note || 'First version').slice(0, 120) }] };
            prompts.push(p);
        } else if (p.text !== text) {
            const n = (p.versions.length ? p.versions[p.versions.length - 1].n : 0) + 1;
            p.versions.push({ n, text, at: now, note: String(input.note || '').slice(0, 120) });
            p.versions = p.versions.slice(-MAX_VERSIONS);
        }
        Object.assign(p, { name, text, tags: cleanTags(input.tags), suits: cleanSuits(input.suits), updated: now });
        await store(owner, { ...data, prompts });
        return view(p);
    });
}
/** Put an earlier version back as a new version. */
function restore(owner, id, n, now = Date.now()) {
    return serial(async () => {
        const data = await load(owner);
        const p = (data.prompts || []).find((x) => x.id === id);
        if (!p) throw Object.assign(new Error('no such prompt'), { status: 404 });
        const v = p.versions.find((x) => x.n === Number(n));
        if (!v) throw Object.assign(new Error('no such version'), { status: 404 });
        const next = p.versions[p.versions.length - 1].n + 1;
        p.versions.push({ n: next, text: v.text, at: now, note: `Restored version ${v.n}` });
        p.versions = p.versions.slice(-MAX_VERSIONS);
        p.text = v.text;
        p.updated = now;
        await store(owner, data);
        return view(p);
    });
}
function remove(owner, id) {
    return serial(async () => {
        const data = await load(owner);
        const before = (data.prompts || []).length;
        data.prompts = (data.prompts || []).filter((x) => x.id !== id);
        if (data.prompts.length === before) throw Object.assign(new Error('no such prompt'), { status: 404 });
        await store(owner, data);
    });
}

// ---- starters and the improve instructions ----
const STARTERS = [
    { id: 'build-feature', name: 'Build a feature', tags: ['build'], suits: { workflow: 'build-feature' },
      text: 'Add {{feature}} to {{repo}}.\n\nWhat it should do:\n- {{behaviour}}\n\nDone when:\n- the behaviour above works and has tests that fail without the change\n- the existing tests still pass\n- the change is small and follows the style of the surrounding code\n\nDon\'t change unrelated files. If something is unclear, make the simplest reasonable choice and say which one you made.' },
    { id: 'fix-bug', name: 'Fix a bug', tags: ['fix'], suits: { workflow: 'fix-bug' },
      text: 'Fix this bug in {{repo}}: {{symptom}}\n\nHow to see it: {{steps}}\n\nFirst write a test that fails because of the bug, then fix the cause (not just the symptom) and show the test passing. Run the rest of the tests to check nothing else broke. Finish with one paragraph on what was wrong.' },
    { id: 'review', name: 'Review a change', tags: ['review'], suits: { workflow: 'review' },
      text: 'Review {{target}} in {{repo}}. Do not change any files.\n\nLook for: bugs and unhandled cases, security problems, missing tests, anything that will be hard to maintain.\n\nReport a short list, most serious first. For each: where it is, what is wrong, and what you would do. Say plainly if it looks fine.' },
    { id: 'refactor', name: 'Refactor safely', tags: ['refactor'], suits: { workflow: 'refactor' },
      text: 'Refactor {{area}} in {{repo}} to {{goal}}.\n\nRules:\n- behaviour must not change: the existing tests must pass before and after\n- add tests first if {{area}} has none\n- work in small steps and run the tests after each\n\nFinish by listing what moved and anything you left alone on purpose.' },
    { id: 'write-tests', name: 'Write tests', tags: ['tests'], suits: { workflow: 'build-feature' },
      text: 'Write tests for {{area}} in {{repo}}.\n\nCover the normal case, the edge cases (empty, very large, wrong type) and each error path. Follow how the existing tests are written and run them. Don\'t change the code under test; if you find a bug, report it instead of fixing it.' },
    { id: 'explain', name: 'Explain how it works', tags: ['read'], suits: { workflow: 'research' },
      text: 'Explain how {{topic}} works in {{repo}} to someone new to the project. Do not change any files.\n\nStart with the one-paragraph picture, then walk through the files involved in the order a request passes through them. Point to file and line. End with what to be careful about when changing it.' },
];

const IMPROVE_SYSTEM = `You rewrite prompts that a person will give to an AI coding agent that works alone in a code repository and cannot ask questions. Make the prompt clearer and more specific without changing what the person wants.

Do this:
- say the goal in the first sentence
- turn vague wishes into acceptance criteria the agent can check ("done when ...")
- name what must not change, and how to verify the work (which tests to run)
- keep every {{variable}} exactly as written, and don't invent facts about the repository
- keep it short; plain words; no preamble

Reply with the rewritten prompt only, no commentary and no code fence around it.`;

/** The messages the page sends to a model to improve a prompt (notes: what the person wants better). */
function improveMessages(text, notes) {
    const t = String(text || '').trim();
    if (!t) throw Object.assign(new Error('write the prompt first'), { status: 400 });
    if (t.length > MAX_TEXT) throw Object.assign(new Error(`a prompt is at most ${MAX_TEXT} characters`), { status: 400 });
    const extra = String(notes || '').trim().slice(0, 500);
    return [{ role: 'system', content: IMPROVE_SYSTEM }, { role: 'user', content: `Prompt to improve:\n\n${t}${extra ? `\n\nWhat I want better: ${extra}` : ''}` }];
}

module.exports = { list, get, save, restore, remove, variables, render, estimateTokens, STARTERS, IMPROVE_SYSTEM, improveMessages, LOCAL, MAX_TEXT };
