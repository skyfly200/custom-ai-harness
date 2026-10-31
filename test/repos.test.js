// The repo list on a chat, project or agent (ui/repos.js): old single-repo data still reads, the first repo is the default
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../ui/repos');
const { withRepoArg } = require('../utils/repoArg');
const githubApi = require('../utils/githubApi');
const repoTools = require('../utils/repoTools');

const gh = (full, extra = {}) => ({ kind: 'github', full, ...extra });
const dir = (path, name) => ({ kind: 'local', path, ...(name ? { name } : {}) });

test('a chat saved with one repo reads as a list (GitHub first, then the folder)', () => {
  const old = { github: { full: 'a/b', branch: 'main', private: true }, repo: { path: '/code/x', name: 'x' } };
  assert.deepEqual(R.list(old), [gh('a/b', { branch: 'main', private: true }), dir('/code/x', 'x')]);
  assert.deepEqual(R.list({ repo: { path: '/code/y' } }), [dir('/code/y', 'y')]);
  assert.deepEqual(R.list({}), []);
  assert.deepEqual(R.list(null), []);
});

test('set() stores the list and mirrors the first of each kind into the old fields', () => {
  const chat = {};
  R.set(chat, [dir('/code/x', 'x'), gh('a/b'), gh('c/d'), dir('/code/z', 'z')]);
  assert.equal(chat.repos.length, 4);
  assert.equal(chat.github.full, 'a/b');
  assert.equal(chat.repo.path, '/code/x');
  assert.equal(chat.repo.kind, undefined);
  // an older page that only knows chat.github / chat.repo still sees the defaults
  assert.deepEqual(R.list({ github: chat.github, repo: chat.repo }).map(R.labelOf), ['a/b', 'x']);
  R.set(chat, []);
  assert.deepEqual(Object.keys(chat), []);
});

test('set() drops repeats and empty entries', () => {
  const chat = {};
  R.set(chat, [gh('a/b'), gh('A/B'), null, { kind: 'github', full: '' }, dir('/x', 'x'), dir('/x', 'x')]);
  assert.deepEqual(chat.repos.map(R.labelOf), ['a/b', 'x']);
});

test('a chat uses its own repos, else its project’s', () => {
  const project = { repos: [gh('p/one'), gh('p/two')] };
  assert.deepEqual(R.effective({}, project).map(R.labelOf), ['p/one', 'p/two']);
  assert.deepEqual(R.effective({ repos: [gh('c/mine')] }, project).map(R.labelOf), ['c/mine']);
  assert.equal(R.isOwn({}), false);
  assert.equal(R.isOwn({ github: { full: 'a/b' } }), true);
  // an old project with just a folder
  assert.deepEqual(R.effective({}, { repo: { path: '/p', name: 'p' } }).map(R.labelOf), ['p']);
});

test('the first repo is the default, per kind or overall', () => {
  const list = [dir('/a', 'a'), gh('x/y'), gh('x/z')];
  assert.equal(R.defaultOf(list).path, '/a');
  assert.equal(R.defaultOf(list, 'github').full, 'x/y');
  assert.equal(R.defaultOf([], 'local'), null);
});

test('add, remove, make default and move', () => {
  let l = R.add([], gh('a/b'));
  l = R.add(l, gh('A/B'));
  l = R.add(l, gh('c/d'));
  l = R.add(l, dir('/x', 'x'));
  assert.deepEqual(l.map(R.labelOf), ['a/b', 'c/d', 'x']);
  assert.deepEqual(R.makeDefault(l, R.keyOf(l[2])).map(R.labelOf), ['x', 'a/b', 'c/d']);
  assert.deepEqual(R.move(l, R.keyOf(l[1]), -1).map(R.labelOf), ['c/d', 'a/b', 'x']);
  assert.deepEqual(R.move(l, R.keyOf(l[0]), -1).map(R.labelOf), ['a/b', 'c/d', 'x']);
  assert.deepEqual(R.remove(l, R.keyOf(l[0])).map(R.labelOf), ['c/d', 'x']);
});

