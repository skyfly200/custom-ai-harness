// Usage page: token totals from /ui/api/usage drawn as a flow chart, a Sankey
// diagram, a chart over time, bars and a table, with costs worked out from the
// Gateway's price list (/ui/api/model-info). Plain SVG, no libraries.
// Refreshes live when the Interceptor's feed reports a finished request.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SVG = 'http://www.w3.org/2000/svg';
const fmt = (n) => Math.round(n).toLocaleString();
const short = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : fmt(n);

const MEASURES = { total: 'tokens', input: 'input tokens', output: 'output tokens', requests: 'requests', cost: 'cost' };
const usd = Costs.usd;
// A value of the selected measure, written out
const showV = (n, m = state.measure) => (m === 'cost' ? usd(n) : `${short(n)} ${MEASURES[m]}`);
const shortV = (n, m = state.measure) => (m === 'cost' ? usd(n) : short(n));

// Prices per token by Gateway model name (ui/costs.js prices the rows: .cost
// in dollars with cached input at the cache price, .unpriced requests on
// models with no known price)
let prices = {};
const price = (rows) => Costs.priceRows(rows, prices);
const state = { days: 7, measure: 'total', data: { rows: [] } };
try { Object.assign(state, JSON.parse(localStorage.getItem('usage-view') || '{}')); } catch {}

const valueOf = (r, m = state.measure) => m === 'total' ? r.input + r.output : r[m] || 0;

