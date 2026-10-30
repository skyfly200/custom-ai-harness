// Import an existing app: what the detection reads from a folder, and registering a local git folder (or refusing it)
// through the run manager, with existing files left alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-import-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const { detectStack } = require('../runner/importDetect');
const { RunManager } = require('../runner/runs');

const pkg = (scripts = {}, deps = {}) => JSON.stringify({ name: '@acme/notes', scripts, dependencies: deps });

test('a Node app with a test script and a Fly config is read as Node on Fly.io', () => {
  const found = detectStack({
    'package.json': pkg({ test: 'node --test', dev: 'vite' }, { react: '18', vite: '5' }),
    'package-lock.json': '',
    'fly.toml': 'app = "notes"\n[http_service]\n  internal_port = 8080\n',
    'src/': null,
    'public/': null,
  });
  assert.deepStrictEqual(found.stack, ['Node.js', 'Vite', 'React']);
  assert.equal(found.deployTarget, 'flyio');
  assert.equal(found.installCommand, 'npm ci');
  assert.equal(found.testCommand, 'npm test');
  assert.equal(found.devCommand, 'npm run dev');
  assert.equal(found.previewPort, 8080);
  assert.deepStrictEqual(found.editablePaths, ['src/**', 'public/**']);
  assert.equal(found.suggestedName, 'notes', 'the npm scope is dropped from the name');
});

test('the npm placeholder test script is not a test command, and the lock file picks the installer', () => {
  const found = detectStack({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }), 'yarn.lock': '' });
  assert.equal(found.testCommand, null);
  assert.equal(found.installCommand, 'yarn install');
  assert.ok(found.notes.some((n) => /No test script/.test(n)));
  assert.deepStrictEqual(found.editablePaths, ['src/**'], 'with no source folders the default is src/**');
});

test('database hints: Supabase wins, then any Postgres suggests Neon', () => {
  assert.equal(detectStack({ 'package.json': pkg({}, { '@supabase/supabase-js': '2' }) }).database, 'supabase');
  assert.equal(detectStack({ 'package.json': pkg({}, { pg: '8' }) }).database, 'neon');
  assert.equal(detectStack({ 'package.json': pkg(), '.env.example': 'DATABASE_URL=postgres://u@ep.neon.tech/db\n' }).database, 'neon');
  assert.equal(detectStack({ 'package.json': pkg() }).database, 'none');
});

test('Vercel and Netlify configs, a Dockerfile, and a Python app', () => {
  assert.equal(detectStack({ 'package.json': pkg(), 'vercel.json': '{}' }).deployTarget, 'vercel');
  assert.equal(detectStack({ 'index.html': '<!doctype html>', 'netlify.toml': '' }).deployTarget, 'netlify');
  const docker = detectStack({ 'package.json': pkg(), Dockerfile: 'FROM node' });
  assert.equal(docker.deployTarget, 'flyio', 'a Dockerfile suggests Fly.io, which builds it');
  assert.ok(docker.stack.includes('Docker'));
  const py = detectStack({ 'requirements.txt': 'flask\n' });
  assert.deepStrictEqual(py.stack, ['Python']);
  assert.equal(py.installCommand, 'pip install -r requirements.txt');
});

test('a folder with several host configs notes the clash and takes the first', () => {
  const found = detectStack({ 'package.json': pkg(), 'fly.toml': '', 'netlify.toml': '' });
  assert.equal(found.deployTarget, 'flyio');
  assert.ok(found.notes.some((n) => /Several host configs/.test(n)));
});

function gitFolder(name, files) {
  const folder = path.join(dir, 'repos', name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, p)), { recursive: true });
    fs.writeFileSync(path.join(folder, p), text);
  }
  execFileSync('git', ['-C', folder, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=t@test', 'add', '-A']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=t@test', 'commit', '-q', '-m', 'Existing app']);
  return folder;
}

const status = (folder) => execFileSync('git', ['-C', folder, 'status', '--porcelain'], { encoding: 'utf8' });

