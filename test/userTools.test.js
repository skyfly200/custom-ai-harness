// A signed-in non-admin's own tools, routings and settings (utils/userMcp.js, utils/userPrefs.js),
// through the real server with logins on and an in-process Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dns = require('node:dns');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-usertools-'));
process.env.MCP_CONFIG = path.join(dir, 'mcp.json'); // read when utils/mcp.js loads
const { PGlite } = require('@electric-sql/pglite');
const db = require('../utils/db');
const pg = new PGlite();
const ready = (async () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
        await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
    }
})();
db.query = async (text, params) => { await ready; return pg.query(text, params); };
db.init = async () => ready;

const secrets = require('../utils/secrets');
const { checkRemoteUrl, buildUserSpec, isPrivateIp, UserMcp } = require('../utils/userMcp');
const { hashPassword } = require('../utils/users');
const { fakeGateway } = require('./helpers/stubs');

let seen = [];
const gateway = fakeGateway((req, body) => { if (body) seen.push(body); });
let harness, base, admin, carol, dave;

test.before(async () => {
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    process.env.DATABASE_URL = 'postgres://stub';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.GATEWAY_CONFIG = path.join(__dirname, 'fixtures', 'config.yaml');
    process.env.ROUTER_URL = 'http://127.0.0.1:9';
    process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
    process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
    process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
    fs.writeFileSync(process.env.MCP_CONFIG, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'echo-mcp-server.js')] } } }));
    process.env.HARNESS_REQUIRE_LOGIN = '1';
    process.env.HARNESS_ADMINS = `alice:${hashPassword('alice-password')}`;
    delete process.env.HARNESS_PASSWORD;
    delete process.env.LITELLM_MASTER_KEY;
    // pretend these names are on the public internet
    dns.promises.lookup = async (host) => (/^mcp\.example\.com$/.test(host) ? [{ address: '93.184.216.34', family: 4 }] : (() => { throw new Error('ENOTFOUND'); })());
    const { app } = require('../server');
    harness = app.listen(0, '127.0.0.1');
    await new Promise((r) => harness.on('listening', r));
    base = `http://127.0.0.1:${harness.address().port}`;
    admin = await signIn('alice', 'alice-password');
    for (const name of ['carol', 'dave']) await fetch(`${base}/ui/api/users`, post(admin, { name, password: `${name}-password` }));
    carol = await signIn('carol', 'carol-password');
    dave = await signIn('dave', 'dave-password');
});

test.after(async () => {
    harness?.close(); gateway.close();
    await require('../server').mcp.close();
});

async function signIn(username, password) {
    const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return (r.headers.get('set-cookie') || '').split(';')[0];
}
const as = (cookie) => ({ headers: { cookie, 'content-type': 'application/json' } });
const post = (cookie, body) => ({ method: 'POST', ...as(cookie), body: JSON.stringify(body) });

test('secrets: round trip, tamper detection, no key means no storing', () => {
    const c = secrets.encrypt('Bearer sk-abc');
    assert.match(c, /^v1\./);
    assert.doesNotMatch(c, /sk-abc/);
    assert.equal(secrets.decrypt(c), 'Bearer sk-abc');
    assert.notEqual(secrets.encrypt('x'), secrets.encrypt('x'));
    const parts = c.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => secrets.decrypt(parts.join('.')));
    const keep = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    assert.equal(secrets.available(), false);
    assert.throws(() => secrets.encrypt('x'), /ENCRYPTION_KEY/);
    process.env.ENCRYPTION_KEY = 'short';
    assert.equal(secrets.available(), false);
    process.env.ENCRYPTION_KEY = keep;
});

test('private and loopback addresses are not allowed for a member\'s server', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fdaa:0:1::2', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.equal(isPrivateIp(ip), true, ip);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
    const lookup = async (h) => (h === 'rebind.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }]);
    for (const url of ['http://localhost:4000/', 'http://127.0.0.1/', 'https://[::1]/', 'http://metadata.internal/', 'http://169.254.169.254/latest', 'http://rebind.example/', 'ftp://example.com/', 'nonsense']) {
        await assert.rejects(checkRemoteUrl(url, lookup), undefined, url);
    }
    await checkRemoteUrl('https://mcp.example.com/mcp', lookup);
});

test('a member can add remote servers only, and ${VAR} is not read from the environment', () => {
    assert.throws(() => buildUserSpec({ type: 'stdio', command: 'sh' }), /remote servers only/);
    assert.throws(() => buildUserSpec({ command: 'sh', type: 'stdio' }), /remote servers only/);
    const spec = buildUserSpec({ url: 'https://mcp.example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer abc' }] });
    assert.equal(spec.type, 'http');
    assert.deepEqual(spec.headers, { Authorization: 'Bearer abc' });
});

