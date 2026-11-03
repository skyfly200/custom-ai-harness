// The admin's issued-key limit and expiry: validated, saved, and handed to utils/openrouterKeys.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-keys-')), 'harness-settings.json');
process.env.HARNESS_SETTINGS_FILE = FILE;
const settings = require('../utils/settings');
const keys = require('../utils/openrouterKeys');

test('defaults are $10 and 30 days', () => {
    assert.equal(settings.DEFAULTS.keyLimitUsd, 10);
    assert.equal(settings.DEFAULTS.keyDays, 30);
});

test('saving changes what issued keys get, and it survives a reload', () => {
    settings.update({ keyLimitUsd: 15, keyDays: 60 });
    assert.equal(keys.limitUsd({}), 15);
    assert.equal(keys.lifetimeDays({}), 60);
    settings.load();
    assert.equal(settings.get().keyLimitUsd, 15);
    assert.equal(keys.limitUsd({}), 15);
});

test('bad values are refused and change nothing', () => {
    settings.update({ keyLimitUsd: 12 });
    assert.throws(() => settings.update({ keyLimitUsd: 0 }), /keyLimitUsd/);
    assert.throws(() => settings.update({ keyLimitUsd: 'lots' }), /keyLimitUsd/);
    assert.throws(() => settings.update({ keyDays: 0 }), /keyDays/);
    assert.throws(() => settings.update({ keyDays: 400 }), /keyDays/);
    assert.equal(settings.get().keyLimitUsd, 12);
});

test('reset goes back to $10 and 30 days', () => {
    settings.update({ keyLimitUsd: 50, keyDays: 7 });
    settings.reset();
    assert.equal(keys.limitUsd({}), 10);
    assert.equal(keys.lifetimeDays({}), 30);
});
