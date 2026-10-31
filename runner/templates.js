// Templates for new apps: templates/<id>/template.json plus the files, with {{placeholders}}.
// The builder asks the questions the template lists, fills the placeholders and writes the
// folder. This file only reads and writes files; the runner makes the git repo and registers the app.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'templates');
const BUILT_IN = ['name', 'slug', 'description'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const PUBLIC_FIELDS = ['id', 'version', 'name', 'description', 'stack', 'questions', 'installCommand', 'devCommand', 'testCommand', 'previewPort', 'deploy', 'editablePaths'];

/** "My Cool App" -> "my-cool-app" */
const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Text that goes into generated files: no quotes, brackets or line breaks that could break the code around it. */
const cleanText = (s, n) => String(s ?? '').replace(/[\\"'`<>{}\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Every file under a template folder except its manifest, as { path, text }, with forward slashes. */
function readFiles(dir, base = dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...readFiles(full, base));
        else if (e.isFile() && !(dir === base && e.name === 'template.json')) out.push({ path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The problems with a template, or [] when the builder can use it. */
function validate(t, files) {
    const problems = [];
    const need = (ok, msg) => { if (!ok) problems.push(msg); };
    need(t && typeof t.id === 'string' && /^[a-z0-9-]+$/.test(t.id), 'id must be lowercase letters, digits and dashes');
    need(t && typeof t.name === 'string' && t.name.trim(), 'name is required');
    need(t && typeof t.description === 'string' && t.description.trim(), 'description is required');
    need(t && typeof t.version === 'string' && t.version.trim(), 'version is required');
    need(t && Array.isArray(t.editablePaths) && t.editablePaths.length > 0, 'editablePaths must list at least one path');
    need(t && (t.previewPort === undefined || t.previewPort === null || (Number.isInteger(t.previewPort) && t.previewPort >= 1024 && t.previewPort <= 65535)), 'previewPort must be between 1024 and 65535');
    const questions = Array.isArray(t?.questions) ? t.questions : [];
    need(Array.isArray(t?.questions) || t?.questions === undefined, 'questions must be a list');
    const keys = new Set();
    for (const q of questions) {
        need(q && KEY.test(q.key || ''), `question key ${q?.key} must be a lowercase word`);
        need(q && !BUILT_IN.includes(q.key), `question key ${q?.key} is already filled in by the builder`);
        need(q && !keys.has(q.key), `question key ${q?.key} is listed twice`);
        need(q && typeof q.label === 'string' && q.label.trim(), `question ${q?.key} needs a label`);
        keys.add(q?.key);
    }
    need(files.length > 0, 'the template has no files');
    for (const f of files) {
        need(!f.path.startsWith('/') && !f.path.split('/').includes('..'), `file ${f.path} must stay inside the template`);
        for (const m of f.text.matchAll(PLACEHOLDER)) {
            need(BUILT_IN.includes(m[1]) || keys.has(m[1]), `${f.path} uses {{${m[1]}}}, which no question fills in`);
        }
    }
    return problems;
}

/** Every template under dir: the usable ones (public fields only) and the problems with the rest. */
function listTemplates(dir = DEFAULT_DIR) {
    const templates = [];
    const problems = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { templates, problems }; }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const folder = path.join(dir, e.name);
        let t;
        try { t = JSON.parse(fs.readFileSync(path.join(folder, 'template.json'), 'utf8')); } catch (err) {
            problems.push({ id: e.name, problems: [`template.json: ${err.message}`] });
            continue;
        }
        const files = readFiles(folder);
        const found = validate(t, files);
        if (found.length) { problems.push({ id: t?.id || e.name, problems: found }); continue; }
        templates.push({ ...Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, t[k] ?? null])), questions: t.questions || [] });
    }
    return { templates, problems };
}

/** One usable template with its files, or throws. */
function loadTemplate(id, dir = DEFAULT_DIR) {
    const found = listTemplates(dir).templates.find((t) => t.id === id);
    if (!found) throw new Error(`no template called ${id}`);
    return { ...found, files: readFiles(path.join(dir, id)) };
}

/**
 * Fill the placeholders. `values` holds the answers by key plus name, slug and description.
 * Required questions must have an answer; every value is cleaned so it fits in code and HTML.
 */
function render(template, values) {
    const filled = {};
    for (const q of template.questions) {
        const v = cleanText(values[q.key], 200);
        if (q.required && !v) throw new Error(`${q.label} needs an answer`);
        filled[q.key] = v;
    }
    const all = { ...filled, name: cleanText(values.name, 60), slug: slugify(values.slug || values.name), description: cleanText(values.description, 300) };
    if (!all.name) throw new Error('an app needs a name');
    if (!all.slug) throw new Error('an app needs a name with letters or numbers');
    return template.files.map((f) => ({ path: f.path, text: f.text.replace(PLACEHOLDER, (_, key) => all[key] ?? '') }));
}

/**
 * Write the filled-in files into a folder, plus any `extra` files ({ path, text }) such as the CI workflow. The folder
 * may hold only a .git folder (a cloned empty repo); any other file in it stops the write.
 */
function scaffold(template, values, folder, extra = []) {
    const files = [...render(template, values), ...extra];
    const taken = new Set(template.files.map((f) => f.path));
    for (const f of extra) if (taken.has(f.path)) throw new Error(`${f.path} is already in the template`);
    if (fs.existsSync(folder) && fs.readdirSync(folder).some((f) => f !== '.git')) throw new Error(`${folder} is not empty`);
    for (const f of files) {
        const target = path.join(folder, f.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.text);
    }
    return files.map((f) => f.path);
}

module.exports = { DEFAULT_DIR, slugify, cleanText, validate, listTemplates, loadTemplate, render, scaffold };
