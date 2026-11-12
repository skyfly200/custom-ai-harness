// Skills kept on the server: one JSON file (SKILLS_FILE, default skills.json, git-ignored), the same shape as the
// Skills page keeps in the browser: { id, name, description, body, disabled? }. The assistant saves skills here
// (utils/assistantHarness.js). Validation is the Skills page's own (ui/skillsModel.js), so a skill that saves
// here is one the page would also accept.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const model = require('../ui/skillsModel.js');

const MAX_SKILLS = 200;

/** A JSON file of { skills: [...] }. A file that exists but does not parse throws, so a save never replaces it. */
function fileStore(file) {
    return {
        file,
        load() {
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return { skills: [] }; throw err; }
            const parsed = JSON.parse(text);
            return { skills: Array.isArray(parsed.skills) ? parsed.skills : [] };
        },
        save(state) {
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
            fs.renameSync(tmp, file);
        },
    };
}

function memoryStore(initial = []) {
    let saved = JSON.stringify({ skills: initial });
    return { load: () => JSON.parse(saved), save: (state) => { saved = JSON.stringify(state); } };
}

/**
 * @param {object} opts
 * @param {object} opts.store  fileStore() or memoryStore()
 * @param {function} [opts.now] () => ms, for tests
 */
function createSkillStore({ store, now = () => Date.now() }) {
    const list = () => store.load().skills.map((s) => ({ ...s }));

    /** Saves a skill: a new one, or the one with the same id, or the one with the same name. Returns the saved skill. */
    function save(input) {
        const skills = list();
        const name = model.cleanName(input.name);
        const byId = input.id ? skills.find((s) => s.id === String(input.id)) : null;
        const byName = !byId && name ? skills.find((s) => s.name.toLowerCase() === name.toLowerCase()) : null;
        const target = byId || byName;
        const draft = {
            id: target ? target.id : `k${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
            name,
            description: String(input.description ?? target?.description ?? '').trim().slice(0, 200),
            body: String(input.body ?? target?.body ?? ''),
            ...(target && target.disabled ? { disabled: true } : {}),
        };
        const problem = model.problem(draft, skills);
        if (problem) throw new Error(problem);
        if (!target && skills.length >= MAX_SKILLS) throw new Error(`The server keeps at most ${MAX_SKILLS} skills. Remove one first.`);
        const next = target ? skills.map((s) => (s.id === target.id ? draft : s)) : [...skills, draft];
        store.save({ skills: next });
        return { ...draft, updated: target ? 'changed' : 'created' };
    }

    function remove(id) {
        const skills = list();
        const next = skills.filter((s) => s.id !== String(id));
        if (next.length === skills.length) throw new Error(`no skill with id ${id}`);
        store.save({ skills: next });
    }

    return { list, save, remove };
}

module.exports = { createSkillStore, fileStore, memoryStore, MAX_SKILLS };
