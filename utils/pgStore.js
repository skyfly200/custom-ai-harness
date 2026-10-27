// The Users store (see utils/users.js) kept in Postgres instead of users.json: same
// `data` object and `save()`, so Users is unchanged. `load()` runs once at start; writes are
// queued one at a time so a burst of changes ends with the latest data.
const db = require('./db');

class PgStore {
    constructor(name = 'users') {
        this.name = name;
        this.data = { users: [], keys: [], invites: [] };
        this.chain = Promise.resolve();
    }
    async load() {
        await db.init();
        const { rows } = await db.query('SELECT data FROM harness_store WHERE name = $1', [this.name]);
        if (rows[0]) this.data = { users: rows[0].data.users || [], keys: rows[0].data.keys || [], invites: rows[0].data.invites || [] };
    }
    save() {
        const body = JSON.stringify(this.data);
        this.chain = this.chain
            .then(() => db.query(
                `INSERT INTO harness_store (name, data) VALUES ($1, $2::jsonb)
                 ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [this.name, body]))
            .catch((err) => console.error(`[db] saving ${this.name} failed: ${err.message}`));
        return this.chain;
    }
}

module.exports = { PgStore };
