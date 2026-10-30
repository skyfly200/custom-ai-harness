// Headroom's MCP server in agent runs (runner/headroom.js, runner/tools.js). The tool-side tests use a fake
// Headroom, so they run anywhere. The server tests run the real `headroom mcp serve` when it is installed
// (HEADROOM_COMMAND, or the repo's .venv, or PATH) and are skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Headroom, headroomCommand } = require('../runner/headroom');
const { makeTools } = require('../runner/tools');

const LONG = Array.from({ length: 900 }, (_, i) => (i % 97
    ? `2026-10-30 INFO worker processed item ${i} ok`
    : `2026-10-30 ERROR FATAL item ${i} failed: timeout`)).join('\n');

// A stand-in for the Headroom wrapper: shortens anything over 1,000 characters and keeps the original by hash
function fakeHeadroom() {
    const store = new Map();
    return {
        error: null,
        store,
        async compress(text) {
            if (text.length < 1000) return null;
            const hash = `h${store.size + 1}`;
            store.set(hash, text);
            const compressed = `${text.slice(0, 200)}\n[... cut; Retrieve more: hash=${hash}]`;
            return { text: compressed, hash, originalTokens: text.length / 4, compressedTokens: compressed.length / 4, saved: (text.length - compressed.length) / 4 };
        },
        async retrieve(hash) {
            if (!store.has(hash)) throw new Error(`no output with hash ${hash}`);
            return store.get(hash);
        },
    };
}

// A sandbox that answers run_command with a fixed output and read_file with a fixed file
function fakeSandbox(output, file = output) {
    return {
        resolve: async (p) => p,
        readFile: async () => file,
        writeFile: async () => {},
        listDir: async () => ['a.txt'],
        exec: async () => ({ output, code: 0, timedOut: false, ms: 5 }),
    };
}
const guard = { check: async () => ({ decision: 'allow' }), approve: async () => true };

test('a long command output is shortened, counted, and kept for headroom_retrieve', async () => {
    const hr = fakeHeadroom();
    const seen = [];
    const tools = makeTools({ sandbox: fakeSandbox(LONG), ...guard, headroom: hr, onCompress: (c) => seen.push(c) });
    const out = await tools.call('run_command', { command: 'npm test' });
    assert.match(out.text, /hash=h1/);
    assert.ok(out.text.length < LONG.length);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].saved > 0);
    const back = await tools.call('headroom_retrieve', { hash: 'h1' });
    // the original is the whole output, status line included; a retrieve is cut at 24,000 characters like a read
    assert.ok(back.text.startsWith(`exit code 0\n${LONG.slice(0, 5000)}`));
    assert.match(back.text, /cut at 24000 characters/);
});

test('short outputs and outputs Headroom cannot shorten are returned whole', async () => {
    const hr = fakeHeadroom();
    const seen = [];
    const short = await makeTools({ sandbox: fakeSandbox('ok'), ...guard, headroom: hr, onCompress: (c) => seen.push(c) }).call('run_command', { command: 'true' });
    assert.equal(short.text, 'exit code 0\nok');
    const noGain = { compress: async () => null, retrieve: async () => '' };
    const whole = await makeTools({ sandbox: fakeSandbox(LONG), ...guard, headroom: noGain, onCompress: (c) => seen.push(c) }).call('run_command', { command: 'x' });
    assert.match(whole.text, /^exit code 0\n/);
    assert.ok(whole.text.includes(LONG));
    assert.equal(seen.length, 0);
});

test('headroom_retrieve is offered once Headroom has shortened an output, and not in the no-tools stage', async () => {
    const names = (tools) => tools.definitions.map((d) => d.function.name);
    const on = makeTools({ sandbox: fakeSandbox(LONG), ...guard, headroom: fakeHeadroom() });
    assert.ok(!names(on).includes('headroom_retrieve'), 'nothing to fetch back yet');
    await on.call('run_command', { command: 'npm test' });
    assert.ok(names(on).includes('headroom_retrieve'));
    const check = makeTools({ sandbox: fakeSandbox(LONG), ...guard, headroom: fakeHeadroom(), toolset: 'check' });
    await check.call('run_command', { command: 'npm test' });
    assert.ok(names(check).includes('headroom_retrieve'));
    const none = makeTools({ sandbox: fakeSandbox(LONG), ...guard, headroom: fakeHeadroom(), toolset: 'none' });
    await none.call('finish', { summary: 'x' });
    assert.deepEqual(names(none), ['finish']);
    assert.ok(!names(makeTools({ sandbox: fakeSandbox(LONG), ...guard })).includes('headroom_retrieve'), 'no Headroom, no tool');
});

test('a retrieve that fails is an error the model can read, not a crash', async () => {
    const tools = makeTools({ sandbox: fakeSandbox(''), ...guard, headroom: fakeHeadroom() });
    const out = await tools.call('headroom_retrieve', { hash: 'nope' });
    assert.match(out.text, /^Error: no output with hash nope/);
});

test('a missing Headroom install fails open with the reason, and does not retry at once', async () => {
    const h = new Headroom({ command: '/nonexistent/headroom-for-test' });
    const text = 'x'.repeat(5000);
    assert.equal(await h.compress(text), null);
    assert.match(h.error, /Install it in the repo's \.venv: pip install "headroom-ai\[mcp\]"/);
    const again = h.start();
    assert.equal(await again, false);
    await h.close();
});

test('short text never starts the server', async () => {
    const h = new Headroom({ command: '/nonexistent/headroom-for-test' });
    assert.equal(await h.compress('short'), null);
    assert.equal(h.ready, null);
    assert.equal(h.error, null);
});

const haveHeadroom = spawnSync(headroomCommand(), ['--version'], { encoding: 'utf8' }).status === 0;
test('the real Headroom server shortens a long log and gives the original back', { skip: !haveHeadroom && 'headroom-ai is not installed (pip install "headroom-ai[mcp]" in .venv)' }, async () => {
    const h = new Headroom();
    try {
        const out = await h.compress(LONG);
        assert.ok(out, `expected a compressed copy, got error: ${h.error}`);
        assert.ok(out.saved > 0);
        assert.ok(out.text.length < LONG.length);
        assert.equal(await h.retrieve(out.hash), LONG);
    } finally {
        await h.close();
    }
});
