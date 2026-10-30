// App templates: the loader checks each template, the builder fills it in and makes a git repo, and
// the server test runs a built app's own test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-templates-')));
process.env.HARNESS_SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.HARNESS_PROFILES_FILE = path.join(dir, 'profiles.json');
process.env.HARNESS_USAGE_FILE = path.join(dir, 'usage.json');
process.env.MCP_CONFIG = path.join(dir, 'none.json');
const templates = require('../runner/templates');
const { RunManager } = require('../runner/runs');

const minimal = { id: 'demo', version: '1.0.0', name: 'Demo', description: 'A demo', questions: [{ key: 'audience', label: 'Who?', required: true }], editablePaths: ['src/**'] };
const files = (text) => [{ path: 'README.md', text }];

test('the shipped web-app template is usable and lists its questions', () => {
  const { templates: list, problems } = templates.listTemplates();
  assert.deepStrictEqual(problems, []);
  const web = list.find((t) => t.id === 'web-app');
  assert.ok(web, 'web-app is listed');
  assert.deepStrictEqual(web.questions.map((q) => q.key), ['audience']);
  assert.ok(web.editablePaths.includes('server.js'));
});

test('validate names each problem a template has', () => {
  assert.deepStrictEqual(templates.validate(minimal, files('{{name}} for {{audience}}')), []);
  const bad = { ...minimal, id: 'Bad Id', editablePaths: [], previewPort: 80, questions: [{ key: 'name', label: 'x' }] };
  const found = templates.validate(bad, files('{{missing}}'));
  assert.ok(found.some((p) => /id must be/.test(p)));
  assert.ok(found.some((p) => /editablePaths/.test(p)));
  assert.ok(found.some((p) => /previewPort/.test(p)));
  assert.ok(found.some((p) => /already filled in/.test(p)));
  assert.ok(found.some((p) => /uses \{\{missing\}\}/.test(p)));
  assert.ok(templates.validate(minimal, [{ path: '../escape.md', text: '' }]).some((p) => /inside the template/.test(p)));
});

test('a broken template is reported, not listed', () => {
  const root = path.join(dir, 'templates-broken');
  fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'broken', 'template.json'), '{ not json');
  const { templates: list, problems } = templates.listTemplates(root);
  assert.deepStrictEqual(list, []);
  assert.equal(problems[0].id, 'broken');
});

test('render cleans the answers and needs the required ones', () => {
  const t = { ...minimal, files: files('Hi {{name}} ({{slug}}) for {{audience}}: {{description}}') };
  const [out] = templates.render(t, { name: "My 'App' <b>", audience: 'me\nand you', description: 'Shows "things"' });
  assert.equal(out.text, 'Hi My App b (my-app-b) for me and you: Shows things');
  assert.throws(() => templates.render(t, { name: 'X', description: '' }), /Who\? needs an answer/);
  assert.throws(() => templates.render(t, { name: '!!!', audience: 'me' }), /letters or numbers/);
});

test('scaffold writes the folder and refuses one that already has files', () => {
  const t = { ...minimal, files: [{ path: 'src/index.js', text: '// {{name}}' }, { path: 'README.md', text: '{{audience}}' }] };
  const folder = path.join(dir, 'scaffold', 'out');
  const written = templates.scaffold(t, { name: 'Out', audience: 'me' }, folder);
  assert.deepStrictEqual(written, ['src/index.js', 'README.md']);
  assert.equal(fs.readFileSync(path.join(folder, 'src', 'index.js'), 'utf8'), '// Out');
  assert.throws(() => templates.scaffold(t, { name: 'Out', audience: 'me' }, folder), /not empty/);
});

test('newApp builds a repo from a template and registers it as an app', async () => {
  const reposDir = path.join(dir, 'repos');
  fs.mkdirSync(reposDir, { recursive: true });
  const manager = new RunManager({ dir: path.join(dir, 'runs'), roots: [reposDir] });
  const { app, run } = await manager.newApp({ template: 'web-app', name: 'Note Board', description: 'Keep notes', answers: { audience: 'the team' }, build: false });
  assert.equal(run, null);
  assert.equal(app.repo, path.join(reposDir, 'note-board'));
  assert.equal(app.name, 'Note Board');
  assert.equal(app.testCommand, 'npm test');
  assert.deepStrictEqual(app.editablePaths, ['public/**', 'server.js', 'test/**', 'README.md']);
  const log = execFileSync('git', ['-C', app.repo, 'log', '--format=%s'], { encoding: 'utf8' });
  assert.equal(log.trim(), 'Start from the Web app with an API template');
  assert.equal(execFileSync('git', ['-C', app.repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  assert.match(fs.readFileSync(path.join(app.repo, 'README.md'), 'utf8'), /Audience: the team/);
});

test('newApp refuses folders outside the allowed roots and unknown templates', async () => {
  const reposDir = path.join(dir, 'roots-check');
  fs.mkdirSync(reposDir, { recursive: true });
  const manager = new RunManager({ dir: path.join(dir, 'runs-2'), roots: [reposDir] });
  await assert.rejects(manager.newApp({ template: 'web-app', name: 'Outside', answers: { audience: 'x' }, parent: os.tmpdir(), build: false }), /not inside an allowed folder/);
  await assert.rejects(manager.newApp({ template: 'nope', name: 'X', build: false }), /no template called nope/);
  assert.equal(fs.existsSync(path.join(reposDir, 'outside')), false);
});

test('the built web app passes its own test', async () => {
  const reposDir = path.join(dir, 'repos-run');
  fs.mkdirSync(reposDir, { recursive: true });
  const manager = new RunManager({ dir: path.join(dir, 'runs-3'), roots: [reposDir] });
  const { app } = await manager.newApp({ template: 'web-app', name: 'Check Me', answers: { audience: 'me' }, build: false });
  const run = spawnSync(process.execPath, ['--test', 'test/server.test.js'], { cwd: app.repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
