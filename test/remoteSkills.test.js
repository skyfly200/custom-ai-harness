// Importing skills from a link (utils/remoteSkills.js). No network: the transport and the DNS lookup are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../utils/remoteSkills');

const PUBLIC = '93.184.216.34';
const lookup = async () => [{ address: PUBLIC, family: 4 }];
// Answers by URL: a string is a 200 text/plain body, an object is a full { status, type, text, location } answer.
function fakeWeb(pages) {
  const asked = [];
  const transport = async (u, address, headers) => {
    asked.push({ href: u.href, address: address.address, headers });
    const page = pages[u.href];
    if (page === undefined) return { status: 404 };
    if (typeof page === 'string') return { status: 200, type: 'text/plain', text: page };
    return page;
  };
  return { asked, opts: { transport, lookup } };
}
const skillText = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test('private, loopback, link-local and reserved addresses are not public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1']) {
    assert.equal(R.isPublicAddress(ip), false, ip);
  }
  assert.equal(R.isPublicAddress(PUBLIC), true);
  assert.equal(R.isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(R.isPublicAddress('not an address'), false);
});

test('only https on the standard port, with no login in the address', () => {
  assert.equal(R.httpsUrl('https://example.com/SKILL.md').hostname, 'example.com');
  assert.throws(() => R.httpsUrl('http://example.com/x.md'), /Only https/);
  assert.throws(() => R.httpsUrl('https://user:pw@example.com/x.md'), /login/);
  assert.throws(() => R.httpsUrl('https://example.com:8443/x.md'), /port/);
  assert.throws(() => R.httpsUrl('file:///etc/passwd'), /Only https/);
  assert.throws(() => R.httpsUrl('not a link'), /not a web address/);
});

test('an address that is or resolves to an internal one is refused before any request', async () => {
  const { asked, opts } = fakeWeb({});
  await assert.rejects(R.getText('https://127.0.0.1/SKILL.md', opts), /not a public web address/);
  await assert.rejects(R.getText('https://169.254.169.254/latest/meta-data', opts), /not a public web address/);
  const mixed = { ...opts, lookup: async () => [{ address: PUBLIC, family: 4 }, { address: '10.0.0.7', family: 4 }] };
  await assert.rejects(R.getText('https://example.com/SKILL.md', mixed), /not a public web address/);
  const none = { ...opts, lookup: async () => { throw new Error('ENOTFOUND'); } };
  await assert.rejects(R.getText('https://nowhere.invalid/SKILL.md', none), /not a public web address/);
  assert.deepEqual(asked, []);
});

test('the connection is made to the address that was checked', async () => {
  const { asked, opts } = fakeWeb({ 'https://example.com/SKILL.md': skillText('a', 'b', 'Do it.') });
  await R.getText('https://example.com/SKILL.md', opts);
  assert.equal(asked[0].address, PUBLIC);
});

test('a redirect is followed only to a public https address, and only a few times', async () => {
  const hop = { status: 302, location: 'https://example.com/moved.md' };
  const ok = { status: 200, type: 'text/plain', text: 'Moved.' };
  const { opts } = fakeWeb({ 'https://example.com/a.md': hop, 'https://example.com/moved.md': ok });
  assert.equal(await R.getText('https://example.com/a.md', opts), 'Moved.');

  const toInternal = fakeWeb({ 'https://example.com/a.md': { status: 302, location: 'https://10.0.0.5/secret.md' } });
  await assert.rejects(R.getText('https://example.com/a.md', toInternal.opts), /not a public web address/);
  assert.equal(toInternal.asked.length, 1, 'the internal address is never requested');

  const downgrade = fakeWeb({ 'https://example.com/a.md': { status: 302, location: 'http://example.com/a.md' } });
  await assert.rejects(R.getText('https://example.com/a.md', downgrade.opts), /Only https/);

  const loop = fakeWeb({ 'https://example.com/a.md': hop, 'https://example.com/moved.md': hop });
  await assert.rejects(R.getText('https://example.com/a.md', loop.opts), /redirected too many times/);
});

test('an HTML page, a huge file, a binary file and a missing file are refused with a reason', async () => {
  const html = fakeWeb({ 'https://example.com/a.md': { status: 200, type: 'text/html; charset=utf-8', text: '<html>' } });
  await assert.rejects(R.getText('https://example.com/a.md', html.opts), /web page, not a skill file/);
  const big = fakeWeb({ 'https://example.com/a.md': 'x'.repeat(R.MAX_BYTES + 1) });
  await assert.rejects(R.getText('https://example.com/a.md', big.opts), /larger than 200 KB/);
  const bin = fakeWeb({ 'https://example.com/a.md': 'abc\u0000def' });
  await assert.rejects(R.getText('https://example.com/a.md', bin.opts), /not a text file/);
  const gone = fakeWeb({});
  await assert.rejects(R.getText('https://example.com/a.md', gone.opts), /HTTP 404/);
});