test('find() takes the default when no name is given, and matches full or short names', () => {
  const l = [gh('skyfly200/app'), gh('skyfly200/docs'), dir('/code/tools', 'tools')];
  assert.equal(R.find(l, '', 'github').repo.full, 'skyfly200/app');
  assert.equal(R.find(l, undefined, 'local').repo.name, 'tools');
  assert.equal(R.find(l, 'SkyFly200/Docs', 'github').repo.full, 'skyfly200/docs');
  assert.equal(R.find(l, 'docs', 'github').repo.full, 'skyfly200/docs');
  assert.equal(R.find(l, 'tools', 'local').repo.path, '/code/tools');
  assert.equal(R.find(l, '\\code\\tools'.replace(/\\/g, '/'), 'local').repo.path, '/code/tools');
  assert.match(R.find(l, 'other/thing', 'github').error, /not attached.*skyfly200\/app, skyfly200\/docs/);
  const twice = [gh('a/app'), gh('b/app')];
  assert.match(R.find(twice, 'app', 'github').error, /matches a\/app and b\/app/);
  assert.equal(R.find(twice, 'b/app', 'github').repo.full, 'b/app');
  assert.equal(R.find([], '', 'github').repo, null);
});

test('agents keep specs; fromSpecs tells GitHub repos from folders', () => {
  const l = R.fromSpecs(['skyfly200/app', '/home/me/code/app', 'C:\\code\\app', 'c:/code/app', '']);
  assert.deepEqual(l.map((e) => e.kind), ['github', 'local', 'local', 'local']);
  assert.deepEqual(R.toSpecs(l), ['skyfly200/app', '/home/me/code/app', 'C:\\code\\app', 'c:/code/app']);
});

test('the prompt names every repo and marks the default; one repo needs no extra text', () => {
  assert.equal(R.promptText([gh('a/b')]), '');
  const text = R.promptText([gh('a/b', { branch: 'main' }), dir('/code/x', 'x'), gh('c/d', { private: true })]);
  assert.match(text, /3 repositories/);
  assert.match(text, /- a\/b \(default branch main\): GitHub[^\n]*\[DEFAULT\]/);
  assert.match(text, /- x at \/code\/x: git folder/);
  assert.match(text, /only when the user asks or names them/);
  // on a hosted server folders are not usable, so they are not listed
  assert.equal(R.promptText([gh('a/b'), dir('/code/x', 'x')], { folders: false }), '');
});

test('chips mark the default and escape names; controls are optional', () => {
  const esc = (s) => String(s).replace(/</g, '&lt;');
  const html = R.chipsHtml([gh('a/b'), dir('/c/<x>', '<x>')], { controls: true, esc });
  assert.match(html, /repo-chip default/);
  assert.equal((html.match(/class="repo-default"/g) || []).length, 1);
  assert.doesNotMatch(html, /<x>/);
  assert.match(html, /data-repo-act="default"/);
  assert.equal(R.chipsHtml([gh('a/b')], { esc }).includes('data-repo-act'), false);
  assert.equal(R.chipsHtml([]), '');
});

test('every repo tool takes an optional repo argument', () => {
  for (const defs of [githubApi.definitions(), repoTools.definitions()]) {
    for (const d of defs) {
      const p = d.function.parameters;
      assert.equal(p.properties.repo.type, 'string', d.function.name);
      assert.ok(!p.required.includes('repo'), d.function.name);
    }
  }
  const one = withRepoArg([{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }], 'thing');
  assert.deepEqual(Object.keys(one[0].function.parameters.properties), ['q', 'repo']);
  assert.deepEqual(one[0].function.parameters.required, ['q']);
});

test('after a sync conflict folders stay as they are here and GitHub repos follow the newer copy', () => {
  const mine = [dir('/x', 'x'), gh('a/b')];
  assert.equal(R.mergeKeepingFolders(mine, [gh('a/b')]), mine);
  assert.deepEqual(R.mergeKeepingFolders(mine, [gh('a/b'), gh('c/d')]).map(R.labelOf), ['a/b', 'c/d', 'x']);
  assert.deepEqual(R.mergeKeepingFolders(mine, []).map(R.labelOf), ['x']);
});

