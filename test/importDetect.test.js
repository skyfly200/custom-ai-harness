// Host and database detection on fixture repos under test/fixtures/import. Each fixture is read from disk the way an
// import reads a folder, and the ranking, evidence and notes are checked. detectStack is used rather than detectFolder
// so the git origin of the surrounding harness repo is never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { detectStack, readEntries } = require('../runner/importDetect');

const fixture = (name) => detectStack(readEntries(path.join(__dirname, 'fixtures', 'import', name)));
const labels = (list) => list.map((c) => c.id);

test('a Next.js app with a Vercel homepage, deploy button and workflow is read as Vercel, with the evidence', () => {
  const found = fixture('vercel-next');
  assert.equal(found.deployTarget, 'vercel');
  assert.ok(found.stack.includes('Next.js'));
  const evidence = found.hostCandidates[0].evidence.join(' | ');
  assert.match(evidence, /homepage is shop-acme\.vercel\.app/);
  assert.match(evidence, /Vercel deploy button/);
  assert.match(evidence, /deploy\.yml uses Vercel/);
  assert.match(evidence, /Next\.js/);
  assert.ok(found.notes[0].startsWith('Vercel is suggested: '));
  assert.equal(found.database, 'none');
});

test('a static site with netlify.toml, a _redirects file and a netlify.app link is read as Netlify', () => {
  const found = fixture('netlify-static');
  assert.equal(found.deployTarget, 'netlify');
  assert.deepStrictEqual(labels(found.hostCandidates), ['netlify'], 'no other host is suggested');
  assert.equal(found.hostCandidates[0].score, 5 + 3 + 2);
  assert.match(found.hostCandidates[0].evidence.join(' | '), /_redirects or _headers/);
});

test('when Vercel and Netlify both have config, the one with more evidence is ranked first and the other is listed', () => {
  const found = fixture('netlify-vs-vercel');
  assert.deepStrictEqual(labels(found.hostCandidates), ['netlify', 'vercel']);
  assert.equal(found.deployTarget, 'netlify');
  assert.equal(found.hostCandidates[0].score, 13, 'netlify.toml, the .netlify folder and a workflow');
  assert.equal(found.hostCandidates[1].score, 7, 'vercel.json and the vercel package');
  assert.ok(found.notes.some((n) => /Several host configs found \(Netlify, Vercel\)/.test(n)));
});

test('a Supabase app: its evidence wins the database, and Fly.io comes from fly.toml', () => {
  const found = fixture('supabase-app');
  assert.equal(found.database, 'supabase');
  assert.deepStrictEqual(labels(found.databaseCandidates), ['supabase']);
  assert.match(found.databaseCandidates[0].evidence.join(' | '), /supabase host/);
  assert.equal(found.deployTarget, 'flyio');
  assert.equal(found.previewPort, 3000);
});

test('a Prisma app whose .env.example points at Neon is read as Neon on Fly.io', () => {
  const found = fixture('neon-prisma');
  assert.equal(found.database, 'neon');
  assert.match(found.databaseCandidates[0].evidence.join(' | '), /neon\.tech/);
  assert.match(found.databaseCandidates[0].evidence.join(' | '), /PostgreSQL/);
  assert.equal(found.deployTarget, 'flyio');
});

test('secrets files are never read, and a workflow that is not a deploy adds nothing', () => {
  const entries = readEntries(path.join(__dirname, 'fixtures', 'import', 'neon-prisma'));
  assert.equal(Object.keys(entries).some((k) => /(^|\/)\.env$/.test(k)), false);
  const plain = detectStack({ 'package.json': '{}', '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n' });
  assert.equal(plain.deployTarget, 'none');
  assert.deepStrictEqual(plain.hostCandidates, []);
});
