// A generative icon for every agent: the harness orb in a palette and with a
// symmetric glyph that come from a hash of the agent's id (or its iconSeed, when
// the person shuffled it). Same seed, same icon, nothing stored or fetched. Pure,
// so it runs in the page (window.AgentIcon) and in Node tests (require).
(function (root) {
  // FNV-1a, then a small seeded generator (mulberry32)
  function hash(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = hash(seed) || 1;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const r1 = (n) => Math.round(n * 10) / 10;
  const seedOf = (agent) => (agent && (agent.iconSeed || agent.id)) || '';

  /** The look for a seed: four glow colours (the orb's --glow-a..d) and the glyph markup. */
  function make(seed) {
    const rnd = rng(`icon:${seed}`);
    const hue = Math.floor(rnd() * 360);
    const spread = 35 + rnd() * 70;           // how far the other colours sit from the first
    const dir = rnd() < 0.5 ? 1 : -1;
    const col = (i, s, l) => `hsl(${Math.round((hue + dir * spread * i + 360) % 360)} ${s}% ${l}%)`;
    const colors = { a: col(0, 92, 62), b: col(1, 88, 58), c: col(2, 78, 52), d: col(3, 95, 66) };

    // the glyph: n-fold rotational symmetry, a few layers of petals / rays / dots, a core
    const n = 3 + Math.floor(rnd() * 6);       // 3..8 arms
    const mirror = rnd() < 0.5;                // reflect each arm across its axis too
    const layers = [];
    const count = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < count; i++) {
      const kind = ['petal', 'ray', 'dot', 'ring'][Math.floor(rnd() * 4)];
      const r = 10 + rnd() * 26;               // distance from the centre
      const size = 4 + rnd() * 9;
      const op = r1(0.45 + rnd() * 0.4);
      let d = '';
      if (kind === 'petal') d = `M0 ${-r1(r)}Q${r1(size)} ${-r1(r + size * 1.4)} 0 ${-r1(r + size * 2.6)}Q${-r1(size)} ${-r1(r + size * 1.4)} 0 ${-r1(r)}Z`;
      else if (kind === 'ray') d = `M${-r1(size / 3)} ${-r1(r)}L${r1(size / 3)} ${-r1(r)}L0 ${-r1(r + size * 2.2)}Z`;
      else if (kind === 'dot') d = `M0 ${-r1(r)}m${-r1(size / 2)} 0a${r1(size / 2)} ${r1(size / 2)} 0 1 0 ${r1(size)} 0a${r1(size / 2)} ${r1(size / 2)} 0 1 0 ${-r1(size)} 0Z`;
      else d = `M0 ${-r1(r)}m${-r1(size / 2)} 0a${r1(size / 2)} ${r1(size / 2)} 0 1 0 ${r1(size)} 0a${r1(size / 2)} ${r1(size / 2)} 0 1 0 ${-r1(size)} 0Z`;
      layers.push({ d, op, ring: kind === 'ring', offset: i ? r1(rnd() * (360 / n)) : 0 });
    }
    const arms = (l) => Array.from({ length: n }, (_, k) => {
      const a = r1(k * 360 / n + l.offset);
      const body = `<path d="${l.d}" transform="rotate(${a})"/>` + (mirror ? `<path d="${l.d}" transform="rotate(${a}) scale(-1 1)"/>` : '');
      return body;
    }).join('');
    const core = r1(4 + rnd() * 5);
    const ring = rnd() < 0.6 ? `<circle r="${r1(core + 4 + rnd() * 4)}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.4"/>` : '';
    const svg = `<svg class="glyph" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">`
      + layers.map((l) => (l.ring
        ? `<g fill="none" stroke="#fff" stroke-width="1.6" stroke-opacity="${l.op}">${arms(l)}</g>`
        : `<g fill="#fff" fill-opacity="${l.op}">${arms(l)}</g>`)).join('')
      + `${ring}<circle r="${core}" fill="#fff" fill-opacity=".7"/></svg>`;
    return { hue, colors, svg, arms: n };
  }

  // A custom icon the person set: a small uploaded picture (data URL) or a few characters such as an emoji
  const IMG = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  const customOf = (agent) => (agent && typeof agent === 'object' ? { image: IMG.test(agent.iconImage || '') ? agent.iconImage : '', text: String(agent.iconText || '').slice(0, 8) } : { image: '', text: '' });
  const escText = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const styleOf = (c) => `--glow-a:${c.a};--glow-b:${c.b};--glow-c:${c.c};--glow-d:${c.d}`;

  /**
   * The orb markup for an agent (or a bare seed string). `state` is '', 'live' or 'wait';
   * `extra` more classes (e.g. 'big'). With no agent (the Default one) it is the standard
   * harness orb: the page's own colours and no glyph.
   */
  function orb(agent, state = '', extra = '') {
    const seed = typeof agent === 'string' ? agent : seedOf(agent);
    const cls = `orb${extra ? ` ${extra}` : ''}${state ? ` ${state}` : ''}`;
    if (!seed) return `<span class="${cls}"><i></i><i></i><i></i></span>`;
    const m = make(seed);
    const cu = customOf(agent);
    if (cu.image) return `<span class="${cls} gen img" style="${styleOf(m.colors)};background-image:url(${cu.image})"><i></i><i></i><i></i></span>`;
    if (cu.text) return `<span class="${cls} gen" style="${styleOf(m.colors)}"><span class="mark">${escText(cu.text)}</span><i></i><i></i><i></i></span>`;
    return `<span class="${cls} gen" style="${styleOf(m.colors)}">${m.svg}<i></i><i></i><i></i></span>`;
  }

  /** A small still icon (no orbiting dots) for rows and lists; styled by agenticon.css. Default agent: the plain orb colours. */
  function icon(agent, extra = '') {
    const seed = typeof agent === 'string' ? agent : seedOf(agent);
    const cls = `aicon${extra ? ` ${extra}` : ''}`;
    if (!seed) return `<span class="${cls}" aria-hidden="true"></span>`;
    const m = make(seed);
    const cu = customOf(agent);
    if (cu.image) return `<span class="${cls} img" style="${styleOf(m.colors)};background-image:url(${cu.image})" aria-hidden="true"></span>`;
    if (cu.text) return `<span class="${cls}" style="${styleOf(m.colors)}" aria-hidden="true"><span class="mark">${escText(cu.text)}</span></span>`;
    return `<span class="${cls}" style="${styleOf(m.colors)}" aria-hidden="true">${m.svg}</span>`;
  }

  /** A fresh random seed for the Shuffle button. */
  const randomSeed = () => Math.random().toString(36).slice(2, 10);

  const api = { IMG, hash, make, orb, icon, seedOf, styleOf, randomSeed };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentIcon = api;
})(typeof window !== 'undefined' ? window : globalThis);
