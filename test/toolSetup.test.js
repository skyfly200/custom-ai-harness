// The Tools page's setup wizard: what a catalog entry needs, the entry the answers make, next steps for failures
const test = require('node:test');
const assert = require('node:assert/strict');
const TS = require('../ui/toolsetup');
const catalog = require('../utils/mcpCatalog');
const { buildSpec } = require('../utils/mcpAdmin');

const item = (id) => catalog.find((c) => c.id === id);

test('programs a program-type entry needs are checked, web addresses need none', () => {
    assert.deepEqual(TS.requiredPrograms(item('filesystem')), ['npx']);
    assert.deepEqual(TS.requiredPrograms(item('fetch')), ['uvx']);
    assert.deepEqual(TS.requiredPrograms(item('github')), []);
    const checks = TS.checkPrograms(item('fetch'), { uvx: { found: false, hint: 'install uv' } });
    assert.deepEqual(checks, [{ name: 'uvx', found: false, hint: 'install uv' }]);
    assert.equal(TS.blocked(checks).length, 1);
    assert.equal(TS.blocked(TS.checkPrograms(item('fetch'), { uvx: { found: true } })).length, 0);
    assert.equal(TS.checkPrograms(item('fetch'), {})[0].found, null, 'unknown is not blocking');
});

test('answers land in the argument, env variable or header the entry says', () => {
    const fs = TS.buildEntry(item('filesystem'), { folder: ' /data/docs ' });
    assert.deepEqual(fs.args, ['-y', '@modelcontextprotocol/server-filesystem', '/data/docs']);
    const gh = TS.buildEntry(item('github'), { token: 'ghp_x' });
    assert.deepEqual(gh.headers, [{ key: 'Authorization', value: 'Bearer ghp_x' }]);
    const brave = TS.buildEntry(item('brave-search'), { key: 'BSA1' });
    assert.deepEqual(brave.env, [{ key: 'BRAVE_API_KEY', value: 'BSA1' }]);
    const wolfram = TS.buildEntry(item('wolfram'), { appid: 'W1' });
    assert.deepEqual(wolfram.env, [{ key: 'WOLFRAM_APP_ID', value: 'W1' }]);
    // an empty answer leaves the catalog's own default
    assert.equal(TS.buildEntry(item('filesystem'), { folder: '' }).args[2], '${HOME}/Documents');
    assert.deepEqual(item('filesystem').spec.args[2], '${HOME}/Documents', 'the catalog itself is not changed');
});

test('missing answers are listed and pasted keys are cleaned', () => {
    assert.deepEqual(TS.missingInputs(item('github'), { token: '  ' }).map((i) => i.id), ['token']);
    assert.deepEqual(TS.missingInputs(item('github'), { token: 'x' }), []);
    assert.equal(TS.cleanSecret('  "Bearer abc123" ', 'Bearer '), 'abc123');
    assert.equal(TS.cleanSecret(' abc ', 'Bearer '), 'abc');
});

test('every wizard input points at a real place and every entry passes the server checks', () => {
    for (const c of catalog) {
        for (const i of c.inputs || []) {
            assert.ok(['folder', 'secret', 'text'].includes(i.kind), `${c.id}.${i.id} kind`);
            if (i.into.arg !== undefined) assert.ok(c.spec.args && c.spec.args.length > i.into.arg, `${c.id}.${i.id} arg index`);
            if (i.kind === 'secret') assert.ok(i.get && i.get.url.startsWith('https://') && i.get.steps.length, `${c.id}.${i.id} says where to get it`);
        }
        const filled = Object.fromEntries((c.inputs || []).map((i) => [i.id, 'value']));
        buildSpec({ ...TS.buildEntry(c, filled), type: c.spec.type });
    }
    // everything that is not one-click asks for something, so the guide has something to say
    for (const c of catalog.filter((x) => !x.ready)) assert.ok((c.inputs || []).length, `${c.id} has inputs`);
});

test('a failed test gets a plain next step', () => {
    assert.match(TS.nextStep('https://x refused the login (HTTP 401)', item('github')), /key was refused/);
    assert.match(TS.nextStep('could not start "uvx": not found on PATH', item('fetch')), /not installed/);
    assert.match(TS.nextStep('did not answer within 90 s', item('fetch')), /download/);
    assert.equal(TS.nextStep('weird', item('fetch')), '');
});