test('a member\'s manager takes their servers from the database and never expands the environment', async () => {
    process.env.SECRET_FOR_TEST = 'leak';
    const hub = new UserMcp();
    let url;
    const server = http.createServer((req, res) => { url = req.url; res.writeHead(500); res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    // a stored entry that tries to read the environment: with expansion off, the literal text is what's sent
    await hub.write('zed', { probe: { type: 'http', url: `http://127.0.0.1:${server.address().port}/x`, headers: { 'x-secret': '${SECRET_FOR_TEST}' } } }, {});
    const mgr = hub.manager('zed');
    await mgr.start();
    // 127.0.0.1 is refused by the address check before any request is made
    assert.equal(mgr.status().servers[0].status, 'failed');
    assert.match(mgr.status().servers[0].error, /private network/);
    assert.equal(url, undefined);
    await hub.closeAll();
    await pg.query("DELETE FROM user_mcp WHERE owner = 'zed'");
    server.close();
});

test('tools: a member adds a remote server, sees only theirs, and cannot reach admin tools', async () => {
    // admin keeps the shared stdio server
    const shared = await (await fetch(`${base}/ui/api/tools`, as(admin))).json();
    assert.equal(shared.servers[0].name, 'echo');

    const mine = await (await fetch(`${base}/ui/api/tools`, as(carol))).json();
    assert.deepEqual(mine.servers, []);
    assert.deepEqual(mine.repoDefinitions, []);
    assert.deepEqual(mine.shellDefinitions, []);

    const stdio = await fetch(`${base}/ui/api/mcp/save`, post(carol, { name: 'sh', spec: { type: 'stdio', command: 'sh', args: ['-c', 'id'] } }));
    assert.equal(stdio.status, 400);
    assert.match((await stdio.json()).error, /remote servers only/);
    for (const url of ['http://localhost:4000/mcp', 'http://169.254.169.254/', 'https://nowhere.invalid/mcp']) {
        assert.equal((await fetch(`${base}/ui/api/mcp/save`, post(carol, { name: 'bad', spec: { type: 'http', url } }))).status, 400, url);
    }

    const saved = await fetch(`${base}/ui/api/mcp/save`, post(carol, { name: 'docs', spec: { type: 'http', url: 'https://mcp.example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer top-secret' }] } }));
    assert.equal(saved.status, 200);
    const list = await saved.json();
    assert.equal(list.own, true);
    assert.equal(list.file, 'your account');
    assert.equal(list.servers[0].name, 'docs');
    assert.doesNotMatch(JSON.stringify(list), /top-secret/);
    assert.ok(list.catalog.length > 0 && list.catalog.every((c) => c.spec.url));

    // the stored row is encrypted
    const { rows } = await pg.query('SELECT owner, spec_enc FROM user_mcp');
    assert.deepEqual(rows.map((r) => r.owner), ['carol']);
    assert.doesNotMatch(rows[0].spec_enc, /top-secret|mcp\.example\.com/);

    // dave sees nothing of carol's; carol sees none of the admin's
    assert.deepEqual((await (await fetch(`${base}/ui/api/mcp`, as(dave))).json()).servers, []);
    assert.deepEqual((await (await fetch(`${base}/ui/api/mcp`, as(carol))).json()).servers.map((s) => s.name), ['docs']);

    // calling the admin's echo server, a shell or a repo tool as a member fails as a tool error
    for (const name of ['mcp__echo__add', 'bash', 'repo_read_file']) {
        const r = await (await fetch(`${base}/ui/api/tools/call`, post(carol, { name, arguments: { a: 1, b: 2 } }))).json();
        assert.equal(r.isError, true, name);
    }
    assert.equal((await (await fetch(`${base}/ui/api/tools/call`, post(admin, { name: 'mcp__echo__add', arguments: { a: 1, b: 2 } }))).json()).text, '3');

    // switch off and remove
    assert.equal((await fetch(`${base}/ui/api/mcp/patch`, post(carol, { name: 'docs', disabled: true }))).status, 200);
    const gone = await (await fetch(`${base}/ui/api/mcp/remove`, post(carol, { name: 'docs' }))).json();
    assert.deepEqual(gone.servers, []);
    assert.equal((await pg.query('SELECT 1 FROM user_mcp')).rows.length, 0);
});

