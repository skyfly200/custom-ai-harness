// The owner's main OpenRouter key (the one that pays for the Gateway, Router and admins), renewed through the
// Management API (utils/openrouterKeys.js). Opt in with OPENROUTER_MAIN_KEY_RENEW=1 plus OPENROUTER_MANAGEMENT_KEY.
// The harness then holds a key it issued itself (name "harness: main", OPENROUTER_MAIN_KEY_LIMIT dollars if set,
// OPENROUTER_MAIN_KEY_DAYS days if set), keeps it in the database when there is one (encrypted, utils/userCredentials.js)
// or in data/openrouter-main-key.json, and swaps in a fresh one before it lapses or when OpenRouter refuses it. The
// Gateway and Router reach OpenRouter through /openrouter-proxy, so they follow the swap without a restart. The key you
// pasted in .env is never deleted by the harness (it does not know its hash): delete it at openrouter.ai once you trust this.
'use strict';

const fs = require('fs');
const path = require('path');
const keys = require('./openrouterKeys');

const OWNER = '(main)'; // not a possible login name
const DAY = 24 * 3600 * 1000;
const ON = /^(1|true|yes|on)$/i;

const enabled = (env = process.env) => ON.test(env.OPENROUTER_MAIN_KEY_RENEW || '') && keys.configured(env);
const file = (env) => env.OPENROUTER_MAIN_KEY_FILE || path.join(__dirname, '..', 'data', 'openrouter-main-key.json');

function createStore({ env = process.env, db = null, creds = null } = {}) {
    if (db && creds) {
        return {
            async load() {
                const r = await creds.resolve(OWNER);
                if (!r) return null;
                const { rows } = await db.query('SELECT key_hash, expires FROM user_credentials WHERE owner = $1', [OWNER]);
                return { key: r.key, hash: rows[0]?.key_hash || null, expires: rows[0]?.expires ? Number(rows[0].expires) : null };
            },
            async save(rec) { await creds.setKey(OWNER, rec.key, 'managed', { hash: rec.hash, expires: rec.expires }); },
        };
    }
    return {
        async load() { try { return JSON.parse(fs.readFileSync(file(env), 'utf8')); } catch { return null; } },
        async save(rec) {
            fs.mkdirSync(path.dirname(file(env)), { recursive: true });
            fs.writeFileSync(file(env), JSON.stringify(rec), { mode: 0o600 });
        },
    };
}

/**
 * { start(), renew(), current } for one process. `env` is where OPENROUTER_API_KEY is read (the proxy's createAuth
 * reads the same object), so replacing it there is all it takes for new requests to use the new key.
 */
function create({ env = process.env, store, fetchFn = fetch, now = Date.now, auth = null } = {}) {
    let rec = null, lastRenew = 0, timer = null;

    async function renew({ force = false } = {}) {
        if (!force && now() - lastRenew < 3600000) return false; // at most once an hour
        lastRenew = now();
        const made = await keys.create('main', { env: { ...env, OPENROUTER_USER_KEY_LIMIT: env.OPENROUTER_MAIN_KEY_LIMIT, OPENROUTER_USER_KEY_DAYS: env.OPENROUTER_MAIN_KEY_DAYS }, fetchFn, now, noLimit: !Number(env.OPENROUTER_MAIN_KEY_LIMIT) });
        const old = rec;
        rec = { key: made.key, hash: made.hash, expires: made.expires };
        await store.save(rec);          // saved before the old key is deleted: a failure here leaves a working key
        env.OPENROUTER_API_KEY = rec.key;
        if (auth && auth.invalidate) auth.invalidate();
        if (old && old.hash) await keys.revoke(old.hash, { env, fetchFn }).catch(() => {});
        return true;
    }

    async function healthy() {
        if (!rec) return false;
        if (rec.expires && rec.expires - now() < DAY) return false;
        try {
            const res = await fetchFn(`${require('./openrouterAuth').apiRoot(env)}/v1/key`, { headers: { authorization: `Bearer ${rec.key}` }, signal: AbortSignal.timeout(10000) });
            return res.status !== 401 && res.status !== 403;
        } catch { return true; } // no answer is not a reason to replace a key
    }

    async function tick() {
        try { if (!(await healthy())) await renew({ force: !rec }); } catch (err) { console.warn(`OpenRouter main key renewal: ${err.message}`); }
    }

    return {
        /** Load the saved key into env, then check now and hourly. */
        async start() {
            rec = await store.load();
            if (rec && rec.key) env.OPENROUTER_API_KEY = rec.key;
            await tick();
            timer = setInterval(tick, 3600000);
            if (timer.unref) timer.unref();
        },
        stop() { if (timer) clearInterval(timer); },
        renew,
        /** The proxy saw OpenRouter refuse the main key. */
        refused() { renew().catch((err) => console.warn(`OpenRouter main key renewal: ${err.message}`)); },
        status: () => ({ managed: Boolean(rec), expires: rec?.expires || null, lastRenew: lastRenew || null }),
    };
}

module.exports = { enabled, create, createStore, OWNER };
