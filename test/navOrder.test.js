const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pages = { 'index.html': 'Dashboard', 'chat.html': 'Chat', 'usage.html': 'Usage', 'routing.html': 'Routing', 'runs.html': 'Runs', 'settings.html': 'Settings' };
const ORDER = ['Dashboard', 'Chat', 'Usage', 'Routing', 'Runs', 'Settings'];

test('every page shows the same nav links in the same order, current one marked in place', () => {
  for (const [file, name] of Object.entries(pages)) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', file), 'utf8');
    const nav = html.match(/<nav>.*?<\/nav>/s)[0];
    const links = [...nav.matchAll(/<a ([^>]*)>([^<]+)<\/a>/g)];
    assert.deepStrictEqual(links.map((m) => m[2]), ORDER, file);
    const here = links.filter((m) => /class="here"/.test(m[1]));
    assert.deepStrictEqual(here.map((m) => m[2]), [name], file);
  }
});
