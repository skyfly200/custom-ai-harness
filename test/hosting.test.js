// Hosting for new apps: the CI and deploy files for each host, the database settings, the GitHub repo
// helpers (with a stubbed GitHub) and what a new app records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hosting-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const hosting = require('../runner/hosting');
const github = require('../runner/github');
const { AppStore } = require('../runner/apps');
const { RunManager } = require('../runner/runs');

const text = (files, p) => files.find((f) => f.path === p)?.text;
const paths = (files) => files.map((f) => f.path);

test('the catalog lists every host and database with plain-English help', () => {
  const { targets, databases } = hosting.catalog();
  assert.deepStrictEqual(targets.map((t) => t.id), ['none', 'vercel', 'netlify', 'flyio']);
  assert.deepStrictEqual(databases.map((d) => d.id), ['none', 'neon', 'supabase']);
  for (const o of [...targets, ...databases]) assert.ok(o.label && o.help, `${o.id} has a label and help`);
});

test('a new app with no host or database gets only the CI workflow', () => {
  const files = hosting.hostingFiles({ name: 'Demo', slug: 'demo', testCommand: 'npm test' });
  assert.deepStrictEqual(paths(files), ['.github/workflows/ci.yml']);
  assert.match(text(files, '.github/workflows/ci.yml'), /run: npm test/);
});

test('each host writes its deploy workflow and reads secrets only from GitHub', () => {
  const expect = { vercel: ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'], netlify: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'], flyio: ['FLY_API_TOKEN'] };
  for (const [target, secrets] of Object.entries(expect)) {
    const files = hosting.hostingFiles({ name: 'Demo', slug: 'demo', deployTarget: target, testCommand: 'npm test' });
    const deploy = text(files, '.github/workflows/deploy.yml');
    assert.ok(deploy, `${target} has a deploy workflow`);
    assert.match(deploy, /branches: \[main\]/);
    for (const s of secrets) assert.match(deploy, new RegExp(`${s}: \\$\\{\\{ secrets\\.${s} \\}\\}`));
    assert.doesNotMatch(deploy, /[A-Za-z0-9]{32,}/, 'no literal credential in the workflow');
    for (const s of secrets) assert.match(text(files, 'DEPLOY.md'), new RegExp(s));
  }
  assert.ok(text(hosting.hostingFiles({ name: 'D', slug: 'd', deployTarget: 'flyio' }), 'fly.toml').includes('internal_port = 8080'));
  assert.ok(text(hosting.hostingFiles({ name: 'D', slug: 'd', deployTarget: 'netlify' }), 'netlify.toml').includes('publish = "public"'));
});

test('a database adds its env names, its secrets and a local .env.example', () => {
  const neon = hosting.hostingFiles({ name: 'Demo', slug: 'demo', deployTarget: 'vercel', database: 'neon' });
  assert.equal(text(neon, '.env.example'), 'DATABASE_URL=\n');
  assert.match(text(neon, '.github/workflows/deploy.yml'), /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/);
  const supa = hosting.hostingFiles({ name: 'Demo', slug: 'demo', database: 'supabase' });
  assert.equal(text(supa, '.env.example'), 'SUPABASE_URL=\nSUPABASE_ANON_KEY=\n');
  assert.ok(text(supa, 'DEPLOY.md').includes('SUPABASE_ANON_KEY'));
  assert.deepStrictEqual(paths(supa), ['.github/workflows/ci.yml', '.env.example', 'DEPLOY.md']);
});

test('unknown hosts, databases and commands are refused before anything is written', () => {
  assert.throws(() => hosting.hostingFiles({ name: 'D', slug: 'd', deployTarget: 'heroku' }), /deploy target must be one of/);
  assert.throws(() => hosting.hostingFiles({ name: 'D', slug: 'd', database: 'mysql' }), /database must be one of/);
  assert.throws(() => hosting.hostingFiles({ name: 'D', slug: 'd', testCommand: 'npm test; rm -rf /' }), /cannot run safely/);
  assert.throws(() => hosting.hostingFiles({ name: 'D', slug: 'd', testCommand: 'npm test\n  - run: evil' }), /cannot run safely/);
});

