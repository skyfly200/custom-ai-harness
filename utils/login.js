// HARNESS_REQUIRE_LOGIN=1: the whole app sits behind named logins.
//
// Browsers sign in on /login and get a session cookie (HttpOnly, SameSite=Lax,
// Secure over https). Programs send `Authorization: Bearer KEY` or `x-api-key: KEY`
// with a key made on the Users page, or HTTP Basic with a user name and password
// (Claude Code: ANTHROPIC_AUTH_TOKEN = a key). A HARNESS_PASSWORD, if also set,
// keeps working as an admin key. Only admins reach Settings and Users, and only
// admins can use the controls (settings, routing, runs).
// Wrong passwords are rate limited by address and by user name.
const crypto = require('crypto');
const express = require('express');
const { passwordsFrom, viaCloudflare, PASSWORD_HEADER } = require('./access');
const { sha, MIN_PASSWORD } = require('./users');
const oauth = require('./oauth');

const COOKIE = 'harness_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_SESSIONS = 500;
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const ADMIN_ONLY_PAGES = new Set(['/ui/settings.html', '/settings.html']);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeNext = (next) => (typeof next === 'string' && /^\/(?!\/|\\)/.test(next) ? next : '/');

function loginPage({ next, error, providers = [] }) {
    const buttons = providers.map((p) => `<a class="oauth" href="/auth/${p}?next=${encodeURIComponent(next)}">Continue with ${p === 'github' ? 'GitHub' : 'Google'}</a>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sign in · Bright Chat</title>
<meta name="theme-color" content="#0d0b18">
<link rel="icon" href="/login/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light dark;--bg:#f6f4fb;--card:#fff;--ink:#1d1830;--muted:#6b6485;--line:#ddd8ec;--field:#ddd8ec;--accent:#6d4aff;--bad:#c4264a}
@media(prefers-color-scheme:dark){:root{--bg:#0d0b18;--card:#171428;--ink:#ece9f8;--muted:#9a93b8;--line:#2b2644;--field:#78749c;--accent:#8f74ff;--bad:#ff6b8b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.4 system-ui,sans-serif}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;display:grid;gap:14px}
h1{margin:0;font-size:20px}p{margin:0;color:var(--muted);font-size:14px}label{display:grid;gap:4px;font-size:14px;color:var(--muted)}
input{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--field);background:var(--bg);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:600;padding:10px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6}.oauth{display:block;text-align:center;font-weight:600;padding:10px;border:1px solid var(--line);border-radius:10px;color:var(--ink);text-decoration:none}.or{color:var(--muted);font-size:13px;text-align:center}.err{color:var(--bad);font-size:14px;min-height:1.2em}
</style></head><body>
<form id="f" method="post" action="/login">
<h1>Bright Chat</h1><p>Sign in to continue.</p>
${buttons}${buttons ? '<div class="or">or with a user name</div>' : ''}
<label>User name<input name="username" autocomplete="username" autocapitalize="none" autofocus required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<input type="hidden" name="next" value="${esc(next)}">
<div class="err" id="err" role="alert">${esc(error || '')}</div>
<button>Sign in</button>
</form>
<script>
const f=document.getElementById('f'),err=document.getElementById('err');
f.addEventListener('submit',async(e)=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;err.textContent='';
try{const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});
const j=await r.json().catch(()=>({}));if(r.ok){location.href=j.next||'/';return}err.textContent=j.error||'Sign in failed';}
catch{err.textContent='Could not reach the harness'}b.disabled=false});
</script></body></html>`;
}

// `guests` (optional, needs the database): { ensure(name, capUsd), setCap(name, capUsd), forget(name), all() } for guest credit
function createLogin({ users, legacyPassword = '', sessionStore = null, guests = null }) {
    const sessions = new Map(); // sha(token) -> { name, expires }
    // sessions saved in a database come back after a restart; requests wait for them (see `gate`)
    const loaded = sessionStore ? sessionStore.load().then((rows) => { for (const [k, v] of rows) sessions.set(k, v); }).catch((err) => console.error(`[db] loading sessions failed: ${err.message}`)) : null;
    const fails = new Map(); // key -> [timestamps]
    const basicOk = new Map(); // sha(name\0password) -> { name, expires }, spares scrypt on every API call

    // On Fly every request arrives from Fly's proxy, so the address that counts is the one it puts in Fly-Client-IP
    // (only believed on Fly itself, where FLY_APP_NAME is set; anywhere else a caller could write that header)
    const ipOf = (req) => (process.env.FLY_APP_NAME && req.headers['fly-client-ip']) || req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
    const failKeys = (req, name) => [`ip:${ipOf(req)}`, `user:${String(name || '').toLowerCase()}`];
    function recent(key) {
        const now = Date.now();
        const list = (fails.get(key) || []).filter((t) => now - t < WINDOW_MS);
        if (list.length) fails.set(key, list); else fails.delete(key);
        return list;
    }
    function lockedFor(req, name) {
        let wait = 0;
        for (const key of failKeys(req, name)) {
            const list = recent(key);
            if (list.length >= MAX_FAILS) wait = Math.max(wait, Math.ceil((list[0] + WINDOW_MS - Date.now()) / 1000));
        }
        return wait;
    }
    function fail(req, name) {
        for (const key of failKeys(req, name)) fails.set(key, [...recent(key), Date.now()]);
        if (fails.size > 5000) fails.clear();
    }

    const cookieOf = (req) => {
        for (const part of (req.headers.cookie || '').split(';')) {
            const eq = part.indexOf('=');
            if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
        }
        return '';
    };
    const secure = (req) => req.secure || /https/.test(req.headers['x-forwarded-proto'] || '') || /https/.test(req.headers['cf-visitor'] || '');
    const setCookie = (req, res, value, maxAgeS) => res.append('set-cookie',
        `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${secure(req) ? '; Secure' : ''}`);

    function startSession(req, res, name) {
        const now = Date.now();
        for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(sha(token), { name, expires: now + SESSION_MS });
        if (sessionStore) sessionStore.put(sha(token), { name, expires: now + SESSION_MS });
        setCookie(req, res, token, SESSION_MS / 1000);
    }

    const principal = (u) => ({ name: u.name, role: u.role, core: Boolean(u.core), ...(u.guest ? { guest: true } : {}) });

    // Who is this request? Returns { user, used } or { error, wait } for rate-limited Basic attempts
    function identify(req) {
        const token = cookieOf(req);
        if (token) {
            const s = sessions.get(sha(token));
            if (s && s.expires > Date.now()) {
                const u = users.find(s.name);
                if (u) return { user: principal(u), used: 'session' };
            }
        }
        const auth = req.headers.authorization || '';
        const basic = /^basic\s+(.+)$/i.exec(auth);
        const bearer = /^bearer\s+(.+)$/i.exec(auth);
        const candidates = [req.headers[PASSWORD_HEADER], bearer && bearer[1].trim(), req.headers['x-api-key']].filter(Boolean);
        if (basic) {
            const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
            const colon = decoded.indexOf(':');
            const name = colon > 0 ? decoded.slice(0, colon) : '';
            const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
            if (name && !pass.startsWith('hk_') && !(legacyPassword && pass === legacyPassword)) {
                const cacheKey = sha(`${name}\0${pass}`);
                const hit = basicOk.get(cacheKey);
                if (hit && hit.expires > Date.now()) {
                    const u = users.find(hit.name);
                    if (u) return { user: principal(u), used: 'basic' };
                }
                const wait = lockedFor(req, name);
                if (wait) return { wait };
                const u = users.check(name, pass);
                if (u) {
                    if (basicOk.size > 1000) basicOk.clear();
                    basicOk.set(cacheKey, { name: u.name, expires: Date.now() + 60000 });
                    return { user: principal(u), used: 'basic' };
                }
                fail(req, name);
                return {};
            }
            if (pass) candidates.push(pass); // a key with any (or no) user name
        }
        for (const c of candidates) {
            const u = users.byKey(c);
            if (u) return { user: principal(u), used: 'key', secret: c };
            if (legacyPassword && sha(c) === sha(legacyPassword)) return { user: { name: 'password', role: 'admin', core: true }, used: 'key', secret: c };
        }
        return {};
    }

    function stripCredentials(req, found) {
        delete req.headers[PASSWORD_HEADER];
        if (/^basic\s/i.test(req.headers.authorization || '')) delete req.headers.authorization;
        if (found.secret) {
            if ((req.headers.authorization || '').replace(/^bearer\s+/i, '').trim() === found.secret) delete req.headers.authorization;
            if (req.headers['x-api-key'] === found.secret) delete req.headers['x-api-key'];
        }
        if (req.headers.cookie) {
            const rest = req.headers.cookie.split(';').filter((p) => p.trim().split('=')[0] !== COOKIE).join(';').trim();
            if (rest) req.headers.cookie = rest; else delete req.headers.cookie;
        }
    }

    const wantsHtml = (req) => req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
    const pathOf = (req) => req.path;

    const router = express.Router();
    router.get('/login', (req, res) => {
        if (identify(req).user) return res.redirect(safeNext(req.query.next));
        res.set('cache-control', 'no-store').type('html').send(loginPage({ next: safeNext(req.query.next), providers: oauth.enabled() ? oauth.providers() : [] }));
    });
    if (oauth.enabled()) router.use(oauth.createOAuth({ users, startSession, safeNext }));
    router.get('/login/favicon.svg', (req, res) => res.sendFile(require('path').join(__dirname, '..', 'ui', 'favicon.svg')));
    router.post('/login', express.json({ limit: '4kb' }), (req, res) => {
        const { username = '', password = '', next } = req.body || {};
        const wait = lockedFor(req, username);
        if (wait) return res.set('retry-after', String(wait)).status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.` });
        const u = users.check(username, password);
        if (!u) {
            fail(req, username);
            return res.status(401).json({ error: 'Wrong user name or password' });
        }
        fails.delete(`user:${u.name.toLowerCase()}`);
        startSession(req, res, u.name);
        res.json({ ok: true, next: safeNext(next) });
    });
    router.post('/logout', (req, res) => {
        sessions.delete(sha(cookieOf(req)));
        if (sessionStore) sessionStore.drop(sha(cookieOf(req)));
        setCookie(req, res, '', 0);
        res.json({ ok: true });
    });

    const gate = [(req, res, next) => (loaded ? loaded.then(() => next()) : next()), router, (req, res, next) => {
        const found = identify(req);
        if (found.wait) return res.set('retry-after', String(found.wait)).status(429).json({ error: 'too many wrong passwords; wait and try again' });
        if (!found.user) {
            if (wantsHtml(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
            return res.status(401).json({ error: 'login required: send a key from the Users page as Authorization: Bearer or x-api-key' });
        }
        req.harnessLogin = true;
        req.harnessUser = found.user;
        req.harnessAuthenticated = found.user.role === 'admin';
        const admin = found.user.role === 'admin';
        if (!admin && (ADMIN_ONLY_PAGES.has(pathOf(req)) || pathOf(req).startsWith('/ui/api/users'))) {
            if (wantsHtml(req)) return res.status(403).type('html').send('<p style="font:16px system-ui;padding:24px">Only admins can open this page. <a href="/">Back to the dashboard</a></p>');
            return res.status(403).json({ error: 'admins only' });
        }
        stripCredentials(req, found);
        res.set('cache-control', 'no-store');
        next();
    }];

    // JSON routes behind the gate
    const api = express.Router();
    api.use(express.json({ limit: '16kb' }));
    const admin = (req, res, next) => (req.harnessUser.role === 'admin' ? next() : res.status(403).json({ error: 'admins only' }));
    const guarded = (fn) => (req, res) => {
        try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
    };
    api.get('/ui/api/me', (req, res) => res.json({ ...req.harnessUser, minPassword: MIN_PASSWORD }));
    api.post('/ui/api/me/password', guarded((req, res) => {
        const me = req.harnessUser;
        if (me.core) throw new Error('admins from HARNESS_ADMINS change their password in .env (npm run hash)');
        const { current, password } = req.body || {};
        const wait = lockedFor(req, me.name);
        if (wait) return res.status(429).json({ error: 'too many wrong passwords; wait and try again' });
        if (!users.check(me.name, current)) { fail(req, me.name); throw new Error('current password is wrong'); }
        users.setPassword(me.name, password);
        basicOk.clear();
        res.json({ ok: true });
    }));
    // the users with each guest's credit; if the database doesn't answer the list still comes, without credit
    const withCredit = async () => {
        let credit = {};
        if (guests) { try { credit = await guests.all(); } catch (err) { console.warn(`[login] guest credit unavailable: ${err.message}`); } }
        return users.list().map((u) => (u.guest && credit[u.name] ? { ...u, credit: credit[u.name] } : u));
    };
    const aguarded = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
    };
    const capOf = (body) => {
        const cap = body?.capUsd === undefined || body.capUsd === '' ? Number(process.env.HARNESS_GUEST_CAP_USD || 1) : Number(body.capUsd);
        if (!Number.isFinite(cap) || cap < 0 || cap > 1000) throw new Error('the guest cap must be a dollar amount from 0 to 1000');
        return cap;
    };
    api.get('/ui/api/users', admin, aguarded(async (req, res) => res.json({ users: await withCredit(), minPassword: MIN_PASSWORD, guests: Boolean(guests), managedKeys: Boolean(guests && String(process.env.OPENROUTER_MANAGEMENT_KEY || '').trim()) })));
    api.post('/ui/api/users', admin, aguarded(async (req, res) => {
        const guest = req.body?.guest === true || req.body?.guest === 'on' || req.body?.guest === 'true';
        if (guest && !guests) throw new Error('guest accounts need the hosted database (DATABASE_URL)');
        const cap = guest ? capOf(req.body) : null;
        users.add(req.body?.name, req.body?.password, req.body?.role, { guest });
        if (guest) {
            try { await guests.ensure(req.body.name, cap); } catch (err) { users.remove(req.body.name); throw new Error(`could not open the guest's credit: ${err.message}`); }
        }
        res.json({ users: await withCredit() });
    }));
    api.post('/ui/api/users/:name', admin, aguarded(async (req, res) => {
        const { password, role, guest, capUsd } = req.body || {};
        if (role && req.params.name.toLowerCase() === req.harnessUser.name.toLowerCase()) throw new Error('you can\'t change your own role');
        if ((guest !== undefined || capUsd !== undefined) && !guests) throw new Error('guest accounts need the hosted database (DATABASE_URL)');
        if (password) { users.setPassword(req.params.name, password); basicOk.clear(); }
        if (role) users.setRole(req.params.name, role);
        if (guest !== undefined) {
            if (guest) await guests.ensure(req.params.name, capOf(req.body));
            users.setGuest(req.params.name, Boolean(guest));
        }
        if (capUsd !== undefined && capUsd !== '') await guests.setCap(req.params.name, capOf(req.body));
        res.json({ users: await withCredit() });
    }));
    api.delete('/ui/api/users/:name', admin, aguarded(async (req, res) => {
        if (req.params.name.toLowerCase() === req.harnessUser.name.toLowerCase()) throw new Error('you can\'t remove yourself');
        users.remove(req.params.name);
        if (guests) await guests.forget(req.params.name).catch((err) => console.warn(`[login] forgetting ${req.params.name}'s credit failed: ${err.message}`));
        for (const [k, s] of sessions) if (s.name.toLowerCase() === req.params.name.toLowerCase()) sessions.delete(k);
        if (sessionStore) sessionStore.dropUser(req.params.name);
        basicOk.clear();
        res.json({ users: await withCredit() });
    }));
    // Invited emails for Google / GitHub sign-in
    api.get('/ui/api/invites', admin, (req, res) => res.json({ invites: users.listInvites(), providers: oauth.enabled() ? oauth.providers() : [] }));
    api.post('/ui/api/invites', admin, guarded((req, res) => {
        if (req.body?.role === 'guest' && !guests) throw new Error('guest accounts need the hosted database (DATABASE_URL)');
        users.addInvite(req.body?.email, req.body?.role);
        res.json({ invites: users.listInvites() });
    }));
    api.delete('/ui/api/invites/:email', admin, guarded((req, res) => {
        users.removeInvite(req.params.email);
        res.json({ invites: users.listInvites() });
    }));
    // API keys: yours, or anyone's if you're an admin
    const ownerOf = (req) => {
        const owner = req.query.owner || req.body?.owner || req.harnessUser.name;
        if (owner.toLowerCase() !== req.harnessUser.name.toLowerCase() && req.harnessUser.role !== 'admin') throw new Error('you can only manage your own keys');
        return owner;
    };
    api.get('/ui/api/keys', guarded((req, res) => res.json({ keys: users.keys(ownerOf(req)) })));
    api.post('/ui/api/keys', guarded((req, res) => {
        const owner = ownerOf(req);
        const key = users.addKey(owner, req.body?.name);
        res.json({ key, keys: users.keys(owner) });
    }));
    api.delete('/ui/api/keys/:id', guarded((req, res) => {
        const owner = ownerOf(req);
        users.removeKey(owner, req.params.id);
        res.json({ keys: users.keys(owner) });
    }));
    gate.push(api);

    return { gate, identify, sessions, fails };
}

module.exports = { createLogin, COOKIE, viaCloudflare };
