// Interceptor settings the control UI can change at runtime. Saved to
// harness-settings.json (gitignored) so they survive a restart; delete that
// file, or press "Reset" in the UI, to go back to the defaults.

const fs = require('fs');
const path = require('path');

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
};

let current = { ...DEFAULTS };

function load() {
    try {
        const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        current = { ...DEFAULTS };
        for (const [k, v] of Object.entries(saved)) {
            try { if (k in VALIDATORS) current[k] = VALIDATORS[k](v); } catch {} // skip a bad value, keep the default
        }
    } catch {
        current = { ...DEFAULTS };
    }
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
    current = { ...DEFAULTS };
    try { fs.unlinkSync(FILE); } catch {}
    return current;
}

function save() {
    fs.writeFileSync(FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
}

load();

module.exports = { get, update, reset, load, DEFAULTS, FILE };
