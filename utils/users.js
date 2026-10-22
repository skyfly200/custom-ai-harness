// Users for HARNESS_REQUIRE_LOGIN: password hashing, the admins from the
// environment, and the users + API keys that admins manage in the app.
//
// Passwords are stored only as scrypt hashes, written
//   scrypt.<N>.<salt>.<hash>   (salt and hash are base64url)
// with dots, not dollar signs, so a hash can sit in .env or docker-compose
// without being read as a variable. `npm run hash` makes one.
// Admins come from HARNESS_ADMINS="alice:HASH,bob:HASH" and can't be changed
// from the app. Everyone else, and every API key, lives in a JSON file
// (HARNESS_USERS_FILE, default users.json) behind the Store interface, so it
// could be swapped for a database or cloud blob storage.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COST = 16384;
const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const MIN_PASSWORD = 8;

function hashPassword(password, cost = COST) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, 32, { N: cost });
    return `scrypt.${cost}.${salt.toString('base64url')}.${key.toString('base64url')}`;
}

function validHash(hash) {
    return /^scrypt\.\d+\.[\w-]+\.[\w-]+$/.test(String(hash));
}

function verifyPassword(password, hash) {
    if (!validHash(hash)) return false;
    const [, cost, salt, key] = hash.split('.');
    const want = Buffer.from(key, 'base64url');
    const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), want.length, { N: Number(cost) });
    return crypto.timingSafeEqual(got, want);
}

// "alice:HASH,bob:HASH" -> [{ name, hash }]. Anything malformed is reported, not skipped silently.
function parseAdmins(text) {
    const admins = [];
    const problems = [];
    for (const entry of String(text || '').split(/[,\s]+/).filter(Boolean)) {
        const colon = entry.indexOf(':');
        const name = colon < 0 ? '' : entry.slice(0, colon);
        const hash = colon < 0 ? '' : entry.slice(colon + 1);
        if (!NAME.test(name)) problems.push(`"${entry.slice(0, 20)}": the user name must be letters, digits, . _ - and be followed by a colon and a hash`);
        else if (!validHash(hash)) problems.push(`${name}: not a hash from \`npm run hash\``);
        else if (admins.some((a) => a.name.toLowerCase() === name.toLowerCase())) problems.push(`${name}: listed twice`);
        else admins.push({ name, hash });
    }
    return { admins, problems };
}

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

class FileStore {
    constructor(file) {
        this.file = file;
        this.data = { users: [], keys: [] };
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            this.data = { users: saved.users || [], keys: saved.keys || [] };
        } catch { /* first run */ }
    }
    save() {
        fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }
}

class Users {
    constructor({ admins = [], store }) {
        this.admins = admins;
        this.store = store;
    }
    get data() { return this.store.data; }
    find(name) {
        const lower = String(name || '').toLowerCase();
        const admin = this.admins.find((a) => a.name.toLowerCase() === lower);
        if (admin) return { name: admin.name, hash: admin.hash, role: 'admin', core: true };
        const user = this.data.users.find((u) => u.name.toLowerCase() === lower);
        return user ? { ...user, core: false } : null;
    }
    list() {
        return [
            ...this.admins.map((a) => ({ name: a.name, role: 'admin', core: true })),
            ...this.data.users.map((u) => ({ name: u.name, role: u.role, core: false, created: u.created })),
        ].map((u) => ({ ...u, keys: this.keys(u.name).length }));
    }
    // Always runs one scrypt, so a wrong user name takes as long as a wrong password
    check(name, password) {
        const user = this.find(name);
        const ok = verifyPassword(password, user ? user.hash : DUMMY);
        return user && ok ? user : null;
    }
    add(name, password, role = 'user') {
        if (!NAME.test(name || '')) throw new Error('user name: letters, digits, . _ - only, up to 40');
        if (String(password || '').length < MIN_PASSWORD) throw new Error(`password: at least ${MIN_PASSWORD} characters`);
        if (this.find(name)) throw new Error('that user already exists');
        this.data.users.push({ name, hash: hashPassword(password), role: role === 'admin' ? 'admin' : 'user', created: new Date().toISOString() });
        this.store.save();
    }
    mutable(name) {
        const user = this.data.users.find((u) => u.name.toLowerCase() === String(name).toLowerCase());
        if (!user) throw new Error(this.find(name) ? 'admins set in HARNESS_ADMINS are changed in .env, not here' : 'no such user');
        return user;
    }
    setPassword(name, password) {
        const user = this.mutable(name);
        if (String(password || '').length < MIN_PASSWORD) throw new Error(`password: at least ${MIN_PASSWORD} characters`);
        user.hash = hashPassword(password);
        this.store.save();
    }
    setRole(name, role) {
        this.mutable(name).role = role === 'admin' ? 'admin' : 'user';
        this.store.save();
    }
    remove(name) {
        const user = this.mutable(name);
        this.data.users = this.data.users.filter((u) => u !== user);
        this.data.keys = this.data.keys.filter((k) => k.owner !== user.name);
        this.store.save();
    }
    keys(owner) {
        return this.data.keys.filter((k) => k.owner.toLowerCase() === String(owner).toLowerCase())
            .map(({ id, name, prefix, created }) => ({ id, name, prefix, created }));
    }
    // The key itself is shown once; only its hash is kept
    addKey(owner, name) {
        const user = this.find(owner);
        if (!user) throw new Error('no such user');
        const key = `hk_${crypto.randomBytes(24).toString('base64url')}`;
        this.data.keys.push({ id: crypto.randomBytes(6).toString('hex'), owner: user.name, name: String(name || 'key').slice(0, 60), prefix: key.slice(0, 7), hash: sha(key), created: new Date().toISOString() });
        this.store.save();
        return key;
    }
    removeKey(owner, id) {
        const before = this.data.keys.length;
        this.data.keys = this.data.keys.filter((k) => !(k.id === id && k.owner.toLowerCase() === String(owner).toLowerCase()));
        if (this.data.keys.length === before) throw new Error('no such key');
        this.store.save();
    }
    byKey(key) {
        if (!String(key).startsWith('hk_')) return null;
        const want = Buffer.from(sha(key));
        const found = this.data.keys.find((k) => {
            const have = Buffer.from(k.hash);
            return have.length === want.length && crypto.timingSafeEqual(have, want);
        });
        return found ? this.find(found.owner) : null;
    }
}

const DUMMY = hashPassword('not a real password');

module.exports = { hashPassword, verifyPassword, validHash, parseAdmins, FileStore, Users, MIN_PASSWORD, sha };