test('a plain file becomes one skill, named from its frontmatter, with its url kept', async () => {
  const url = 'https://example.com/skills/write-tests.md';
  const { opts } = fakeWeb({ [url]: skillText('Write tests', 'Test first', 'Write the test before the code.') });
  const r = await R.fetchSkills(url, opts);
  assert.equal(r.kind, 'file');
  assert.deepEqual(r.items, [{ name: 'Write tests', description: 'Test first', body: 'Write the test before the code.', url, page: url }]);
});

test('a file without frontmatter is named from its file name; one with no instructions is refused', async () => {
  const url = 'https://example.com/quick-check.md';
  const r = await R.fetchSkills(url, fakeWeb({ [url]: 'Look twice.' }).opts);
  assert.equal(r.items[0].name, 'quick-check');
  await assert.rejects(R.fetchSkills('https://example.com/empty.md', fakeWeb({ 'https://example.com/empty.md': '---\nname: x\n---\n' }).opts), /No instructions/);
});

test('a GitHub repo gives every SKILL.md in one tree listing, each from its raw file', async () => {
  const api = 'https://api.github.com/repos/acme/skills';
  const tree = { truncated: false, tree: [
    { path: 'README.md', type: 'blob' },
    { path: 'skills/write-tests/SKILL.md', type: 'blob' },
    { path: 'skills/review/SKILL.md', type: 'blob' },
    { path: 'skills/review/examples/SKILL.md.txt', type: 'blob' },
    { path: 'other/SKILL.md', type: 'blob' },
  ] };
  const raw = 'https://raw.githubusercontent.com/acme/skills/main/skills';
  const { asked, opts } = fakeWeb({
    [api]: JSON.stringify({ default_branch: 'main' }),
    [`${api}/git/trees/main?recursive=1`]: JSON.stringify(tree),
    [`${raw}/write-tests/SKILL.md`]: skillText('write-tests', 'Tests first', 'Test first.'),
    [`${raw}/review/SKILL.md`]: 'Review carefully.',
  });
  const r = await R.fetchSkills('https://github.com/acme/skills/tree/main/skills', opts);
  assert.equal(r.kind, 'repo');
  assert.deepEqual(r.items.map((i) => [i.name, i.description, i.error || null]), [
    ['write-tests', 'Tests first', null],
    ['review', '', null],
  ]);
  assert.equal(r.items[0].url, `${raw}/write-tests/SKILL.md`);
  assert.equal(r.items[0].page, 'https://github.com/acme/skills/blob/main/skills/write-tests/SKILL.md');
  assert.deepEqual([...new Set(asked.map((a) => new URL(a.href).host))].sort(), ['api.github.com', 'raw.githubusercontent.com']);
});

test('a repo with no SKILL.md says so, and a missing repo is a 404', async () => {
  const api = 'https://api.github.com/repos/acme/empty';
  const { opts } = fakeWeb({
    [api]: JSON.stringify({ default_branch: 'main' }),
    [`${api}/git/trees/main?recursive=1`]: JSON.stringify({ tree: [{ path: 'index.js', type: 'blob' }] }),
  });
  await assert.rejects(R.fetchSkills('https://github.com/acme/empty', opts), (e) => e.status === 404 && /No SKILL.md/.test(e.message));
  await assert.rejects(R.fetchSkills('https://github.com/acme/private', fakeWeb({}).opts), (e) => e.status === 404);
});

test('a gist gives its markdown files; a file that is not a skill still shows, with its reason', async () => {
  const gist = { files: {
    'review.md': { filename: 'review.md', raw_url: 'https://gist.githubusercontent.com/u/abc123/raw/review.md' },
    'notes.txt': { filename: 'notes.txt', raw_url: 'https://gist.githubusercontent.com/u/abc123/raw/notes.txt' },
    'data.json': { filename: 'data.json', raw_url: 'https://gist.githubusercontent.com/u/abc123/raw/data.json' },
  } };
  const { opts } = fakeWeb({
    'https://api.github.com/gists/abc123': JSON.stringify(gist),
    'https://gist.githubusercontent.com/u/abc123/raw/review.md': skillText('review', 'Read the diff', 'Look for bugs.'),
    'https://gist.githubusercontent.com/u/abc123/raw/notes.txt': '---\nname: notes\n---\n',
  });
  const r = await R.fetchSkills('https://gist.github.com/u/abc123', opts);
  assert.equal(r.kind, 'gist');
  assert.deepEqual(r.items.map((i) => [i.name, i.error || 'ok']), [['review', 'ok'], ['notes', 'No instructions in it.']]);
  assert.equal(r.items[0].page, 'https://gist.github.com/abc123');
});

test('a GitHub file page is read from its raw file, and other GitHub pages are refused', async () => {
  const raw = 'https://raw.githubusercontent.com/acme/skills/main/skills/review/SKILL.md';
  const r = await R.fetchSkills('https://github.com/acme/skills/blob/main/skills/review/SKILL.md', fakeWeb({ [raw]: 'Review.' }).opts);
  assert.equal(r.items[0].url, raw);
  await assert.rejects(R.fetchSkills('https://github.com/acme/skills/issues/3', fakeWeb({}).opts), /Paste a link/);
});