test('the app store records the host and database, and refuses unknown ones', () => {
  const store = new AppStore(path.join(dir, 'apps-store'));
  const app = store.create({ name: 'Demo', editablePaths: ['src/**'], deployTarget: 'netlify', database: 'neon' }, path.join(dir, 'demo'));
  assert.equal(app.deployTarget, 'netlify');
  assert.equal(app.database, 'neon');
  const bare = store.create({ name: 'Bare', editablePaths: ['src/**'] }, path.join(dir, 'bare'));
  assert.equal(bare.deployTarget, 'none');
  assert.equal(bare.database, 'none');
  assert.throws(() => store.update(app.id, { deployTarget: 'heroku' }), /deploy target must be one of/);
  assert.equal(store.update(app.id, { database: 'none' }).database, 'none');
  assert.equal(store.update(app.id, { name: 'Renamed' }).deployTarget, 'netlify', 'an update that leaves the host alone keeps it');
});

test('createRepo asks GitHub for a private repo and explains each refusal', async () => {
  const seen = [];
  const reply = (status, body) => async (url, opts) => {
    seen.push({ url, opts });
    return { status, ok: status < 300, json: async () => body };
  };
  const made = await github.createRepo({ name: 'note-board', token: 'tok', fetchImpl: reply(201, { name: 'note-board', owner: { login: 'skyfly200' }, html_url: 'https://github.com/skyfly200/note-board' }), apiUrl: 'https://api.test' });
  assert.deepStrictEqual(made, { owner: 'skyfly200', name: 'note-board', url: 'https://github.com/skyfly200/note-board' });
  assert.equal(seen[0].url, 'https://api.test/user/repos');
  assert.equal(JSON.parse(seen[0].opts.body).private, true);
  assert.equal(seen[0].opts.headers.authorization, 'Bearer tok');
  await assert.rejects(github.createRepo({ name: 'x', token: 'tok', fetchImpl: reply(422, {}), apiUrl: 'https://api.test' }), /already has a repo called x/);
  await assert.rejects(github.createRepo({ name: 'x', token: 'tok', fetchImpl: reply(403, {}), apiUrl: 'https://api.test' }), /HTTP 403/);
  await assert.rejects(github.createRepo({ name: 'x', token: '', fetchImpl: reply(201, {}) }), /connect GitHub first/);
  await assert.rejects(github.createRepo({ name: 'a/b', token: 'tok', fetchImpl: reply(201, {}) }), /letters, digits/);
});

test('newApp records the host and database and commits the hosting files with the template', async () => {
  const reposDir = path.join(dir, 'hosted-repos');
  fs.mkdirSync(reposDir, { recursive: true });
  const manager = new RunManager({ dir: path.join(dir, 'runs-hosted'), roots: [reposDir] });
  const { app } = await manager.newApp({ template: 'web-app', name: 'Hosted Board', answers: { audience: 'me' }, build: false, deployTarget: 'flyio', database: 'neon' });
  assert.equal(app.deployTarget, 'flyio');
  assert.equal(app.database, 'neon');
  assert.equal(app.githubRepo, null);
  const tracked = execFileSync('git', ['-C', app.repo, 'ls-files'], { encoding: 'utf8' }).split('\n');
  for (const p of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml', 'fly.toml', '.env.example', 'DEPLOY.md', 'server.js']) assert.ok(tracked.includes(p), `${p} is committed`);
  assert.equal(execFileSync('git', ['-C', app.repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('newApp refuses a bad host, a bad repo choice or a name clash before making a folder', async () => {
  const reposDir = path.join(dir, 'refuse-repos');
  fs.mkdirSync(reposDir, { recursive: true });
  const manager = new RunManager({ dir: path.join(dir, 'runs-refuse'), roots: [reposDir] });
  await assert.rejects(manager.newApp({ template: 'web-app', name: 'Bad Host', answers: { audience: 'me' }, build: false, deployTarget: 'heroku' }), /deploy target/);
  await assert.rejects(manager.newApp({ template: 'web-app', name: 'Bad Repo', answers: { audience: 'me' }, build: false, github: { mode: 'fork' } }), /local, create or existing/);
  assert.equal(fs.existsSync(path.join(reposDir, 'bad-host')), false);
  assert.equal(fs.existsSync(path.join(reposDir, 'bad-repo')), false);
});
