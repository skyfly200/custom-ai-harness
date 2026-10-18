const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-')), 'settings.json');
process.env.HARNESS_SETTINGS_FILE = FILE;
const settings = require('../utils/settings');

test('settings start at the defaults and save changes to the file', () => {
    assert.deepEqual(settings.get(), settings.DEFAULTS);
    settings.update({ caveman: false, fixedThreshold: '0.3', pinModel: 'fallback-ollama' });
    assert.equal(settings.get().fixedThreshold, 0.3);
    assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), settings.get());
    settings.load();
    assert.equal(settings.get().pinModel, 'fallback-ollama');
});

test('a bad value is refused and changes nothing', () => {
    const before = settings.get();
    assert.throws(() => settings.update({ headroom: false, fixedThreshold: 2 }), /from 0 to 1/);
    assert.throws(() => settings.update({ nope: 1 }), /unknown setting/);
    assert.throws(() => settings.update({ routerDownModel: '' }), /can't be empty/);
    assert.throws(() => settings.update({ pinModel: 'a b' }), /model name/);
    assert.deepEqual(settings.get(), before);
});

test('empty optional settings turn off, and reset deletes the file', () => {
    settings.update({ pinModel: '', fixedThreshold: null });
    assert.equal(settings.get().pinModel, null);
    settings.reset();
    assert.deepEqual(settings.get(), settings.DEFAULTS);
    assert.equal(fs.existsSync(FILE), false);
});

test('launch settings from the environment win over the saved file', () => {
    assert.deepEqual(settings.envOverrides({}), {});
    assert.deepEqual(settings.envOverrides({ HARNESS_MODE: 'passthrough' }),
        { pinModel: 'passthrough', caveman: false, headroom: false, contextAnchor: false });
    assert.deepEqual(settings.envOverrides({ HARNESS_MODE: 'passthrough', HARNESS_TRANSFORMS: 'on', PIN_MODEL: 'x' }),
        { pinModel: 'x', caveman: true, headroom: true, contextAnchor: true });
    assert.deepEqual(settings.envOverrides({ PIN_MODEL: 'a b', ROUTER_DOWN_TOOLS_MODEL: 'local-qwen' }),
        { routerDownToolsModel: 'local-qwen' });
    settings.update({ pinModel: 'saved' });
    process.env.PIN_MODEL = 'from-env';
    try {
        settings.load();
        assert.equal(settings.get().pinModel, 'from-env');
        settings.reset();
        assert.equal(settings.get().pinModel, 'from-env');
    } finally {
        delete process.env.PIN_MODEL;
        settings.reset();
    }
});