test('importing a local git folder registers it with the detected choices and keeps existing files', async () => {
  const roots = [path.join(dir, 'repos')];
  const folder = gitFolder('notes-app', {
    'package.json': pkg({ test: 'node --test' }, { pg: '8' }),
    'package-lock.json': '{}',
    'src/index.js': 'console.log(1)\n',
    'fly.toml': 'app = "notes"\n[http_service]\n  internal_port = 8080\n',
    'DEPLOY.md': 'My own deploy notes\n',
  });
  const manager = new RunManager({ dir: path.join(dir, 'runs-import'), roots });

  const before = await manager.detectImport({ source: 'local', folder });
  assert.equal(before.deployTarget, 'flyio');
  assert.equal(status(folder), '', 'detecting changes nothing');

  const { app, detection, added, skipped } = await manager.importApp({ source: 'local', folder });
  assert.equal(app.repo, fs.realpathSync(folder));
  assert.equal(app.name, 'notes', 'the name comes from package.json');
  assert.equal(app.deployTarget, 'flyio');
  assert.equal(app.database, 'neon');
  assert.equal(app.testCommand, 'npm test');
  assert.equal(app.installCommand, 'npm ci');
  assert.equal(app.previewPort, 8080);
  assert.deepStrictEqual(app.editablePaths, ['src/**']);
  assert.equal(detection.stack.includes('Node.js'), true);
  assert.deepStrictEqual(skipped, ['fly.toml', 'DEPLOY.md'], 'files the repo already has are not overwritten');
  assert.ok(added.includes('.github/workflows/ci.yml') && added.includes('.github/workflows/deploy.yml') && added.includes('.env.example'));
  assert.equal(fs.readFileSync(path.join(folder, 'DEPLOY.md'), 'utf8'), 'My own deploy notes\n');
  assert.match(status(folder), /\?\? \.github\//, 'the new files are left for the person to review and commit');
});

test('the person can override what was detected, and a folder can opt out of the added files', async () => {
  const roots = [path.join(dir, 'repos')];
  const folder = gitFolder('plain-site', { 'index.html': '<!doctype html>', 'css/site.css': 'body{}' });
  const manager = new RunManager({ dir: path.join(dir, 'runs-override'), roots });
  const { app, added } = await manager.importApp({ source: 'local', folder, name: 'Plain Site', deployTarget: 'netlify', editablePaths: ['css/**'], addFiles: false });
  assert.equal(app.name, 'Plain Site');
  assert.equal(app.deployTarget, 'netlify');
  assert.deepStrictEqual(app.editablePaths, ['css/**']);
  assert.deepStrictEqual(added, []);
  assert.equal(status(folder), '');
});

test('importing refuses a folder outside the roots, a plain folder, a repeat, and a bad host before writing', async () => {
  const roots = [path.join(dir, 'repos')];
  const manager = new RunManager({ dir: path.join(dir, 'runs-refuse-import'), roots });
  const outside = gitFolder('../outside-app', { 'package.json': pkg() });
  await assert.rejects(manager.importApp({ source: 'local', folder: outside }), /not inside an allowed folder/);
  const plain = path.join(dir, 'repos', 'plain-folder');
  fs.mkdirSync(plain, { recursive: true });
  await assert.rejects(manager.importApp({ source: 'local', folder: plain }), /not a git repo/);
  await assert.rejects(manager.importApp({ source: 'local', folder: path.join(dir, 'repos', 'missing') }), /does not exist/);
  await assert.rejects(manager.importApp({ source: 'copy', folder: plain }), /local or github/);

  const folder = gitFolder('once-app', { 'package.json': pkg() });
  await manager.importApp({ source: 'local', folder, deployTarget: 'vercel' });
  await assert.rejects(manager.importApp({ source: 'local', folder }), /already an app/);
  const bad = gitFolder('bad-host-app', { 'package.json': pkg() });
  await assert.rejects(manager.importApp({ source: 'local', folder: bad, deployTarget: 'heroku' }), /deploy target must be one of/);
  assert.equal(fs.existsSync(path.join(bad, '.github')), false, 'nothing is written when the choices are refused');
});
