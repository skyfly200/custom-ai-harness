const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seed, commands } = require('../docker/fly-start');

function dirs() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-start-'));
    const app = path.join(base, 'app');
    const data = path.join(base, 'data');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'config.yaml'), 'model_list: []\n');
    fs.writeFileSync(path.join(app, 'routellm-config.yaml'), 'router: {}\n');
    return { app, data };
}

test('first start copies the shipped config onto the volume', () => {
    const { app, data } = dirs();
    const notes = seed(app, data);
    assert.strictEqual(notes.length, 2);
    assert.strictEqual(fs.readFileSync(path.join(data, 'config.yaml'), 'utf8'), 'model_list: []\n');
});

test('a later start leaves the volume\'s copy alone and notes a changed shipped copy as .new', () => {
    const { app, data } = dirs();
    seed(app, data);
    fs.writeFileSync(path.join(data, 'config.yaml'), 'model_list: [edited]\n');
    fs.writeFileSync(path.join(app, 'config.yaml'), 'model_list: [new]\n');
    const notes = seed(app, data);
    assert.strictEqual(fs.readFileSync(path.join(data, 'config.yaml'), 'utf8'), 'model_list: [edited]\n');
    assert.strictEqual(fs.readFileSync(path.join(data, 'config.yaml.new'), 'utf8'), 'model_list: [new]\n');
    assert.ok(notes.some((n) => n.includes('config.yaml.new')));
    assert.deepStrictEqual(notes.filter((n) => n.startsWith('routellm')), []);
});

test('the Gateway and Router listen on loopback and everything points at the volume', () => {
    const list = commands('/vol', { PATH: 'x', SECRET: 's' });
    assert.deepStrictEqual(list.map((c) => c.name), ['gateway', 'router', 'interceptor']);
    const [gateway, router, interceptor] = list;
    assert.strictEqual(gateway.env.GATEWAY_HOST, '127.0.0.1');
    assert.strictEqual(gateway.env.GATEWAY_SOURCE, path.join('/vol', 'config.yaml'));
    assert.ok(router.args.includes('127.0.0.1'));
    assert.strictEqual(interceptor.env.GATEWAY_URL, 'http://127.0.0.1:4000');
    assert.strictEqual(interceptor.env.HARNESS_USERS_FILE, path.join('/vol', 'users.json'));
    assert.strictEqual(interceptor.env.SECRET, 's');
});

test("the Gateway doesn't see the app's DATABASE_URL, LiteLLM would try to use it", () => {
    const [gateway, , interceptor] = commands('/vol', { DATABASE_URL: 'postgres://neon' });
    assert.strictEqual(gateway.env.DATABASE_URL, undefined);
    assert.strictEqual(interceptor.env.DATABASE_URL, 'postgres://neon');
});
