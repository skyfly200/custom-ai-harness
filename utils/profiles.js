// Named strategies ("profiles"): other ways to route a request, kept next to the
// default strategy (the Router's config plus harness-settings.json). A client
// picks one per request with the x-harness-profile header; the chat page sends
// it for chats and projects that use one. Each profile is a full set of route
// choices, so nothing is inherited from the default except the Router's
// classifier and the Gateway's models, which every strategy shares. Fallback
// chains are the Gateway's unless a strategy keeps its own (`fallbacks`).
// Saved to routing-profiles.json (gitignored) next to server.js.

const fs = require('fs');
const path = require('path');
const tiers = require('./tiers');
const auto = require('./autoStrategy');

const FILE = process.env.HARNESS_PROFILES_FILE || path.join(__dirname, '..', 'routing-profiles.json');
const MODEL_RE = /^[\w.:/@-]+$/;
// Old Gateway names for the local engine, which config.yaml once named after
// a Claude model it never was. Saved strategies, settings and Router configs
// that still use them reach local-engine.
const RENAMED = { 'claude-sonnet-5': 'local-engine', 'claude-3-5-sonnet': 'local-engine' };
const currentName = (m) => RENAMED[m] || m;
// Claude Code's model aliases (Haiku, Sonnet, Opus, with or without a version) are
// not Gateway models; a request or pin that names one is routed like any other.
const CLAUDE_ALIAS_RE = /^(claude[-\s])?(haiku|sonnet|opus)([-\s.\d]*)(\[1m\])?$/i;
const isClaudeAlias = (m) => typeof m === 'string' && CLAUDE_ALIAS_RE.test(m.trim());

let profiles = [];
let version = 0;

function model(p, k, required) {
    const v = p[k];
    if (v === null || v === undefined || v === '') {
        if (required) throw new Error(`${p.name || 'A strategy'}: connect “${k}” to a model`);
        return null;
    }
    if (typeof v !== 'string' || !MODEL_RE.test(v)) throw new Error(`${p.name || 'A strategy'}: ${k} must be a model name`);
    return currentName(v);
}

/** A strategy's own fallback chains {model: [models]}, or null to use the Gateway's. */
function chains(p) {
    if (p.fallbacks === null || p.fallbacks === undefined) return null;
    if (typeof p.fallbacks !== 'object' || Array.isArray(p.fallbacks)) throw new Error(`${p.name || 'A strategy'}: fallbacks must be an object of model -> list`);
    const out = {};
    for (const [src, targets] of Object.entries(p.fallbacks)) {
        if (!MODEL_RE.test(src) || !Array.isArray(targets) || !targets.every(t => typeof t === 'string' && MODEL_RE.test(t))) {
            throw new Error(`${p.name || 'A strategy'}: fallbacks for “${src}” must be a list of model names`);
        }
        const list = [...new Set(targets.map(currentName))].filter(t => t !== currentName(src));
        if (list.length) out[currentName(src)] = list;
    }
    return out;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** One profile, cleaned; throws with a readable message on a bad value. */
function clean(p) {
    if (!p || typeof p !== 'object') throw new Error('A strategy must be an object');
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 60) : '';
    if (!name) throw new Error('Every strategy needs a name');
    const id = slug(p.id || name);
    if (!id || id === 'default' || id === auto.AUTO) throw new Error(`“${name}” needs a different name`);
    const threshold = p.threshold === null || p.threshold === undefined || p.threshold === '' ? null : Number(p.threshold);
    if (threshold !== null && !(threshold >= 0 && threshold <= 1)) throw new Error(`${name}: the threshold must be from 0 to 1`);
    const out = {
        id, name,
        note: typeof p.note === 'string' ? p.note.slice(0, 200) : '',
        // when Auto (utils/autoStrategy.js) should pick this strategy
        description: typeof p.description === 'string' ? p.description.trim().slice(0, 300) : '',
        rules: auto.cleanRules(p.rules, name),
        pin: model(p, 'pin'),
        down: model(p, 'down', true),
        downTools: model(p, 'downTools', true),
        threshold,
        strong: model(p, 'strong', !p.pin),
        strongTools: model(p, 'strongTools'),
        weak: model(p, 'weak', !p.pin),
        tools: model(p, 'tools'),
        overflow: model(p, 'overflow'),
        maxTokens: null,
        images: model(p, 'images'),
        tiers: tiers.clean(p.tiers, name).map(t => ({ ...t, model: currentName(t.model), tools: t.tools && currentName(t.tools) })),
        fallbacks: chains(p),
        caveman: p.caveman !== false,
        headroom: p.headroom !== false,
        contextAnchor: p.contextAnchor !== false,
        // MCP servers the chat page leaves out for chats on this strategy
        mcpOff: Array.isArray(p.mcpOff) ? [...new Set(p.mcpOff.filter(s => typeof s === 'string' && s).map(s => s.slice(0, 80)))] : [],
    };
    if (out.overflow) {
        const n = Number(p.maxTokens);
        if (!Number.isInteger(n) || n < 1) throw new Error(`${name}: set the token limit for “Weak, over”`);
        out.maxTokens = n;
    }
    return out;
}

function load() {
    profiles = [];
    try {
        const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const p of saved.profiles || []) {
            try { const c = clean(p); if (!profiles.some(x => x.id === c.id)) profiles.push(c); } catch (err) { console.warn(`Routing skipped: ${err.message}`); }
        }
    } catch {}
    version++;
}

/** The `fallbacks` value LiteLLM takes in a request body for a strategy's own chains, or null. */
const gatewayFallbacks = (p) => (p && p.fallbacks ? Object.entries(p.fallbacks).map(([src, targets]) => ({ [src]: targets })) : null);

const list = () => profiles;
const get = (id) => (id ? profiles.find(p => p.id === String(id).trim().toLowerCase()) || null : null);
const state = () => ({ profiles, version, file: FILE });

/** Replace every profile at once; a bad one changes nothing. `expected` guards against two editors. */
function replace(next, expected) {
    if (expected !== undefined && expected !== version) throw Object.assign(new Error('The strategies changed since this page loaded. Reload it and try again.'), { status: 409 });
    if (!Array.isArray(next)) throw new Error('profiles must be a list');
    const cleaned = next.map(clean);
    const ids = new Set();
    for (const p of cleaned) {
        if (ids.has(p.id)) throw new Error(`Two strategies are called “${p.name}”: rename one`);
        ids.add(p.id);
    }
    profiles = cleaned;
    version++;
    fs.writeFileSync(FILE, JSON.stringify({ profiles }, null, 2) + '\n', 'utf8');
    return state();
}

/**
 * The model a profile sends a request to, given the Router's score. The same
 * rule as router.py's pick_model, with this profile's outputs.
 */
function pick(p, winRate, threshold, tokens, tools) {
    if (winRate >= threshold) return (tools && p.strongTools) || p.strong;
    if (tools && p.tools) return p.tools;
    if (p.overflow && p.maxTokens && tokens > p.maxTokens) return p.overflow;
    return p.weak;
}

load();

module.exports = { gatewayFallbacks, list, get, state, replace, clean, pick, load, slug, currentName, isClaudeAlias, FILE };
