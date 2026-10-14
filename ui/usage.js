// Usage page: token totals from /ui/api/usage drawn as a flow chart, a Sankey
// diagram, bars and a table. Plain SVG, no libraries. Refreshes live when the
// Interceptor's feed reports a finished request.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SVG = 'http://www.w3.org/2000/svg';
const fmt = (n) => Math.round(n).toLocaleString();
const short = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : fmt(n);

const MEASURES = { total: 'tokens', input: 'input tokens', output: 'output tokens', requests: 'requests' };
const state = { days: 7, measure: 'total', data: { rows: [] } };
try { Object.assign(state, JSON.parse(localStorage.getItem('usage-view') || '{}')); } catch {}

const valueOf = (r, m = state.measure) => m === 'total' ? r.input + r.output : r[m];

// Services keep their colour whatever the filter: known ones have fixed slots,
// others take the free slots in name order, and past eight share a grey.
const FIXED = ['OpenRouter', 'Groq', 'Local CLI wrapper', 'Ollama', 'Anthropic', 'OpenAI', 'Laya (local)', 'Google'];
function providerColors(rows) {
  const colors = {};
  const free = [];
  FIXED.forEach((p, i) => { colors[p] = `var(--s${i + 1})`; });
  const used = new Set(rows.map(r => r.provider));
  for (let i = 0; i < FIXED.length; i++) if (!used.has(FIXED[i])) free.push(`var(--s${i + 1})`);
  for (const p of [...used].filter(p => !colors[p]).sort()) colors[p] = free.shift() || 'var(--link-other)';
  return colors;
}

// ---- tooltip ----------------------------------------------------------------
const tip = $('tip');
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.hidden = true; };
function hoverable(el, html) {
  el.addEventListener('mousemove', (e) => showTip(e, html()));
  el.addEventListener('mouseleave', hideTip);
}
function tipBody(title, r) {
  return `<b>${esc(title)}</b><br>${fmt(r.input)} input · ${fmt(r.output)} output<br><span class="muted">${fmt(r.requests)} request${r.requests === 1 ? '' : 's'}${r.cacheRead ? ` · ${fmt(r.cacheRead)} cached input` : ''}${r.estimated ? ` · ${fmt(r.estimated)} estimated` : ''}</span>`;
}

// ---- helpers ----------------------------------------------------------------
function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
function text(parent, x, y, str, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}
const fit = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const blank = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0 });
function add(t, r) {
  for (const k of ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'estimated']) t[k] += r[k] || 0;
  return t;
}
function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    out.set(k, add(out.get(k) || blank(), r));
  }
  return out;
}
// Keep the biggest `max` names of a column; the rest become "Other"
function topNames(rows, key, max) {
  const sorted = [...groupBy(rows, key)].sort((a, b) => valueOf(b[1]) - valueOf(a[1])).map(([k]) => k);
  return new Set(sorted.slice(0, max));
}
function emptyChart(svg, msg) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', '0 0 720 80');
  text(svg, 360, 45, msg, { 'text-anchor': 'middle', class: 'muted' });
}

// ---- tiles ------------------------------------------------------------------
function renderTiles(rows) {
  const t = rows.reduce(add, blank());
  const tiles = [
    ['All tokens', short(t.input + t.output)],
    ['Input', short(t.input)],
    ['Output', short(t.output)],
    ['Cached input', short(t.cacheRead)],
    ['Requests', fmt(t.requests)],
    ['Services', new Set(rows.map(r => r.provider)).size],
  ];
  $('tiles').innerHTML = tiles.map(([label, v]) => `<div class="card stat"><div class="label">${label}</div><div class="num">${v}</div></div>`).join('')
    + (t.estimated ? `<div class="card stat"><div class="label">Estimated</div><div class="num">${Math.round(100 * t.estimated / t.requests)}%</div><div class="sub">of requests had no usage in the reply</div></div>` : '');
}

