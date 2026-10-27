// Interceptor settings the control UI can change at runtime. Saved to
// harness-settings.json (gitignored) so they survive a restart; delete that
// file, or press "Reset" in the UI, to go back to the defaults.

const fs = require('fs');
const path = require('path');
const tiers = require('./tiers');
const jevQuestions = require('./jevQuestions');
const langfuse = require('./langfuse');

const FILE = process.env.HARNESS_SETTINGS_FILE || path.join(__dirname, '..', 'harness-settings.json');

const DEFAULTS = Object.freeze({
    caveman: true,            // append the terse-output instruction to the system prompt
    headroom: true,           // compress tool results
    contextAnchor: true,      // replace repeated tool results with a pointer
    maxOutputTokens: 32768,   // cap on requested output (Groq rejects more than 65,536)
    fixedThreshold: null,     // number in [0, 1] to replace the keyword-derived threshold
    pinModel: null,           // Gateway model for every request, skipping the Router
    routerTimeoutMs: 10000,   // how long to wait for the Router before falling back
    gatewayTimeoutMs: 300000, // how long the Gateway may take to start answering (its whole fallback chain) before the request fails
    streamIdleTimeoutMs: 120000, // how long a reply may go quiet mid-stream before it fails
    routerDownModel: 'fallback-openrouter',             // free tier with no size cap
    routerDownToolsModel: 'fallback-openrouter-tools',  // same, for requests that need tool calls
    mcpOff: [],               // MCP servers the chat page doesn't offer on the default routing
    tiers: [],                // extra tiers of the default routing beside the Router's strong and weak (utils/tiers.js)
    jevQuestions: [],         // extra yes/no questions Jev answers per request; each leans the effort or picks a model (utils/jevQuestions.js)
    imagesModel: null,        // Gateway model for requests whose latest user turn carries an image
    autoJev: true,            // Auto routing (utils/autoStrategy.js): ask Jev which routing fits when no routing's rules do
    autoFirst: 'jev',         // which Auto tries first: 'jev' (rules only if Jev finds no fit) or 'rules'
    autoAskAt: 0.5,           // Jev's confidence that a routing fits at which Auto picks it
    guardJev: true,           // command guard (utils/guard.js): ask Jev about commands the rules don't cover
    guardAskAt: 0.5,          // Jev's confidence that a command is risky at which the agent must ask you
    guardDenyAt: null,        // ...at which it is blocked outright; null: Jev alone never blocks
    shellInRepo: true,        // a chat linked to a git repo may run commands in it (guarded; the chat page asks you)
    langfuseContent: langfuse.contentDefault(), // Langfuse (utils/langfuse.js): log prompts and replies too; off: only model, tokens, cost and tags
});

// Each setting's check: returns the cleaned value or throws with a readable message.
const bool = (k) => (v) => { if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`); return v; };
const int = (k, min, max) => (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
    return n;
};
const optionalName = (k) => (v) => {
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[\w.:/@-]+$/.test(v)) throw new Error(`${k} must be a model name`);
    return v;
};
const name = (k) => (v) => {
    const out = optionalName(k)(v);
    if (out === null) throw new Error(`${k} can't be empty`);
    return out;
};

const VALIDATORS = {
    caveman: bool('caveman'),
    headroom: bool('headroom'),
    contextAnchor: bool('contextAnchor'),
    maxOutputTokens: int('maxOutputTokens', 1, 1000000),
    fixedThreshold: (v) => {
        if (v === null || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('fixedThreshold must be from 0 to 1');
        return n;
    },
    pinModel: optionalName('pinModel'),
    routerTimeoutMs: int('routerTimeoutMs', 100, 600000),
    gatewayTimeoutMs: int('gatewayTimeoutMs', 1000, 3600000),
    streamIdleTimeoutMs: int('streamIdleTimeoutMs', 1000, 3600000),
    routerDownModel: name('routerDownModel'),
    routerDownToolsModel: name('routerDownToolsModel'),
    mcpOff: (v) => {
        if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !s || s.length > 80)) throw new Error('mcpOff must be a list of MCP server names');
        return [...new Set(v)];
    },
    tiers: (v) => tiers.clean(v, 'The default routing'),
    jevQuestions: (v) => jevQuestions.clean(v),
    imagesModel: optionalName('imagesModel'),
    autoJev: bool('autoJev'),
    autoFirst: (v) => { if (v !== 'jev' && v !== 'rules') throw new Error('autoFirst must be jev or rules'); return v; },
    autoAskAt: (v) => {
        const n = Number(v);
        if (v === null || v === '' || !Number.isFinite(n) || n < 0 || n > 1) throw new Error('autoAskAt must be from 0 to 1');
        return n;
    },
    langfuseContent: bool('langfuseContent'),
    guardJev: bool('guardJev'),
    guardAskAt: (v) => {
        const n = Number(v);
        if (v === null || v === '' || !Number.isFinite(n) || n < 0 || n > 1) throw new Error('guardAskAt must be from 0 to 1');
        return n;
    },
    shellInRepo: bool('shellInRepo'),
    guardDenyAt: (v) => {
        if (v === null || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('guardDenyAt must be from 0 to 1');
        return n;
    },
};

/**
 * Launch settings for Docker (see .env.example). They win over the saved file
 * on every start, so unset them to manage these from the dashboard.
 * HARNESS_MODE=passthrough sends every request to the Gateway's "passthrough"
 * model (docker/gateway-start.py) with no Router and no transforms.
 */
function envOverrides(env = process.env) {
    const out = {};
    if ((env.HARNESS_MODE || '').trim().toLowerCase() === 'passthrough') {
        Object.assign(out, { pinModel: 'passthrough', caveman: false, headroom: false, contextAnchor: false });
    }
    const transforms = (env.HARNESS_TRANSFORMS || '').trim().toLowerCase();
    if (transforms === 'on' || transforms === 'off') {
        for (const k of ['caveman', 'headroom', 'contextAnchor']) out[k] = transforms === 'on';
    }
    const vars = { PIN_MODEL: 'pinModel', ROUTER_DOWN_MODEL: 'routerDownModel', ROUTER_DOWN_TOOLS_MODEL: 'routerDownToolsModel' };
    for (const [name, k] of Object.entries(vars)) {
        const v = (env[name] || '').trim();
        if (!v) continue;
        try { out[k] = VALIDATORS[k](v); } catch (err) { console.warn(`${name} ignored: ${err.message}`); }
    }
    return out;
}

let current = { ...DEFAULTS };

function load() {
    current = { ...DEFAULTS };
    try {
        const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const [k, v] of Object.entries(saved)) {
            try { if (k in VALIDATORS) current[k] = VALIDATORS[k](v); } catch {} // skip a bad value, keep the default
        }
    } catch {}
    Object.assign(current, envOverrides());
}

function get() {
    return current;
}

/** Validate every key first, then apply all of them and save; a bad key changes nothing. */
function update(changes) {
    const next = { ...current };
    for (const [k, v] of Object.entries(changes || {})) {
        if (!(k in VALIDATORS)) throw new Error(`unknown setting ${k}`);
        next[k] = VALIDATORS[k](v);
    }
    current = next;
    save();
    return current;
}

function reset() {
    current = { ...DEFAULTS, ...envOverrides() };
    try { fs.unlinkSync(FILE); } catch {}
    return current;
}

function save() {
    fs.writeFileSync(FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
}

load();

module.exports = { get, update, reset, load, envOverrides, DEFAULTS, FILE };