test('the chat page picks the repo a tool call names, else the default, and refuses one that is not attached', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');
  const a = source.indexOf('const reposOf =');
  const b = source.indexOf('// Skills on for this chat', a);
  assert.ok(a > 0 && b > a);
  const project = { id: 'p', repos: [gh('p/inherited')] };
  const ctx = { Repos: R, projectOf: (c) => (c.project ? project : null), hostedNoFolders: () => ctx.hosted, hosted: false };
  vm.createContext(ctx);
  vm.runInContext(`${source.slice(a, b)}\nthis.reposOf = reposOf; this.repoOf = repoOf; this.ghOf = ghOf; this.repoFor = repoFor;`, ctx);
  const chat = { repos: [dir('/code/tools', 'tools'), gh('me/app'), gh('me/docs')] };
  assert.equal(ctx.ghOf(chat).full, 'me/app', 'the first GitHub repo is the default');
  assert.equal(ctx.repoOf(chat).path, '/code/tools');
  assert.equal(ctx.repoFor(chat, 'github_read_file', {}).repo.full, 'me/app');
  assert.equal(ctx.repoFor(chat, 'github_read_file', { repo: 'docs' }).repo.full, 'me/docs');
  assert.equal(ctx.repoFor(chat, 'repo_read_file', { repo: 'tools' }).repo.path, '/code/tools');
  assert.equal(ctx.repoFor(chat, 'run_command', {}).repo.name, 'tools');
  assert.match(ctx.repoFor(chat, 'github_search', { repo: 'someone/else' }).error, /not attached/);
  // a chat with none of its own uses its project's, and an old single-repo chat still works
  assert.equal(ctx.ghOf({ project: 'p' }).full, 'p/inherited');
  assert.equal(ctx.ghOf({ github: { full: 'old/one' }, project: 'p' }).full, 'old/one');
  // a hosted server cannot read folders, so they are not offered
  ctx.hosted = true;
  assert.equal(ctx.repoOf(chat), null);
  assert.deepEqual(ctx.reposOf(chat).map(R.labelOf), ['me/app', 'me/docs']);
});

test('githubUrl links owner/name to github.com and nothing else', () => {
  assert.equal(R.githubUrl('skyfly200/custom-ai-harness'), 'https://github.com/skyfly200/custom-ai-harness');
  assert.equal(R.githubUrl(' a.b/c_d '), 'https://github.com/a.b/c_d');
  assert.equal(R.githubUrl('/code/x'), '');
  assert.equal(R.githubUrl('a/b/c'), '');
  assert.equal(R.githubUrl(''), '');
});

test('filterGithub matches every word, ignores case and skips repos already attached', () => {
  const repos = [{ full: 'Acme/Web-App' }, { full: 'acme/api', private: true }, { full: 'me/notes' }];
  assert.deepEqual(R.filterGithub(repos, 'ACME').map((r) => r.full), ['Acme/Web-App', 'acme/api']);
  assert.deepEqual(R.filterGithub(repos, 'acme  api').map((r) => r.full), ['acme/api']);
  assert.deepEqual(R.filterGithub(repos, '', [gh('acme/api')]).map((r) => r.full), ['Acme/Web-App', 'me/notes']);
  assert.deepEqual(R.filterGithub(null, 'x'), []);
});

test('chipsHtml links GitHub names only when asked, and leaves folders as text', () => {
  const entries = [gh('a/b'), dir('/code/x', 'x')];
  const plain = R.chipsHtml(entries, {});
  assert.doesNotMatch(plain, /href=/);
  const linked = R.chipsHtml(entries, { links: true, esc: (s) => String(s) });
  assert.match(linked, /<a href="https:\/\/github\.com\/a\/b" target="_blank" rel="noopener"[^>]*>a\/b<\/a>/);
  assert.doesNotMatch(linked, /href="[^"]*x"/);
});
