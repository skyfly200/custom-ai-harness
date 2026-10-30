const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const nav = require('../ui/nav.js');

const ui = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(ui, f), 'utf8');
const pages = ['index', 'chat', 'usage', 'usage-users', 'routing', 'agents', 'prompts', 'tools', 'settings', 'users'];

test('the bar keeps one fixed order, with Settings last', () => {
  assert.deepStrictEqual(nav.PAGES.map((p) => p.label), ['Dashboard', 'Chat', 'Agents', 'Prompts', 'Usage', 'Routing', 'Tools', 'Settings']);
  for (const p of nav.PAGES) assert.ok(nav.ICONS[p.id], `icon for ${p.id}`);
});

test('every page takes its bar from the shared script, with no copy of the links in the page', () => {
  for (const p of pages) {
    const html = read(`${p}.html`);
    assert.match(html, /<nav data-site-nav><\/nav>/, p);
    assert.match(html, /<script src="nav\.js"><\/script>/, p);
    assert.ok(html.indexOf('href="nav.css"') > html.indexOf('href="bright.css"') && html.indexOf('href="nav.css"') < html.indexOf('href="mobile.css"'), `${p}: nav.css between bright.css and mobile.css`);
    assert.doesNotMatch(html, /<nav><h1 class="brand"|<a href="settings\.html"[^>]*>Settings<\/a><\/nav>/, p);
  }
  assert.match(read('sw.js'), /'nav\.js'.*'nav\.css'|'nav\.css'.*'nav\.js'/);
});

test('the current page is marked in place, and sub-pages light their parent', () => {
  assert.strictEqual(nav.currentId('/ui/'), 'dashboard');
  assert.strictEqual(nav.currentId('/ui/index.html'), 'dashboard');
  assert.strictEqual(nav.currentId('/chat'), 'chat');
  assert.strictEqual(nav.currentId('/ui/usage-users'), 'usage');
  assert.strictEqual(nav.currentId('/'), 'dashboard');
  assert.strictEqual(nav.currentId('/ui/usage-users.html'), 'usage');
  assert.strictEqual(nav.currentId('/ui/runs.html'), 'agents');
  assert.strictEqual(nav.currentId('/ui/users.html'), 'users');
  assert.strictEqual(nav.currentId('/ui/nowhere.html'), null);
});

test('admin-only pages show to admins and on a machine with logins off', () => {
  const labels = (me) => nav.linksFor(me).map((p) => p.label);
  assert.ok(labels(null).includes('Settings'));
  assert.ok(labels({ name: 'a', role: 'admin' }).includes('Settings'));
  assert.ok(!labels({ name: 'u', role: 'user' }).includes('Settings'));
  assert.ok(!labels({ name: 'g', role: 'guest' }).includes('Settings'));
});

test('the account menu lists only what applies', () => {
  const ids = (s) => nav.accountItems(s).map((i) => i.id);
  assert.deepStrictEqual(ids({ me: null, canInstall: false }), ['bg']);
  assert.deepStrictEqual(ids({ me: null, canInstall: true }), ['bg', 'install']);
  assert.deepStrictEqual(ids({ me: { name: 'a', role: 'admin' }, canInstall: true }), ['users', 'bg', 'install', 'signout']);
  assert.match(nav.accountItems({ me: { name: 'u', role: 'user' } })[0].label, /Your password/);
});
