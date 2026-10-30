const test = require('node:test');
const assert = require('node:assert/strict');
const { make, orb, seedOf } = require('../ui/agenticon');

test('the same seed always gives the same icon', () => {
    assert.deepEqual(make('a1b2c3'), make('a1b2c3'));
    assert.equal(orb({ id: 'x1' }, 'live'), orb({ id: 'x1' }, 'live'));
});

test('icons differ across many ids', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `a${(1760000000000 + i * 977).toString(36)}${(i * 2654435761 % 65536).toString(16)}`);
    const looks = new Set(ids.map((id) => make(id).svg + make(id).colors.a));
    assert.ok(looks.size >= 198, `only ${looks.size} distinct icons`);
    const hues = new Set(ids.map((id) => Math.floor(make(id).hue / 30)));
    assert.ok(hues.size >= 10, 'hues should spread around the wheel');
});

test('an iconSeed wins over the id, and the Default agent uses a fixed seed like the others', () => {
    assert.equal(seedOf({ id: 'a1', iconSeed: 's9' }), 's9');
    assert.notEqual(orb({ id: 'a1', iconSeed: 's9' }), orb({ id: 'a1' }));
    assert.equal(orb(null), orb('default'));
    assert.equal(orb(undefined), orb({ id: '' }));
    assert.match(orb(null, 'wait', 'big'), /class="orb big wait gen"/);
});

test('markup is safe and well formed', () => {
    const html = orb({ id: '"><script>' });
    assert.ok(!html.includes('<script>'));
    assert.match(html, /^<span class="orb gen" style="--glow-a:hsl\(/);
    assert.equal((html.match(/<svg/g) || []).length, 1);
});

test('a custom picture or text replaces the glyph; unsafe pictures are ignored', () => {
    const img = orb({ id: 'a1', iconImage: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.match(img, /background-image:url\(data:image\/png;base64,iVBORw0KGgo=\)/);
    assert.ok(!img.includes('<svg'));
    const txt = orb({ id: 'a1', iconText: '<b>' });
    assert.match(txt, /<span class="mark">&lt;b&gt;<\/span>/);
    const bad = orb({ id: 'a1', iconImage: 'javascript:alert(1)' });
    assert.ok(!bad.includes('javascript') && bad.includes('<svg'));
});