test('without ENCRYPTION_KEY a member is told why, and nothing is stored', async () => {
    const keep = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
        const r = await fetch(`${base}/ui/api/mcp/save`, post(carol, { name: 'docs', spec: { type: 'http', url: 'https://mcp.example.com/mcp' } }));
        assert.equal(r.status, 503);
        assert.match((await r.json()).error, /ENCRYPTION_KEY/);
        assert.equal((await pg.query('SELECT 1 FROM user_mcp')).rows.length, 0);
    } finally { process.env.ENCRYPTION_KEY = keep; }
});

test('routings: a member\'s own are saved per person, validated against the Gateway, and used for their requests', async () => {
    const MINE = { name: 'Mine', down: 'fast-openrouter', downTools: 'fast-openrouter', strong: 'fast-openrouter', weak: 'fast-openrouter' };
    const start = await (await fetch(`${base}/ui/api/profiles`, as(carol))).json();
    assert.equal(start.own, true);
    assert.deepEqual(start.profiles, []);

    const unknown = await fetch(`${base}/ui/api/profiles`, post(carol, { version: start.version, profiles: [{ ...MINE, strong: 'gpt-nonexistent' }] }));
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /no model called/);

    const ok = await (await fetch(`${base}/ui/api/profiles`, post(carol, { version: start.version, profiles: [MINE] }))).json();
    assert.deepEqual(ok.profiles.map((p) => p.id), ['mine']);
    assert.equal(ok.version, start.version + 1);
    // a stale page is refused
    assert.equal((await fetch(`${base}/ui/api/profiles`, post(carol, { version: start.version, profiles: [] }))).status, 409);

    // dave doesn't see it and can't use it
    assert.deepEqual((await (await fetch(`${base}/ui/api/profiles`, as(dave))).json()).profiles, []);

    const ask = (cookie) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-harness-profile': 'mine' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) });
    seen = [];
    assert.equal((await ask(carol)).status, 200);
    assert.equal(seen.at(-1).model, 'fast-openrouter');
    seen = [];
    assert.equal((await ask(dave)).status, 200);
    assert.notEqual(seen.at(-1).model, 'fast-openrouter', 'dave has no routing called mine, so the default is used');

    // admins still manage the shared routings in the file; a member can't overwrite them
    const shared = await (await fetch(`${base}/ui/api/profiles`, post(admin, { profiles: [{ ...MINE, name: 'Shared one' }] }))).json();
    assert.equal(shared.profiles[0].id, 'shared-one');
    const back = await (await fetch(`${base}/ui/api/profiles`, as(carol))).json();
    assert.deepEqual(back.profiles.map((p) => [p.id, !!p.shared]), [['shared-one', true], ['mine', false]]);
    // the shared one coming back in the list is ignored, and its name can't be reused
    const again = await (await fetch(`${base}/ui/api/profiles`, post(carol, { version: back.version, profiles: back.profiles }))).json();
    assert.deepEqual(again.profiles.map((p) => p.id), ['shared-one', 'mine']);
    const clash = await fetch(`${base}/ui/api/profiles`, post(carol, { version: again.version, profiles: [{ ...MINE, name: 'Shared one' }] }));
    assert.equal(clash.status, 400);
});

test('settings: a member changes compression for themselves only', async () => {
    const mine = await (await fetch(`${base}/ui/api/my/settings`, post(carol, { caveman: false }))).json();
    assert.deepEqual(mine.settings, { caveman: false });
    assert.equal((await fetch(`${base}/ui/api/my/settings`, post(carol, { guardJev: false }))).status, 400);
    assert.equal((await fetch(`${base}/ui/api/my/settings`, post(carol, { caveman: 'no' }))).status, 400);
    assert.deepEqual((await (await fetch(`${base}/ui/api/my/settings`, as(dave))).json()).settings, {});
    // the controls stay admin-only
    assert.equal((await fetch(`${base}/ui/api/settings`, post(carol, { caveman: false }))).status, 403);

    const ask = (cookie) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: as(cookie).headers, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) });
    seen = [];
    await ask(carol);
    const carolSystem = JSON.stringify(seen.at(-1).messages);
    seen = [];
    await ask(dave);
    assert.notEqual(JSON.stringify(seen.at(-1).messages), carolSystem, 'dave still gets the terse-output instruction');
});

test('the sync list does not carry the routing and settings rows', async () => {
    const j = await (await fetch(`${base}/ui/api/sync`, as(carol))).json();
    assert.deepEqual(Object.keys(j.data), []);
});
