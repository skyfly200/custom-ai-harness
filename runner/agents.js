// Agents: a named, long-lived agent with its own repo, workflow and standing
// instructions. Its tasks are runs (run.agent = the agent's id); each task starts
// from the commit the last one left, so the work builds up, and is told what the
// earlier ones did. One JSON file per agent in <runs dir>/_agents. Swap this class
// for a database table later: RunManager only uses list/get/create/update/remove.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const workflows = require('../utils/workflows');
const { DRIVERS, normalizeKind } = require('./sandbox');

const EFFORTS = new Set(['min', 'low', 'medium', 'high', 'max']);
const clean = (v, n) => String(v ?? '').trim().slice(0, n);

/** Other repos connected beside the default: names (owner/name, or a folder path), at most 8, no repeats. They are told to the agent, not checked out. */
function cleanMoreRepos(v, skip = '') {
    if (v === undefined || v === null || v === '') return [];
    if (!Array.isArray(v)) throw new Error('moreRepos must be a list of repos');
    return [...new Set(v.map((r) => clean(r, 300)).filter((r) => r && r !== skip))].slice(0, 8);
}

class AgentStore {
    constructor(dir) {
        this.dir = dir;
        this.agents = new Map();
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            try { const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (a?.id) this.agents.set(a.id, a); } catch { /* not an agent file */ }
        }
    }

    save(agent) {
        const file = path.join(this.dir, `${agent.id}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(agent, null, 2));
        fs.renameSync(`${file}.tmp`, file);
    }

    list() { return [...this.agents.values()].sort((a, b) => a.created.localeCompare(b.created)); }
    get(id) { return this.agents.get(id) || null; }

    /** The fields a person may set, checked. `repo` is already resolved by the caller. */
    static fields(cfg, current = {}) {
        const out = {};
        const has = (k) => cfg[k] !== undefined;
        if (has('name')) {
            out.name = clean(cfg.name, 60);
            if (!out.name) throw new Error('an agent needs a name');
        }
        if (has('instructions')) out.instructions = clean(cfg.instructions, 8000);
        if (has('workflow')) {
            const w = cfg.workflow || workflows.FALLBACK;
            if (!workflows.get(w)) throw new Error(`no workflow named ${w} (an agent uses one workflow; Jev-picks and Swarm are for one-off runs)`);
            out.workflow = w;
        }
        if (has('sandbox')) {
            if (cfg.sandbox && !normalizeKind(cfg.sandbox)) throw new Error(`no sandbox named ${cfg.sandbox}; use ${Object.keys(DRIVERS).join(', ')}`);
            out.sandbox = cfg.sandbox ? normalizeKind(cfg.sandbox) : null;
        }
        if (has('iconSeed')) out.iconSeed = cfg.iconSeed ? clean(cfg.iconSeed, 40) : null; // set by Shuffle; else the id seeds the icon
        if (has('profile')) out.profile = cfg.profile ? clean(cfg.profile, 80) : null;
        if (has('effort')) {
            if (cfg.effort && !EFFORTS.has(cfg.effort)) throw new Error(`effort must be one of ${[...EFFORTS].join(', ')}`);
            out.effort = cfg.effort || null;
        }
        if (has('maxTier')) out.maxTier = cfg.maxTier ? clean(cfg.maxTier, 40) : null;
        if (has('escalate')) out.escalate = !(cfg.escalate === false || cfg.escalate === 0 || cfg.escalate === '0' || cfg.escalate === 'false');
        for (const [k, lo, hi] of [['maxSteps', 0, 10000], ['maxMinutes', 1, 240]]) {
            if (!has(k)) continue;
            if (cfg[k] === null || cfg[k] === '') { out[k] = null; continue; }
            const n = Math.floor(Number(cfg[k]));
            if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
            out[k] = Math.min(hi, Math.max(lo, n));
        }
        if (has('maxCost')) {
            if (cfg.maxCost === null || cfg.maxCost === '') out.maxCost = null;
            else {
                const n = Number(cfg.maxCost);
                if (!Number.isFinite(n) || n < 0) throw new Error('maxCost must be a number of dollars');
                out.maxCost = Math.min(1000, Math.round(n * 100) / 100) || null;
            }
        }
        if (has('autoContinue')) out.autoContinue = !(cfg.autoContinue === false || cfg.autoContinue === 0 || cfg.autoContinue === '0' || cfg.autoContinue === 'false' || cfg.autoContinue === '' || cfg.autoContinue === null);
        if (has('autoContinueMax')) {
            const n = cfg.autoContinueMax === null || cfg.autoContinueMax === '' ? null : Math.floor(Number(cfg.autoContinueMax));
            if (n !== null && !Number.isFinite(n)) throw new Error('autoContinueMax must be a number');
            out.autoContinueMax = n === null ? null : Math.min(10, Math.max(1, n));
        }
        // the chat project (they live in the browser) this agent belongs to: its id and name
        if (has('moreRepos')) out.moreRepos = cleanMoreRepos(cfg.moreRepos);
        if (has('project')) {
            const p = cfg.project;
            if (p && (typeof p !== 'object' || !clean(p.id, 80))) throw new Error('project needs an id');
            out.project = p ? { id: clean(p.id, 80), name: clean(p.name, 80) || null } : null;
        }
        return { ...current, ...out };
    }

    create(cfg, repo, owner = null) {
        const base = AgentStore.fields({ workflow: workflows.FALLBACK, ...cfg });
        if (!base.name) throw new Error('an agent needs a name');
        const now = new Date().toISOString();
        const agent = {
            instructions: '', iconSeed: null, moreRepos: [], profile: null, effort: null, sandbox: null, maxSteps: null, maxMinutes: null, maxCost: null, autoContinue: false, autoContinueMax: null, project: null,
            ...base, id: `a${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, repo, owner,
            head: null,   // the commit the last finished task left; the next task starts here
            branch: null, // the branch that task is on
            created: now, updated: now,
        };
        this.agents.set(agent.id, agent);
        this.save(agent);
        return agent;
    }

    update(id, cfg, repo) {
        const agent = this.get(id);
        if (!agent) throw new Error('no such agent');
        const next = AgentStore.fields(cfg, agent);
        if (repo && repo !== agent.repo) { next.repo = repo; next.head = null; next.branch = null; } // another repo: nothing carries over
        Object.assign(agent, next, { updated: new Date().toISOString() });
        this.save(agent);
        return agent;
    }

    remove(id) {
        this.agents.delete(id);
        fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    }
}

module.exports = { AgentStore, cleanMoreRepos };
