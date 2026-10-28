// The installable app: manifest, icons, page tags and the service worker's rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = path.join(__dirname, '..', 'ui');
const manifest = JSON.parse(fs.readFileSync(path.join(ui, 'manifest.webmanifest'), 'utf8'));

function pngSize(file) {
    const b = fs.readFileSync(file);
    assert.equal(b.subarray(1, 4).toString(), 'PNG', `${file} is a PNG`);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('the manifest names an app that starts inside its scope', () => {
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.name && manifest.short_name);
    // Relative, so the same file installs the app from /ui/ and from the site root
    const at = (u) => new URL(u, 'https://harness.example/manifest.webmanifest').pathname;
    for (const url of [manifest.start_url, manifest.id, ...manifest.shortcuts.map((s) => s.url)]) assert.ok(at(url).startsWith(at(manifest.scope)), `${url} is inside ${manifest.scope}`);
    assert.ok(fs.existsSync(path.join(ui, path.basename(manifest.start_url))));
});

test('every icon exists at the size it claims, with an any and a maskable one at 512', () => {
    for (const icon of manifest.icons) {
        const [w, h] = pngSize(path.join(ui, icon.src));
        assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
    for (const purpose of ['any', 'maskable']) assert.ok(manifest.icons.some((i) => i.purpose === purpose && i.sizes === '512x512'), purpose);
    assert.deepEqual(pngSize(path.join(ui, 'apple-touch-icon.png')), [180, 180]);
});

test('every page links the manifest with credentials, so a password-protected harness still installs', () => {
    const pages = fs.readdirSync(ui).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length >= 5);
    for (const page of pages) {
        const html = fs.readFileSync(path.join(ui, page), 'utf8');
        assert.match(html, /<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">/, page);
        assert.match(html, /<link rel="apple-touch-icon" href="apple-touch-icon.png">/, page);
        assert.match(html, /<meta name="theme-color"/, page);
    }
    assert.match(fs.readFileSync(path.join(ui, 'chat.html'), 'utf8'), /viewport-fit=cover/);
});

// Run sw.js against a stand-in for the worker's globals and replay fetches through it
function worker({ network, at = 'https://harness.example/ui/sw.js' }) {
    const listeners = {};
    const store = new Map();
    const cache = {
        addAll: async () => {},
        put: async (req, res) => { store.set(req.url, res); },
        match: async (req) => store.get(req.url),
    };
    const self = {
        location: new URL(at),
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: () => {}, clients: { claim: async () => {} },
    };
    vm.runInNewContext(fs.readFileSync(path.join(ui, 'sw.js'), 'utf8'), {
        self, URL, caches: { open: async () => cache, keys: async () => [], delete: async () => true }, fetch: network,
    });
    async function request(url, method = 'GET') {
        let answer;
        listeners.fetch({ request: { url, method }, respondWith: (p) => { answer = p; } });
        return answer === undefined ? undefined : answer;
    }
    return { request, store };
}

test('the service worker keeps the app\'s pages but never chats, API answers or other sites', async () => {
    let up = true;
    const ok = (body) => ({ ok: true, type: 'basic', body, clone() { return this; } });
    const w = worker({ network: async (req) => { if (!up) throw new Error('offline'); return ok(`fresh ${req.url}`); } });
    assert.equal(await w.request('https://harness.example/ui/api/usage'), undefined);
    assert.equal(await w.request('https://harness.example/v1/messages', 'POST'), undefined);
    assert.equal(await w.request('https://harness.example/ui/chat.js', 'POST'), undefined);
    assert.equal(await w.request('https://cdn.example/ui/chat.js'), undefined);
    assert.equal((await w.request('https://harness.example/ui/chat.js')).body, 'fresh https://harness.example/ui/chat.js');
    // the harness is asked first, so a changed page shows at once; the kept copy is the fallback
    assert.equal(w.store.size, 1);
    up = false;
    assert.equal((await w.request('https://harness.example/ui/chat.js')).body, 'fresh https://harness.example/ui/chat.js');
    await assert.rejects(w.request('https://harness.example/ui/usage.js'), /offline/);
});

test('a login prompt or an error never replaces a kept page', async () => {
    const w = worker({ network: async () => ({ ok: false, type: 'basic', status: 401, clone() { return this; } }) });
    const res = await w.request('https://harness.example/ui/chat.html');
    assert.equal(res.status, 401);
    assert.equal(w.store.size, 0);
});

test('served from the site root, the worker keeps pages and assets but not the API, login or Gateway paths', async () => {
    const ok = (body) => ({ ok: true, type: 'basic', body, clone() { return this; } });
    const w = worker({ at: 'https://harness.example/sw.js', network: async (req) => ok(req.url) });
    for (const p of ['/ui/api/usage', '/api/x', '/v1/messages', '/login', '/auth/github', '/admin/config', '/healthz', '/openrouter-proxy/x']) {
        assert.equal(await w.request(`https://harness.example${p}`), undefined, p);
    }
    for (const p of ['/', '/chat.html', '/chat.js', '/vendor/x.js', '/ui/chat.html']) assert.ok(await w.request(`https://harness.example${p}`), p);
});
