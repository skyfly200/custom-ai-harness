// The Usage page's totals in Postgres (table usage_daily, migrations/012_usage.sql), used by utils/usage.js when a
// database is configured. Rows are added to, never replaced: a write is an upsert that adds the counts, so it
// can't lose what another write (or a restart) saved.
'use strict';

const db = require('./db');

const KEY = ['day', 'user', 'client', 'route', 'model', 'servedBy', 'provider'];
const COUNTS = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'estimated', 'savedAnchor', 'savedHeadroom'];
const CHUNK = 100;

async function loadAll() {
    await db.init();
    const { rows } = await db.query('SELECT * FROM usage_daily');
    return rows.map((r) => ({
        day: r.day, user: r.user_name, client: r.client, route: r.route, model: r.model, servedBy: r.served_by, provider: r.provider,
        requests: Number(r.requests), input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write),
        estimated: Number(r.estimated), savedAnchor: Number(r.saved_anchor), savedHeadroom: Number(r.saved_headroom),
        ...(r.upstream ? { upstream: r.upstream } : {}), ...(r.last_at ? { last: new Date(r.last_at).toISOString() } : {}),
    }));
}

/** Add each row's counts to what is stored (rows: usage.js rows, with `last` and maybe `upstream`). */
async function add(rows) {
    await db.init();
    for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK);
        const params = [];
        const values = part.map((r) => {
            const at = params.length;
            params.push(...KEY.map((k) => r[k] ?? ''), ...COUNTS.map((k) => Math.round(r[k] || 0)), r.upstream || null, r.last || null);
            return `(${params.slice(at).map((_, j) => (j === KEY.length + COUNTS.length + 1 ? `$${at + j + 1}::timestamptz` : `$${at + j + 1}`)).join(', ')})`;
        });
        await db.query(
            `INSERT INTO usage_daily (day, user_name, client, route, model, served_by, provider, requests, input, output, cache_read, cache_write, estimated, saved_anchor, saved_headroom, upstream, last_at)
             VALUES ${values.join(', ')}
             ON CONFLICT (day, user_name, client, route, model, served_by, provider) DO UPDATE SET
               requests = usage_daily.requests + EXCLUDED.requests, input = usage_daily.input + EXCLUDED.input, output = usage_daily.output + EXCLUDED.output,
               cache_read = usage_daily.cache_read + EXCLUDED.cache_read, cache_write = usage_daily.cache_write + EXCLUDED.cache_write,
               estimated = usage_daily.estimated + EXCLUDED.estimated, saved_anchor = usage_daily.saved_anchor + EXCLUDED.saved_anchor,
               saved_headroom = usage_daily.saved_headroom + EXCLUDED.saved_headroom,
               upstream = COALESCE(EXCLUDED.upstream, usage_daily.upstream), last_at = GREATEST(usage_daily.last_at, EXCLUDED.last_at)`,
            params);
    }
}

async function clear() {
    await db.init();
    await db.query('DELETE FROM usage_daily');
}

module.exports = { loadAll, add, clear };
