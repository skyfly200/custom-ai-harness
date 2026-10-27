// npm run migrate: apply migrations/*.sql to DATABASE_URL (from .env, .env.local or the environment).
require('dotenv').config();
require('dotenv').config({ path: '.env.local' });
const db = require('../utils/db');
if (!db.enabled()) { console.error('DATABASE_URL is not set'); process.exit(1); }
db.migrate().then((a) => { console.log(a.length ? `applied: ${a.join(', ')}` : 'already up to date'); return db.close(); })
    .catch((err) => { console.error(err.message); process.exit(1); });
