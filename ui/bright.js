// Bright Chat look, shared by every page: a background that draws a slowly
// turning embedding space (words grouped by meaning, the pointer acting as a
// query that lights up its nearest neighbours), and the edge glow that
// follows the pointer around cards.
// Still when the system asks for reduced motion; can be switched off. A page
// whose body has data-bg="off" (the chat page, for speed) starts with it off
// and remembers its own choice.
'use strict';

(() => {
  const offByDefault = document.body.dataset.bg === 'off';
  const BG_KEY = offByDefault ? 'bright-bg-chat' : 'bright-bg';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = !offByDefault;
  try { const v = localStorage.getItem(BG_KEY); if (v) enabled = v !== 'off'; } catch {}

  // Word clusters: things that mean similar things sit close together
  const CLUSTERS = [
    ['king', 'queen', 'prince', 'throne', 'crown', 'empire'],
    ['cat', 'dog', 'fox', 'wolf', 'kitten', 'puppy'],
    ['async', 'await', 'function', 'return', 'null', 'promise', 'lambda'],
    ['star', 'orbit', 'planet', 'comet', 'nebula', 'galaxy'],
    ['happy', 'joy', 'delight', 'calm', 'hope', 'glad'],
    ['bread', 'pasta', 'mango', 'coffee', 'honey', 'salt'],
    ['token', 'vector', 'embedding', 'attention', 'logit', 'context'],
    ['piano', 'rhythm', 'melody', 'chord', 'jazz', 'violin'],
  ];

  // ---- the background switch, at the end of the top bar's links -----------
  function decorate() {
    const nav = document.querySelector('nav');
    if (nav && !document.getElementById('bgToggle')) {
      const b = document.createElement('button');
      b.id = 'bgToggle';
      b.type = 'button';
      b.className = 'bg-toggle';
      b.dataset.hint = b.title = 'Turn the moving background on or off';
      b.setAttribute('aria-label', 'Background animation');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="7" r="1.6"/><circle cx="17" cy="5" r="1.6"/><circle cx="12" cy="13" r="1.6"/><circle cx="19" cy="18" r="1.6"/><circle cx="6" cy="18" r="1.6"/><path d="M6.4 7.7 10.8 12M13.4 12.2l2.6-5.6M13.3 13.9l4.4 3.1M10.6 13.8 7.3 17"/></svg>';
      b.addEventListener('click', () => setEnabled(!enabled));
      nav.appendChild(b);
      drawToggle();
    }
  }
  function drawToggle() {
    const b = document.getElementById('bgToggle');
    if (b) { b.classList.toggle('on', enabled); b.setAttribute('aria-pressed', String(enabled)); }
  }
  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(BG_KEY, on ? 'on' : 'off'); } catch {}
    drawToggle();
    canvas.hidden = !on;
    if (on) start(); else stop();
  }

  // ---- edge glow: cards light up along the edge nearest the pointer --------
  const GLOW = '.card, .bubble, .glow-edge, .node, fieldset, .chat-list li, .project-list li';
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.(GLOW);
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });

  // ---- the embedding space ----------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.className = 'space';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1, points = [], palette = [], ink = '#888', raf = 0, last = 0;
  const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, inside: false };
  const pulses = [];
  let angle = 0.6, tilt = 0;

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n, d) => s.getPropertyValue(n).trim() || d;
    palette = [v('--glow-a', '#ffb547'), v('--glow-b', '#ff5fa2'), v('--glow-c', '#8b6cff'), v('--glow-d', '#3fd0ff')];
    ink = v('--text', '#888');
  }

  // Seeded so the same words land in the same places each visit
  function rng(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

  function build() {
    const rand = rng(42);
    points = [];
    const small = W < 700;
    CLUSTERS.forEach((words, ci) => {
      const a = (ci / CLUSTERS.length) * Math.PI * 2;
      const center = [Math.cos(a) * 0.62, (rand() - 0.5) * 0.9, Math.sin(a) * 0.62];
      const extra = small ? 4 : 9; // unlabelled neighbours fill each cluster out
      for (let i = 0; i < words.length + extra; i++) {
        const spread = 0.2;
        const p = [center[0] + (rand() - 0.5) * spread * 2, center[1] + (rand() - 0.5) * spread * 2, center[2] + (rand() - 0.5) * spread * 2];
        points.push({ base: p, pos: p.slice(), phase: rand() * 6.28, speed: 0.3 + rand() * 0.5, word: words[i] || '', cluster: ci, color: palette[ci % palette.length], glow: 0, sx: 0, sy: 0, z: 0 });
      }
    });
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    readColors();
    build();
    draw(0);
  }

  // Rotate around y (the slow turn) then x (the pointer's tilt), then project
  function project(p) {
    const cy = Math.cos(angle), sy = Math.sin(angle), cx = Math.cos(tilt), sx = Math.sin(tilt);
    const x1 = p[0] * cy - p[2] * sy, z1 = p[0] * sy + p[2] * cy;
    const y2 = p[1] * cx - z1 * sx, z2 = p[1] * sx + z1 * cx;
    const scale = Math.min(W, H) * 0.62, depth = 2.6 / (2.6 + z2);
    return [W / 2 + x1 * scale * depth * (W > H ? 1.25 : 1), H / 2 + y2 * scale * depth, z2, depth];
  }

  function draw(dt) {
    const t = performance.now() / 1000;
    const moving = !reduced.matches;
    if (moving) {
      angle += dt * 0.05;
      const want = pointer.inside ? ((pointer.ty / H) - 0.5) * 0.5 : 0;
      tilt += (want - tilt) * Math.min(1, dt * 2);
    }
    pointer.x += (pointer.tx - pointer.x) * (moving ? Math.min(1, dt * 10) : 1);
    pointer.y += (pointer.ty - pointer.y) * (moving ? Math.min(1, dt * 10) : 1);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (const p of points) {
      if (moving) {
        p.pos[0] = p.base[0] + Math.sin(t * p.speed + p.phase) * 0.025;
        p.pos[1] = p.base[1] + Math.cos(t * p.speed * 0.8 + p.phase) * 0.025;
      }
      const [x, y, z, d] = project(p.pos);
      p.sx = x; p.sy = y; p.z = z; p.depth = d;
    }

    // the pointer is a query: its nearest points light up
    const near = pointer.inside
      ? points.map(p => ({ p, dist: Math.hypot(p.sx - pointer.x, p.sy - pointer.y) })).filter(n => n.dist < 200).sort((a, b) => a.dist - b.dist).slice(0, 7)
      : [];
    const lit = new Set(near.map(n => n.p));
    for (const p of points) p.glow += ((lit.has(p) ? 1 : 0) - p.glow) * (moving ? Math.min(1, dt * 6) : 1);

    // neighbours in the same cluster join up, faintly
    ctx.lineWidth = 1;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const b = points[j];
        if (a.cluster !== b.cluster) continue;
        const dx = a.pos[0] - b.pos[0], dy = a.pos[1] - b.pos[1], dz = a.pos[2] - b.pos[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 0.05) continue;
        const alpha = (1 - d2 / 0.05) * 0.16 * Math.min(a.depth, b.depth) + Math.max(a.glow, b.glow) * 0.25;
        ctx.strokeStyle = a.color; ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
    }

    // attention lines from the pointer to its neighbours
    for (const { p, dist } of near) {
      const g = ctx.createLinearGradient(pointer.x, pointer.y, p.sx, p.sy);
      g.addColorStop(0, palette[2]); g.addColorStop(1, p.color);
      ctx.strokeStyle = g; ctx.globalAlpha = 0.55 * (1 - dist / 200) * p.glow; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(pointer.x, pointer.y); ctx.lineTo(p.sx, p.sy); ctx.stroke();
    }

    // pulses: sending a message drops a new vector into the space
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i];
      pu.age += dt;
      if (pu.age > 1.4) { pulses.splice(i, 1); continue; }
      const k = pu.age / 1.4;
      ctx.globalAlpha = (1 - k) * 0.5; ctx.strokeStyle = pu.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pu.x, pu.y, 10 + k * 260, 0, Math.PI * 2); ctx.stroke();
      for (const p of points) {
        const d = Math.hypot(p.sx - pu.x, p.sy - pu.y);
        if (Math.abs(d - (10 + k * 260)) < 24) p.glow = Math.max(p.glow, 0.8 * (1 - k));
      }
    }

    // points, far ones first; nearest few show their word
    const sorted = [...points].sort((a, b) => b.z - a.z);
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const p of sorted) {
      const r = (1.3 + p.depth * 1.4) * (1 + p.glow * 0.9);
      ctx.globalAlpha = 0.28 + p.depth * 0.22 + p.glow * 0.5;
      ctx.fillStyle = p.color;
      if (p.glow > 0.05) { ctx.shadowColor = p.color; ctx.shadowBlur = 12 * p.glow; }
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      const showWord = p.word && (p.glow > 0.15 || (p.depth > 1.18 && W > 900));
      if (showWord) {
        ctx.globalAlpha = Math.max(0.12, p.glow * 0.85);
        ctx.fillStyle = p.glow > 0.15 ? p.color : ink;
        ctx.fillText(p.word, p.sx + r + 4, p.sy);
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    draw(dt);
    raf = reduced.matches ? 0 : requestAnimationFrame(frame);
  }
  function start() {
    if (!enabled || raf || document.hidden) return;
    last = performance.now();
    if (reduced.matches) draw(0); else raf = requestAnimationFrame(frame);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  addEventListener('pointermove', (e) => {
    pointer.tx = e.clientX; pointer.ty = e.clientY;
    if (!pointer.inside) { pointer.x = e.clientX; pointer.y = e.clientY; }
    pointer.inside = true;
    if (reduced.matches && enabled) draw(0); // still: redraw only when the pointer moves
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.inside = false; if (reduced.matches && enabled) draw(0); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduced.addEventListener?.('change', () => { stop(); start(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { readColors(); build(); draw(0); });
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });

  // Other pages' scripts can drop a pulse (the chat page does when you send)
  window.Bright = {
    pulse(x = W / 2, y = H / 2, which = 2) {
      if (!enabled || reduced.matches) return;
      pulses.push({ x, y, age: 0, color: palette[which % palette.length] });
    },
  };

  // ---- installable app: a service worker, and an Install button where the browser offers one ----
  // Chrome and Edge fire beforeinstallprompt when the app can be installed; Safari never does
  // (Share, then Add to Home Screen). Service workers need https or localhost.
  let installEvent = null;
  function drawInstall() {
    const nav = document.querySelector('nav');
    let b = document.getElementById('installBtn');
    if (!installEvent) { b?.remove(); return; }
    if (!nav || b) return;
    b = document.createElement('button');
    b.id = 'installBtn';
    b.type = 'button';
    b.className = 'install-btn';
    b.textContent = 'Install app';
    b.dataset.hint = b.title = 'Add Bright Chat to this device as an app';
    b.addEventListener('click', async () => {
      const event = installEvent;
      installEvent = null;
      drawInstall();
      try { await event.prompt(); } catch {}
    });
    nav.appendChild(b);
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; drawInstall(); });
  window.addEventListener('appinstalled', () => { installEvent = null; drawInstall(); });
  // With HARNESS_REQUIRE_LOGIN on, show who is signed in, with a way out
  async function drawAccount() {
    const nav = document.querySelector('nav');
    if (!nav || document.getElementById('accountChip')) return;
    let me;
    try {
      const r = await fetch('/ui/api/me', { credentials: 'same-origin' });
      if (!r.ok) return;
      me = await r.json();
    } catch { return; }
    if (!me.name || document.getElementById('accountChip')) return;
    const a = document.createElement('a');
    a.id = 'accountChip';
    a.className = 'account-chip';
    a.href = '/ui/users.html';
    a.textContent = me.name;
    a.dataset.hint = a.title = me.role === 'admin' ? 'Your account, other users and API keys' : 'Your password and API keys';
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'account-out';
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      try { await fetch('/logout', { method: 'POST' }); } catch {}
      location.href = '/login';
    });
    nav.append(a, out);
  }
  drawAccount();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  function init() {
    document.body.prepend(canvas);
    canvas.hidden = !enabled;
    decorate();
    drawInstall();
    resize();
    start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
