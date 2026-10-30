// The run page's and run list's pull request state: which icon and label a PR shows, and that the run page offers
// Fix conflicts only when GitHub says the PR cannot merge.
const test = require('node:test');
const assert = require('node:assert/strict');
const PrState = require('../ui/prstate');
const RunView = require('../ui/runview');

test('an open PR with merge conflicts shows the conflict label, not open', () => {
    const v = PrState.view({ status: 'open', conflict: true, checks: 'failing', number: 3 });
    assert.equal(v.key, 'conflict');
    assert.equal(v.label, 'Merge conflicts');
    assert.equal(v.checks, 'checks fail');
});

test('a clean PR, a draft, a merged or closed PR each have their own state', () => {
    assert.equal(PrState.view({ status: 'open', conflict: false, checks: 'passing' }).label, 'Open');
    assert.equal(PrState.view({ status: 'draft', conflict: null }).label, 'Draft');
    assert.equal(PrState.view({ status: 'merged' }).tone, 'merged');
    assert.equal(PrState.view({ status: 'closed', conflict: true }).key, 'closed', 'a closed PR is not a conflict');
    assert.equal(PrState.view(null), null);
});

test('the chip escapes its text and shows nothing without a state', () => {
    assert.equal(PrState.chip(null), '');
    const html = PrState.chip({ status: 'unknown', error: '<b>x</b>', number: 1 });
    assert.ok(!html.includes('<b>'));
    assert.match(html, /prst-unknown/);
});

test('the run page offers Fix conflicts only for a PR with conflicts, and always checks and toggles auto-fix', () => {
    const conflicted = { id: 'r1', kind: 'run', status: 'done', prTarget: { owner: 'o', name: 'n', number: 7 }, result: { commit: 'c' }, prState: { status: 'open', conflict: true } };
    const acts = RunView.actionsFor(conflicted, {}).map((a) => a.act);
    assert.ok(acts.includes('fix-conflicts'));
    assert.ok(acts.includes('pr-check'));
    assert.ok(acts.includes('auto-fix'));
    const clean = { ...conflicted, prState: { status: 'open', conflict: false } };
    assert.ok(!RunView.actionsFor(clean, {}).some((a) => a.act === 'fix-conflicts'));
    const merged = { ...conflicted, prState: { status: 'merged', conflict: true } };
    assert.ok(!RunView.actionsFor(merged, {}).some((a) => a.act === 'fix-conflicts'));
    const off = RunView.actionsFor({ ...conflicted, autoFixConflicts: true }, {}).find((a) => a.act === 'auto-fix');
    assert.equal(off.label, 'Turn off auto-fix');
});