// Services keep their colour whatever the filter: known ones have fixed slots,
// others take the free slots in name order, and past eight share a grey.
const FIXED = ['OpenRouter', 'Groq', 'Local engine', 'Ollama', 'Anthropic', 'OpenAI', 'Laya (local)', 'Google'];
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
  const cost = r.unpriced >= r.requests ? 'no known price' : `${r.cost ? `≈ ${usd(r.cost)}` : 'free'}${r.unpriced ? ` (+${fmt(r.unpriced)} unpriced)` : ''}`;
  return `<b>${esc(title)}</b><br>${fmt(r.input)} input · ${fmt(r.output)} output · ${cost}<br><span class="muted">${fmt(r.requests)} request${r.requests === 1 ? '' : 's'}${r.cacheRead ? ` · ${fmt(r.cacheRead)} cached input` : ''}${r.estimated ? ` · ${fmt(r.estimated)} estimated` : ''}</span>`;
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
const SUMS = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'estimated', 'cost', 'listCost', 'unpriced', 'freeRequests', 'savedAnchor', 'savedHeadroom'];
const blank = () => Object.fromEntries(SUMS.map(k => [k, 0]));
function add(t, r) {
  for (const k of SUMS) t[k] += r[k] || 0;
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
// Days the chart spans: the selected range, or since the first day counted
function rangeDays(daily) {
  if (state.days) return state.days;
  if (!daily.length) return 1;
  return Math.max(1, Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(daily[0].day)) / 86400000) + 1);
}
// Days that had a chance to count, for daily averages: a 30-day range that
// started counting a week ago averages over the week
const countedDays = (daily) => (daily.length ? Math.min(rangeDays(daily), Math.floor((Date.now() - Date.parse(daily[0].day)) / 86400000) + 1) : 1);
function renderTiles(rows, daily) {
  const t = rows.reduce(add, blank());
  const priced = t.requests - t.unpriced;
  const perDay = t.cost / Math.max(1, countedDays(daily));
  const tile = (label, v, sub = '', cls = '') => `<div class="card stat${cls}"><div class="label">${label}</div><div class="num">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('tiles').innerHTML = [
    tile('Spend', usd(t.cost), t.unpriced ? `+ ${fmt(t.unpriced)} request${t.unpriced === 1 ? '' : 's'} with no known price` : 'cached input at cache prices', ' money'),
    tile('Per 30 days', usd(perDay * 30), `at ${usd(perDay)} a day`, ' money'),
    tile('Per request', priced ? usd(t.cost / priced) : '–', priced ? `over ${fmt(priced)} priced` : '', ' money'),
    tile('Per million tokens', t.input + t.output ? usd(t.cost / (t.input + t.output) * 1e6) : '–', 'input and output', ' money'),
    tile('Free', t.requests ? `${Math.round(100 * t.freeRequests / t.requests)}%` : '–', 'of requests on free or local models'),
    tile('All tokens', short(t.input + t.output), `${short(t.input)} in · ${short(t.output)} out`),
    tile('Cached input', short(t.cacheRead), t.input ? `${Math.round(100 * t.cacheRead / t.input)}% of input` : ''),
    tile('Requests', fmt(t.requests), `${new Set(rows.map(r => r.provider)).size} services`),
  ].join('') + (t.estimated ? tile('Estimated', `${Math.round(100 * t.estimated / t.requests)}%`, 'of requests had no usage in the reply') : '');
}

// ---- over time ----------------------------------------------------------------
// One stacked bar a day, a band per service, sized by the selected measure
function renderTimeline(daily, colors) {
  const svg = $('timeline');
  if (!daily.length) return emptyChart(svg, 'No requests in this range yet.');
  svg.replaceChildren();
  const last = new Date().toISOString().slice(0, 10);
  const n = rangeDays(daily);
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(new Date(Date.parse(last) - i * 86400000).toISOString().slice(0, 10));
  const byDay = new Map(days.map(d => [d, new Map()]));
  for (const r of daily) {
    const m = byDay.get(r.day);
    if (m) m.set(r.provider, add(m.get(r.provider) || blank(), r));
  }
  const totals = days.map(d => [...byDay.get(d).values()].reduce(add, blank()));
  const max = Math.max(...totals.map(t => valueOf(t)), 0) || 1;
  const W = 1120, H = 240, L = 64, B = 26, T = 12;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const step = (W - L - 8) / days.length, bw = Math.max(3, Math.min(42, step * 0.66));
  const y = (v) => H - B - (v / max) * (H - B - T);
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    el('line', { x1: L, x2: W - 4, y1: y(v), y2: y(v), class: 'grid' }, svg);
    text(svg, L - 8, y(v) + 4, shortV(v), { 'text-anchor': 'end', class: 'muted' });
  }
  const order = [...new Set(daily.map(r => r.provider))].sort();
  const every = Math.ceil(days.length / 12);
  days.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2;
    let top = H - B;
    for (const p of order) {
      const v = byDay.get(d).get(p);
      if (!v || !valueOf(v)) continue;
      const h = (valueOf(v) / max) * (H - B - T);
      top -= h;
      const r = el('rect', { x, y: top, width: bw, height: Math.max(0.5, h), rx: 2, fill: colors[p] || 'var(--link-other)', class: 'day-seg' }, svg);
      hoverable(r, () => tipBody(`${p} · ${new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`, v));
    }
    if (i % every === 0 || i === days.length - 1) {
      text(svg, x + bw / 2, H - 8, new Date(d + 'T12:00').toLocaleDateString(undefined, n <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }), { 'text-anchor': 'middle', class: 'muted' });
    }
  });
  $('timelineNote').textContent = `${state.measure === 'cost' ? 'Spend' : 'Usage'} per day, by the service that answered. Busiest day: ${shortV(Math.max(...totals.map(t => valueOf(t))))} on ${new Date(days[totals.findIndex(t => valueOf(t) === Math.max(...totals.map(x => valueOf(x))))] + 'T12:00').toLocaleDateString()}.`;
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
    text(g, it.x + 12, it.y + 38, `${showV(valueOf(it.v))}${it.sub ? ` · ${it.sub}` : ''}`, { class: 'muted' });
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
  if (!live.length) return emptyChart(svg, state.measure === 'cost' ? 'Nothing with a known price in this range yet.' : `No ${MEASURES[state.measure]} in this range yet.`);
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
      text(g, lx, cy + 12, shortV(valueOf(n.v)), { 'text-anchor': anchor, class: 'muted', ...halo });
      hoverable(g, () => tipBody(n.name, n.v));
    }
  });
}

// ---- savings ------------------------------------------------------------------
// What the same requests would have cost sent straight to Claude Sonnet 5.5,
// and how much each part of the stack took off (ui/costs.js does the sums)
const LAYER_COLORS = { compression: 'var(--s3)', router: 'var(--s1)', pinned: 'var(--s7)', down: 'var(--s4)', fallback: 'var(--s2)', caching: 'var(--s5)' };
const pct = (part, whole) => (whole > 0 ? `${Math.round(100 * part / whole)}%` : '–');

function layerTokens(l) {
  if (!l.tokens) return '–';
  if (l.id === 'compression') return `${short(l.tokens)} trimmed`;
  if (l.id === 'caching') return `${short(l.tokens)} cached`;
  return `${short(l.tokens)} on free models`;
}

function renderSavings(rows, daily) {
  const s = Costs.savings(rows);
  const shown = s.layers.filter(l => l.saved || l.requests);
  const leftOut = s.unpriced ? ` ${fmt(s.unpriced)} request${s.unpriced === 1 ? '' : 's'} on models with no known price are left out.` : '';
  const fig = (label, v, sub = '', cls = '') => `<div class="fig${cls}"><div class="label">${label}</div><div class="num">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('saveHead').innerHTML = s.requests ? [
    fig(`${Costs.SONNET.name} directly`, usd(s.baseline), 'same requests, no compression or caching'),
    fig('Through the harness', usd(s.actual), `${fmt(s.requests)} priced request${s.requests === 1 ? '' : 's'}`),
    fig(s.saved >= 0 ? 'Saved' : 'Cost extra', usd(Math.abs(s.saved)), `${pct(Math.abs(s.saved), s.baseline)} of the Sonnet price`, ' money'),
  ].join('') : '';
  $('saveLegend').innerHTML = shown.map(l => `<span><i class="sw" style="background:${LAYER_COLORS[l.id]}"></i>${esc(l.label)}</span>`).join('');
  renderWaterfall(s, shown);
  renderSaveTime(daily, shown);
  $('saveRows').innerHTML = shown.length ? shown.map(l => `<tr>
      <td><i class="sw" style="background:${LAYER_COLORS[l.id]};margin-right:6px"></i>${esc(l.label)}</td><td class="muted">${esc(l.what)}</td>
      <td class="num r">${l.requests ? fmt(l.requests) : '–'}</td><td class="num r">${layerTokens(l)}</td>
      <td class="num r">${l.saved < 0 ? `<span class="warn">${usd(l.saved)}</span>` : usd(l.saved)}</td><td class="num r">${s.saved > 0 && l.saved > 0 ? pct(l.saved, s.saved) : '–'}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">No priced requests in this range yet.</td></tr>';
  const cached = s.requests ? ` Counting Sonnet’s own prompt caching on the same cache hits, Sonnet would have cost ${usd(s.baselineCached)}, so the harness ${s.savedCached >= 0 ? 'saved' : 'cost'} ${usd(Math.abs(s.savedCached))} (${pct(Math.abs(s.savedCached), s.baselineCached)}).` : '';
  const trimmed = s.trimmed ? ` Compression took out about ${short(s.trimmed)} input tokens (${short(s.headroom)} by Headroom, ${short(s.anchor)} by the context anchor).` : '';
  $('saveNote').textContent = `Sonnet 5.5 at $2 per million input tokens and $10 per million output, on the same token counts.${cached}${trimmed} Model layers save the difference between Sonnet’s price and the answering model’s; negative means that model cost more than Sonnet would have. Caveman’s shorter replies aren’t measured.${leftOut}`;
}

// Bars from the Sonnet price down to what was paid, a step per layer
function renderWaterfall(s, shown) {
  const svg = $('waterfall');
  if (!s.requests) return emptyChart(svg, 'No priced requests in this range yet.');
  svg.replaceChildren();
  const steps = [{ label: `${Costs.SONNET.name} directly`, from: 0, to: s.baseline, total: true }];
  let run = s.baseline;
  for (const l of shown) { steps.push({ label: l.label, from: run - l.saved, to: run, layer: l }); run -= l.saved; }
  steps.push({ label: 'Through the harness', from: 0, to: s.actual, total: true });
  const W = 1120, L = 200, R = 110, ROW = 30, T = 6;
  const H = T + steps.length * ROW + 4;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const max = Math.max(...steps.map(st => Math.max(st.from, st.to)), 1e-12);
  const x = (v) => L + (Math.max(0, v) / max) * (W - L - R);
  steps.forEach((st, i) => {
    const y = T + i * ROW, lo = Math.min(st.from, st.to), hi = Math.max(st.from, st.to);
    const g = el('g', {}, svg);
    text(g, L - 10, y + ROW / 2 + 4, fit(st.label, 28), { 'text-anchor': 'end', ...(st.total ? { 'font-weight': 600 } : {}) });
    el('rect', { x: x(lo), y: y + 5, width: Math.max(1.5, x(hi) - x(lo)), height: ROW - 10, rx: 3,
      fill: st.total ? 'var(--node)' : LAYER_COLORS[st.layer.id], 'fill-opacity': st.layer?.saved < 0 ? 0.45 : 1 }, g);
    if (i < steps.length - 1) { // the running total carries on to the next bar
      const at = x(st.total ? st.to : st.from);
      el('line', { x1: at, x2: at, y1: y + ROW - 5, y2: y + ROW + 5, class: 'grid' }, svg);
    }
    const value = st.total ? usd(st.to) : `${st.layer.saved >= 0 ? '−' : '+'}${usd(Math.abs(st.layer.saved))}`;
    text(g, x(hi) + 8, y + ROW / 2 + 4, value, { class: st.total ? '' : 'muted' });
    hoverable(g, () => st.total ? `<b>${esc(st.label)}</b><br>${usd(st.to)}`
      : `<b>${esc(st.label)}</b><br>${st.layer.saved >= 0 ? 'Saved' : 'Cost extra'} ${usd(Math.abs(st.layer.saved))}${s.saved > 0 && st.layer.saved > 0 ? ` · ${pct(st.layer.saved, s.saved)} of savings` : ''}<br><span class="muted">${esc(st.layer.what)}${st.layer.tokens ? ` · ${layerTokens(st.layer)}` : ''}</span>`);
  });
}

// Savings adding up day by day, a band per layer, with the net total as a line
function renderSaveTime(daily, shown) {
  const svg = $('saveTime');
  if (!daily.length || !shown.length) return emptyChart(svg, 'Savings over time show up once there are priced requests.');
  svg.replaceChildren();
  const last = new Date().toISOString().slice(0, 10);
  const n = rangeDays(daily);
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(new Date(Date.parse(last) - i * 86400000).toISOString().slice(0, 10));
  const ids = shown.map(l => l.id);
  const sums = Object.fromEntries(ids.map(id => [id, 0]));
  let net = 0;
  const points = days.map(d => {
    const s = Costs.savings(daily.filter(r => r.day === d));
    for (const l of s.layers) if (l.id in sums) sums[l.id] += l.saved;
    net += s.saved;
    return { day: d, layers: { ...sums }, net };
  });
  const top = (p) => ids.reduce((sum, id) => sum + Math.max(0, p.layers[id]), 0);
  const max = Math.max(...points.map(p => Math.max(top(p), p.net)), 1e-12);
  const W = 1120, H = 220, L = 64, B = 26, T = 12;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const step = days.length > 1 ? (W - L - 12) / (days.length - 1) : 0;
  const xOf = (i) => (days.length > 1 ? L + i * step : L + (W - L - 12) / 2);
  const y = (v) => H - B - (Math.max(0, v) / max) * (H - B - T);
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    el('line', { x1: L, x2: W - 4, y1: y(v), y2: y(v), class: 'grid' }, svg);
    text(svg, L - 8, y(v) + 4, usd(v), { 'text-anchor': 'end', class: 'muted' });
  }
  // bands stacked bottom up in layer order; a layer that cost extra adds nothing
  const base = points.map(() => 0);
  for (const id of ids) {
    const lower = [...base];
    points.forEach((p, i) => { base[i] += Math.max(0, p.layers[id]); });
    if (base.every((v, i) => v === lower[i])) continue;
    const upper = points.map((_, i) => `${xOf(i)},${y(base[i])}`);
    const back = points.map((_, i) => `${xOf(i)},${y(lower[i])}`).reverse();
    const d = days.length > 1 ? `M${upper.join(' L')} L${back.join(' L')} Z`
      : `M${xOf(0) - 20},${y(base[0])} L${xOf(0) + 20},${y(base[0])} L${xOf(0) + 20},${y(lower[0])} L${xOf(0) - 20},${y(lower[0])} Z`;
    el('path', { d, fill: LAYER_COLORS[id], 'fill-opacity': 0.55, stroke: LAYER_COLORS[id], 'stroke-width': 1 }, svg);
  }
  if (days.length > 1) el('path', { d: `M${points.map((p, i) => `${xOf(i)},${y(p.net)}`).join(' L')}`, fill: 'none', stroke: 'var(--text)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
  const every = Math.ceil(days.length / 12);
  const labels = Object.fromEntries(shown.map(l => [l.id, l.label]));
  points.forEach((p, i) => {
    if (i % every === 0 || i === days.length - 1) {
      text(svg, xOf(i), H - 8, new Date(p.day + 'T12:00').toLocaleDateString(undefined, n <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }), { 'text-anchor': 'middle', class: 'muted' });
    }
    const w = days.length > 1 ? step : 60;
    const hit = el('rect', { x: xOf(i) - w / 2, y: T, width: w, height: H - B - T, fill: 'transparent' }, svg);
    hoverable(hit, () => `<b>By ${new Date(p.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</b><br>Saved ${usd(p.net)} in all<br><span class="muted">${ids.filter(id => p.layers[id]).map(id => `${esc(labels[id])} ${usd(p.layers[id])}`).join(' · ') || 'nothing yet'}</span>`);
  });
}

// ---- bars and table ---------------------------------------------------------
function renderBars(target, rows, key, colors) {
  const groups = [...groupBy(rows, key)].sort((a, b) => valueOf(b[1]) - valueOf(a[1]));
  if (!groups.length) { $(target).innerHTML = '<div class="muted">No requests in this range yet.</div>'; return; }
  const reqs = state.measure === 'requests', money = state.measure === 'cost';
  const max = Math.max(...groups.map(([, v]) => (reqs ? v.requests : money ? v.cost : v.input + v.output)), money ? 1e-9 : 1);
  $(target).replaceChildren(...groups.map(([k, v]) => {
    const div = document.createElement('div');
    div.className = 'bar';
    const dot = key === 'provider' ? `<i class="sw" style="background:${colors[k]};margin-right:6px"></i>` : '';
    const right = reqs ? `${fmt(v.requests)} request${v.requests === 1 ? '' : 's'}`
      : money ? (v.unpriced >= v.requests ? 'no known price' : v.cost ? `${usd(v.cost)} · ${usd(v.cost / Math.max(1, v.requests - v.unpriced))}/request` : 'free')
      : `${short(v.input)} in · ${short(v.output)} out`;
    const track = reqs ? `<i class="req" style="width:${100 * v.requests / max}%"></i>`
      : money ? `<i class="cost" style="width:${100 * v.cost / max}%"></i>`
      : `${v.input ? `<i class="in" style="width:${100 * v.input / max}%"></i>` : ''}${v.output ? `<i class="out" style="width:${100 * v.output / max}%"></i>` : ''}`;
    div.innerHTML = `<div class="top"><span class="name">${dot}${esc(k)}</span><span class="v">${right}</span></div><div class="track">${track}</div>`;
    hoverable(div, () => tipBody(k, v));
    return div;
  }));
}

// Where a model's price came from, for the cost cell's tooltip
function priceNote(name) {
  const p = prices[name];
  const perM = (v) => `$${+(v * 1e6).toPrecision(3)}`;
  if (!p) return priceStatus.gatewayError
    ? `No price: the Gateway’s price list couldn’t be read (${priceStatus.gatewayError}) and config.yaml doesn’t list this model`
    : 'No price: neither the Gateway nor config.yaml lists this model, and its replies didn’t name an OpenRouter model';
  if (p.free) return p.local ? 'Runs on this machine: free' : 'A free model';
  if (p.inputCost == null) return `No price: the Gateway has none for it${p.upstream?.startsWith('openrouter/') ? ' and OpenRouter’s list ' + (priceStatus.ok ? 'doesn’t have it' : 'couldn’t be loaded') : ''}`;
  const cached = p.cacheReadCost != null ? ` · cached input ${perM(p.cacheReadCost)}` : '';
  return `${perM(p.inputCost)} in · ${perM(p.outputCost || 0)} out per million${cached}, from ${p.priceFrom === 'openrouter' ? 'OpenRouter’s price list' : 'the Gateway’s price list'}`;
}

function renderTable(rows) {
  if (!rows.length) { $('rows').innerHTML = '<tr><td colspan="10" class="muted">No requests in this range yet.</td></tr>'; $('rowsTotal').innerHTML = ''; return; }
  const approx = (r) => (r.estimated ? '~' : '');
  $('rows').innerHTML = [...rows].sort((a, b) => valueOf(b) - valueOf(a)).map(r => `<tr>
    <td>${esc(r.client)}</td><td>${esc(r.route)}</td><td><code>${esc(r.model)}</code></td>
    <td><code>${esc(r.servedBy)}</code>${r.servedBy !== r.model ? ' <span class="tag warn">fallback</span>' : ''}</td><td>${esc(r.provider)}</td>
    <td class="num r">${fmt(r.requests)}</td><td class="num r">${approx(r)}${fmt(r.input)}</td><td class="num r">${fmt(r.cacheRead)}</td><td class="num r">${approx(r)}${fmt(r.output)}</td>
    <td class="num r" title="${esc(priceNote(r.servedBy))}">${r.unpriced ? '<span class="muted">?</span>' : r.freeRequests ? '<span class="free">free</span>' : `${approx(r) || '≈ '}${usd(r.cost)}`}</td></tr>`).join('');
  const t = rows.reduce(add, blank());
  $('rowsTotal').innerHTML = `<tr><td colspan="5">Total</td><td class="num r">${fmt(t.requests)}</td><td class="num r">${fmt(t.input)}</td><td class="num r">${fmt(t.cacheRead)}</td><td class="num r">${fmt(t.output)}</td><td class="num r">${usd(t.cost)}${t.unpriced ? ' <span class="muted">+ ?</span>' : ''}</td></tr>`;
}

function render() {
  const rows = price(state.data.rows || []);
  const daily = price(state.data.daily || []);
  const colors = providerColors(rows);
  for (const b of $('range').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === state.days);
  for (const b of $('measure').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === state.measure);
  for (const l of document.querySelectorAll('.legend.io')) l.style.display = state.measure === 'requests' || state.measure === 'cost' ? 'none' : '';
  renderTiles(rows, daily);
  renderSavings(rows, daily);
  renderTimeline(daily, colors);
  $('timeLegend').innerHTML = [...new Set(daily.map(r => r.provider))].sort()
    .map(p => `<span><i class="sw" style="background:${colors[p]}"></i>${esc(p)}</span>`).join('');
  renderFlow(rows, colors);
  renderSankey(rows, colors);
  renderBars('byModel', rows, 'servedBy', colors);
  renderBars('byProvider', rows, 'provider', colors);
  renderTable(rows);
  const since = state.data.since ? `counting since ${new Date(state.data.since).toLocaleString()}` : 'nothing counted yet';
  const noPrices = priceStatus.ok ? '' : ` · OpenRouter prices unavailable (${priceStatus.error}), so its models may show ?`;
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · ${since}${noPrices}`;
}

let priceStatus = { ok: true };
async function loadPrices() {
  try {
    const body = await (await fetch('api/model-info')).json();
    prices = body.models || {};
    priceStatus = { ...(body.openrouter || { ok: true }), gatewayError: body.gatewayError || '' };
  } catch {}
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
setInterval(loadPrices, 5 * 60000);
loadPrices().then(refresh);
