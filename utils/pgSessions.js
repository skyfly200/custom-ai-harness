// Write-through persistence for utils/login.js sessions (sha(token) -> { name, expires }).
const db = require('./db');

function pgSessions() {
    const log = (what) => (err) => console.error(`[db] sessions ${what} failed: ${err.message}`);
    return {
        async load() {
            await db.init();
            await db.query('DELETE FROM sessions WHERE expires < $1', [Date.now()]);
            return (await db.query('SELECT id_hash, name, expires FROM sessions')).rows.map((r) => [r.id_hash, { name: r.name, expires: Number(r.expires) }]);
        },
        put(id, s) { db.query('INSERT INTO sessions (id_hash, name, expires) VALUES ($1, $2, $3) ON CONFLICT (id_hash) DO NOTHING', [id, s.name, s.expires]).catch(log('save')); },
        drop(id) { db.query('DELETE FROM sessions WHERE id_hash = $1', [id]).catch(log('delete')); },
        dropUser(name) { db.query('DELETE FROM sessions WHERE lower(name) = lower($1)', [name]).catch(log('delete')); },
    };
}

module.exports = { pgSessions };
