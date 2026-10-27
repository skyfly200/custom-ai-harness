// Optional Postgres (Neon) for hosted use. With no DATABASE_URL nothing here runs and the
// harness keeps using users.json and the browser's localStorage.
//
// DATABASE_DRIVER=http uses Neon's HTTPS driver (@neondatabase/serverless) instead of the pg
// TCP driver: for hosts that only allow outbound 443 (cloud sandboxes). One statement per
// request, so no transactions; fine for this app's single-statement writes.
//
// Use the pooled DATABASE_URL (host with -pooler) at runtime; migrations run on the same
// connection because they are plain statements (no session state). Neon scales to zero after
// idle, so the first query after a pause can fail once: query() retries once on a connection error.
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const RETRYABLE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|Connection terminated|timeout|57P01/i;

let pool = null;
let httpSql = null;
let ready = null;

const http = () => process.env.DATABASE_DRIVER === 'http';

function enabled() { return Boolean(process.env.DATABASE_URL); }

function getPool() {
    if (!enabled()) return null;
    if (!pool) {
        const { Pool } = require('pg');
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: Number(process.env.DATABASE_POOL_MAX) || 5,
            idleTimeoutMillis: 20000,
            connectionTimeoutMillis: 15000,
        });
        pool.on('error', (err) => console.error(`[db] idle connection error: ${err.message}`));
    }
    return pool;
}

async function query(text, params) {
    if (!enabled()) throw new Error('DATABASE_URL is not set');
    const run = async () => {
        if (!http()) return getPool().query(text, params);
        httpSql = httpSql || require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
        const rows = await httpSql.query(text, params || []);
        return { rows, rowCount: rows.length };
    };
    try { return await run(); } catch (err) {
        if (!RETRYABLE.test(String(err.message || err.code))) throw err;
        return run();
    }
}

// Applies migrations/*.sql in name order, once each, and records them in schema_migrations.
async function migrate() {
    await query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied = [];
    for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue;
        const sqlText = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
        if (http()) {
            // statements end with ";" at a line end; the files hold no function bodies
            for (const stmt of sqlText.split(/;\s*\n/).map((x) => x.replace(/^(\s*--.*\n)+/g, '').trim()).filter(Boolean)) await query(stmt);
            await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
            applied.push(file);
            continue;
        }
        const client = await getPool().connect();
        try {
            await client.query('BEGIN');
            await client.query(sqlText);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
            await client.query('COMMIT');
            applied.push(file);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`migration ${file} failed: ${err.message}`);
        } finally { client.release(); }
    }
    return applied;
}

// Resolves once the schema is current; null when there is no database.
function init() {
    if (!enabled()) return null;
    if (!ready) ready = migrate().then((a) => { if (a.length) console.log(`[db] applied ${a.join(', ')}`); });
    return ready;
}

async function close() { if (pool) { await pool.end(); pool = null; ready = null; } }

module.exports = { enabled, query, migrate, init, close };
