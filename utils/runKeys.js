// Run keys: short-lived API keys with a spending cap, made for one agent run (a
// ChatDev sandbox, say) so the run never holds a real credential. A run key works
// for POST /v1/chat/completions only (see middleware), expires, and stops working
// when its dollar cap is used up. They live in memory: a restart revokes them all.
//
// Cost is worked out from the reply's token counts and the Gateway's prices
// (utils/modelInfo.js). A model with no known price is charged at UNKNOWN_PRICE,
// on the high side, so a cap can't be dodged by a model that isn't listed.
// A request that is already running when the cap is reached still finishes, so
// the total can go over by what the requests in flight cost.
'use strict';

const crypto = require('crypto');

const PREFIX = 'hk_run_';
const PATHS = new Set(['/v1/chat/completions', '/chat/completions']);
// dollars per token for a model with no price: $15 per million in, $75 out
const UNKNOWN_PRICE = { inputCost: 15 / 1e6, outputCost: 75 / 1e6 };

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');
const tokenOf = (req) => {
    const bearer = /^bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return (bearer && bearer[1].trim()) || req.headers['x-api-key'] || '';
};

/** Dollars for one reply: counts { input, output, cacheRead, cacheWrite } at a model's per-token prices. */
function costOf(price, counts) {
    const p = price || UNKNOWN_PRICE;
    if (p.free) return 0;
    const inCost = p.inputCost ?? UNKNOWN_PRICE.inputCost;
    const outCost = p.outputCost ?? UNKNOWN_PRICE.outputCost;
    return (counts.input || 0) * inCost + (counts.output || 0) * outCost
        + (counts.cacheRead || 0) * (p.cacheReadCost ?? inCost) + (counts.cacheWrite || 0) * (p.cacheWriteCost ?? inCost);
}

class RunKeys {
    constructor({ now = () => Date.now() } = {}) {
        this.now = now;
        this.byHash = new Map();
        this.byId = new Map();
    }

    /** A new key. Resolves { id, key, maxUsd, expires }; the key is shown only here. */
    create({ label = 'run', maxUsd, ttlMinutes = 60 } = {}) {
        const cap = Number(maxUsd);
        if (!(cap > 0) || !Number.isFinite(cap)) throw new Error('maxUsd must be a number above 0');
        const ttl = Math.min(24 * 60, Math.max(1, Math.floor(Number(ttlMinutes)) || 60));
        const key = `${PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
        const entry = { id: crypto.randomBytes(6).toString('hex'), label: String(label).slice(0, 60), maxUsd: cap, spent: 0, requests: 0, expires: this.now() + ttl * 60000, hash: hash(key) };
        this.byHash.set(entry.hash, entry);
        this.byId.set(entry.id, entry);
        return { id: entry.id, key, maxUsd: cap, expires: new Date(entry.expires).toISOString() };
    }

    /** Remove a key. Returns what it spent, or null when there is no such key. */
    revoke(id) {
        const entry = this.byId.get(id);
        if (!entry) return null;
        this.byId.delete(id);
        this.byHash.delete(entry.hash);
        return { spent: entry.spent, requests: entry.requests };
    }

    /** { entry } for a usable key, else { status, error }. */
    lookup(key) {
        const entry = this.byHash.get(hash(String(key)));
        if (!entry) return { status: 401, error: 'this run key is not valid (it may have been revoked or the harness restarted)' };
        if (this.now() > entry.expires) return { status: 401, error: 'this run key has expired' };
        if (entry.spent >= entry.maxUsd) return { status: 402, error: `this run's budget of $${entry.maxUsd} is used up` };
        entry.requests++;
        return { entry };
    }

    charge(id, usd) {
        const entry = this.byId.get(id);
        if (entry && Number.isFinite(usd)) entry.spent += usd;
    }

    /**
     * Express middleware, placed before the password gate: a run key on a chat
     * completions request sets req.harnessRunKey and takes the gate's place for that
     * request. On any other path a run key falls through and the gate refuses it.
     */
    middleware() {
        return (req, res, next) => {
            const token = String(tokenOf(req));
            if (!token.startsWith(PREFIX) || req.method !== 'POST' || !PATHS.has(req.path)) return next();
            const found = this.lookup(token);
            if (!found.entry) return res.status(found.status).json({ error: found.error });
            req.harnessRunKey = found.entry;
            // the key is the harness's own; the Gateway gets the Gateway's
            delete req.headers.authorization;
            delete req.headers['x-api-key'];
            next();
        };
    }
}

/** Skip a gate (password or login) for a request that carries a valid run key. */
// `gate` may be one middleware or an array of them (the login gate is an array)
const unlessRunKey = (gate) => {
    const skip = (h) => (req, res, next) => (req.harnessRunKey ? next() : h(req, res, next));
    return Array.isArray(gate) ? gate.map(skip) : skip(gate);
};

module.exports = { RunKeys, costOf, unlessRunKey, PREFIX, UNKNOWN_PRICE };