// ---- flow chart -------------------------------------------------------------
// Clients -> Interceptor -> how the model was picked -> Gateway -> services
function renderFlow(rows, colors) {
  const svg = $('flow');
  if (!rows.length) return emptyChart(svg, 'No requests in this range yet.');
  svg.replaceChildren();
  const total = rows.reduce(add, blank());
  const clients = [...groupBy(rows, 'client')].sort((a, b) => valueOf(b[1]) - valueOf(a[1]));
  const routes = [...groupBy(rows, 'route')].sort((a, b) => valueOf(b[1]) - valueOf(a[1]));
  const providers = [...groupBy(rows, 'provider')].sort((a, b) => valueOf(b[1]) - valueOf(a[1]));
  const fallbacks = rows.filter(r => r.servedBy !== r.model).reduce(add, blank());

  const W = 1120, BW = 168, BH = 50, GAP = 14;
  const cols = [
    { head: 'Clients', items: clients.map(([k, v]) => ({ label: k, v })) },
    { head: 'Interceptor', items: [{ label: 'Interceptor', v: total, hub: true }] },
    { head: 'Model picked by', items: routes.map(([k, v]) => ({ label: k, v })) },
    { head: 'Gateway', items: [{ label: 'Gateway (LiteLLM)', v: total, hub: true, sub: fallbacks.requests ? `${fmt(fallbacks.requests)} fell back` : 'no fallbacks' }] },
    { head: 'Services', items: providers.map(([k, v]) => ({ label: k, v, color: colors[k] })) },
  ];
  const tallest = Math.max(...cols.map(c => c.items.length));
  const H = 36 + tallest * (BH + GAP) - GAP + 8;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const step = (W - BW) / (cols.length - 1);
  cols.forEach((c, ci) => {
    c.x = ci * step;
    const h = c.items.length * (BH + GAP) - GAP;
    const top = 36 + (H - 36 - 8 - h) / 2;
    c.items.forEach((it, i) => { it.x = c.x; it.y = top + i * (BH + GAP); });
    text(svg, c.x + BW / 2, 16, c.head, { 'text-anchor': 'middle', class: 'head' });
  });

  const max = valueOf(total) || 1;
  const width = (v) => 1.5 + 12 * Math.sqrt(valueOf(v) / max);
  const edges = el('g', {}, svg);
  const edge = (a, b, v, color, title) => {
    const x0 = a.x + BW, y0 = a.y + BH / 2, x1 = b.x, y1 = b.y + BH / 2, mx = (x0 + x1) / 2;
    const p = el('path', { d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`, class: 'edge', stroke: color, 'stroke-width': width(v) }, edges);
    hoverable(p, () => tipBody(title, v));
  };
  const [cC, iC, rC, gC, pC] = cols;
  const accent = 'var(--accent)';
  cC.items.forEach(c => edge(c, iC.items[0], c.v, accent, `${c.label} → Interceptor`));
  rC.items.forEach(r => edge(iC.items[0], r, r.v, accent, `Interceptor → ${r.label}`));
  rC.items.forEach(r => edge(r, gC.items[0], r.v, accent, `${r.label} → Gateway`));
  pC.items.forEach(p => edge(gC.items[0], p, p.v, p.color, `Gateway → ${p.label}`));

  for (const c of cols) for (const it of c.items) {
    const g = el('g', {}, svg);
    el('rect', { x: it.x, y: it.y, width: BW, height: BH, rx: 7, class: `box${it.hub ? ' hub' : ''}` }, g);
    if (it.color) el('rect', { x: it.x, y: it.y + 8, width: 4, height: BH - 16, rx: 2, fill: it.color }, g);
    text(g, it.x + 12, it.y + 20, fit(it.label, 22));
    text(g, it.x + 12, it.y + 38, `${short(valueOf(it.v))} ${MEASURES[state.measure]}${it.sub ? ` · ${it.sub}` : ''}`, { class: 'muted' });
    hoverable(g, () => tipBody(it.label, it.v));
  }
}

// ---- Sankey -----------------------------------------------------------------
// Client -> model asked for -> model that served -> service
function renderSankey(rows, colors) {
  const svg = $('sankey');
  const live = rows.filter(r => valueOf(r) > 0);
  $('legend').innerHTML = [...new Set(rows.map(r => r.provider))].sort()
    .map(p => `<span><i class="sw" style="background:${colors[p]}"></i>${esc(p)}</span>`).join('');
  if (!live.length) return emptyChart(svg, `No ${MEASURES[state.measure]} in this range yet.`);
  svg.replaceChildren();

  const keys = ['client', 'model', 'servedBy', 'provider'];
  const heads = ['Client', 'Asked for', 'Served by', 'Service'];
  const keep = keys.map(k => topNames(live, k, k === 'client' || k === 'provider' ? 8 : 10));
  const name = (r, ci) => (keep[ci].has(r[keys[ci]]) ? r[keys[ci]] : 'Other');

  // nodes per column, links between neighbouring columns (coloured by service)
  const cols = keys.map(() => new Map());
  const links = new Map();
  for (const r of live) {
    const names = keys.map((_, ci) => name(r, ci));
    names.forEach((n, ci) => cols[ci].set(n, add(cols[ci].get(n) || blank(), r)));
    for (let ci = 0; ci < keys.length - 1; ci++) {
      const id = `${ci}|${names[ci]}|${names[ci + 1]}|${r.provider}`;
      const l = links.get(id) || { ci, from: names[ci], to: names[ci + 1], provider: r.provider, v: blank() };
      add(l.v, r);
      links.set(id, l);
    }
  }

  // Each node is at least MIN tall plus its share of the scale, and keeps
  // SLOT of room so its two label lines never collide with a neighbour's.
  const W = 1120, NW = 12, PAD = 8, TOP = 30, LABEL = 150, MIN = 3, SLOT = 30;
  const maxNodes = Math.max(...cols.map(c => c.size));
  const H = Math.max(260, Math.min(760, TOP + 10 + maxNodes * (SLOT + PAD) + 160));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const usable = H - TOP - 10;
  const colHeight = (c, k) => [...c.values()].reduce((sum, v) => sum + Math.max(SLOT, MIN + valueOf(v) * k), 0) + PAD * (c.size - 1);
  let lo = 0, hi = usable / Math.min(...cols.map(c => Math.max(...[...c.values()].map(v => valueOf(v)))));
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (cols.every(c => colHeight(c, mid) <= usable)) lo = mid; else hi = mid; }
  const scale = lo;
  const xs = keys.map((_, ci) => LABEL + ci * ((W - 2 * LABEL - NW) / (keys.length - 1)));

  const nodes = cols.map((c, ci) => {
    const list = [...c].sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || valueOf(b[1]) - valueOf(a[1]))
      .map(([n, v]) => ({ name: n, v, h: MIN + valueOf(v) * scale }));
    let y = TOP + (usable - colHeight(c, scale)) / 2;
    for (const n of list) {
      const slot = Math.max(SLOT, n.h);
      n.x = xs[ci]; n.y = y + (slot - n.h) / 2; n.out = n.y; n.in = n.y;
      y += slot + PAD;
    }
    text(svg, ci === 0 ? xs[ci] + NW : ci === keys.length - 1 ? xs[ci] : xs[ci] + NW / 2, 14, heads[ci],
      { class: 'head', 'text-anchor': ci === 0 ? 'end' : ci === keys.length - 1 ? 'start' : 'middle' });
    return new Map(list.map(n => [n.name, n]));
  });

  // Bands leave a node in the order of their targets and arrive in the order
  // of their sources, each as tall as its share of that node.
  const share = (l, n) => n.h * valueOf(l.v) / (valueOf(n.v) || 1);
  const all = [...links.values()];
  const yOf = (ci, name) => nodes[ci].get(name).y;
  for (const l of [...all].sort((a, b) => a.ci - b.ci || yOf(a.ci, a.from) - yOf(b.ci, b.from) || yOf(a.ci + 1, a.to) - yOf(b.ci + 1, b.to) || a.provider.localeCompare(b.provider))) {
    const s = nodes[l.ci].get(l.from);
    l.s0 = s.out; s.out += share(l, s); l.s1 = s.out;
  }
  for (const l of [...all].sort((a, b) => a.ci - b.ci || yOf(a.ci + 1, a.to) - yOf(b.ci + 1, b.to) || yOf(a.ci, a.from) - yOf(b.ci, b.from) || a.provider.localeCompare(b.provider))) {
    const t = nodes[l.ci + 1].get(l.to);
    l.t0 = t.in; t.in += share(l, t); l.t1 = t.in;
  }

  const bands = el('g', {}, svg);
  for (const l of all) {
    const x0 = xs[l.ci] + NW, x1 = xs[l.ci + 1], mx = (x0 + x1) / 2;
    const d = `M${x0},${l.s0} C${mx},${l.s0} ${mx},${l.t0} ${x1},${l.t0} L${x1},${l.t1} C${mx},${l.t1} ${mx},${l.s1} ${x0},${l.s1} Z`;
    const p = el('path', { d, class: 'band', fill: colors[l.provider] || 'var(--link-other)' }, bands);
    hoverable(p, () => tipBody(`${l.from} → ${l.to}`, l.v) + `<br><span class="muted">via ${esc(l.provider)}</span>`);
  }
  nodes.forEach((col, ci) => {
    const left = ci === 0, middle = ci > 0 && ci < keys.length - 1;
    const halo = middle ? { style: 'stroke:var(--panel);stroke-width:4px;paint-order:stroke;stroke-linejoin:round' } : {};
    for (const n of col.values()) {
      const g = el('g', {}, svg);
      el('rect', { x: n.x, y: n.y, width: NW, height: n.h, rx: 2, class: 'node', ...(ci === keys.length - 1 && colors[n.name] ? { style: `fill:${colors[n.name]}` } : {}) }, g);
      const lx = left ? n.x - 6 : n.x + NW + 6, anchor = left ? 'end' : 'start', cy = n.y + n.h / 2;
      text(g, lx, cy - 2, fit(n.name, 26), { 'text-anchor': anchor, ...halo });
      text(g, lx, cy + 12, short(valueOf(n.v)), { 'text-anchor': anchor, class: 'muted', ...halo });
      hoverable(g, () => tipBody(n.name, n.v));
    }
  });
}

// ---- bars and table ---------------------------------------------------------
function renderBars(target, rows, key, colors) {
  const groups = [...groupBy(rows, key)].sort((a, b) => valueOf(b[1]) - valueOf(a[1]));
  if (!groups.length) { $(target).innerHTML = '<div class="muted">No requests in this range yet.</div>'; return; }
  const reqs = state.measure === 'requests';
  const max = Math.max(...groups.map(([, v]) => (reqs ? v.requests : v.input + v.output)), 1);
  $(target).replaceChildren(...groups.map(([k, v]) => {
    const div = document.createElement('div');
    div.className = 'bar';
    const dot = key === 'provider' ? `<i class="sw" style="background:${colors[k]};margin-right:6px"></i>` : '';
    const right = reqs ? `${fmt(v.requests)} request${v.requests === 1 ? '' : 's'}` : `${short(v.input)} in · ${short(v.output)} out`;
    const track = reqs ? `<i class="req" style="width:${100 * v.requests / max}%"></i>`
      : `${v.input ? `<i class="in" style="width:${100 * v.input / max}%"></i>` : ''}${v.output ? `<i class="out" style="width:${100 * v.output / max}%"></i>` : ''}`;
    div.innerHTML = `<div class="top"><span class="name">${dot}${esc(k)}</span><span class="v">${right}</span></div><div class="track">${track}</div>`;
    hoverable(div, () => tipBody(k, v));
    return div;
  }));
}

function renderTable(rows) {
  if (!rows.length) { $('rows').innerHTML = '<tr><td colspan="9" class="muted">No requests in this range yet.</td></tr>'; return; }
  const approx = (r) => (r.estimated ? '~' : '');
  $('rows').innerHTML = [...rows].sort((a, b) => valueOf(b) - valueOf(a)).map(r => `<tr>
    <td>${esc(r.client)}</td><td>${esc(r.route)}</td><td><code>${esc(r.model)}</code></td>
    <td><code>${esc(r.servedBy)}</code>${r.servedBy !== r.model ? ' <span class="tag warn">fallback</span>' : ''}</td><td>${esc(r.provider)}</td>
    <td class="num r">${fmt(r.requests)}</td><td class="num r">${approx(r)}${fmt(r.input)}</td><td class="num r">${fmt(r.cacheRead)}</td><td class="num r">${approx(r)}${fmt(r.output)}</td></tr>`).join('');
}

function render() {
  const rows = state.data.rows || [];
  const colors = providerColors(rows);
  for (const b of $('range').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === state.days);
  for (const b of $('measure').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === state.measure);
  for (const l of document.querySelectorAll('.legend.io')) l.style.display = state.measure === 'requests' ? 'none' : '';
  renderTiles(rows);
  renderFlow(rows, colors);
  renderSankey(rows, colors);
  renderBars('byModel', rows, 'servedBy', colors);
  renderBars('byProvider', rows, 'provider', colors);
  renderTable(rows);
  const since = state.data.since ? `counting since ${new Date(state.data.since).toLocaleString()}` : 'nothing counted yet';
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · ${since}`;
}

async function refresh() {
  try {
    const res = await fetch(`api/usage?days=${state.days}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    render();
  } catch (err) {
    $('updated').textContent = `Couldn't load usage: ${err.message}`;
  }
}

const saveView = () => { try { localStorage.setItem('usage-view', JSON.stringify({ days: state.days, measure: state.measure })); } catch {} };
$('range').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.days = Number(b.dataset.days); saveView(); refresh();
});
$('measure').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.measure = b.dataset.m; saveView(); render();
});
$('clear').addEventListener('click', async () => {
  if (!confirm('Clear all saved token totals? This cannot be undone.')) return;
  const res = await fetch('api/usage/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`); return; }
  refresh();
});

// Redraw when a request finishes (at most every 2 s), and poll as a fallback
let pending = null;
function soon() { if (!pending) pending = setTimeout(() => { pending = null; refresh(); }, 2000); }
if ('EventSource' in window) {
  const live = new EventSource('api/live');
  live.onmessage = (msg) => { try { if (JSON.parse(msg.data).type === 'usage') soon(); } catch {} };
}
setInterval(refresh, 60000);
refresh();
