// All users' usage (admins only): totals per person from /ui/api/admin/usage, priced like the Usage page, a chart
// per day, a sortable table and a drill-down for one person. The sums are in userUsage.js. Plain SVG, no libraries.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SVG = 'http://www.w3.org/2000/svg';
const fmt = (n) => Math.round(n).toLocaleString();
const short = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : fmt(n);
const usd = Costs.usd;
const NONE = '~unassigned'; // the address for the person-less bucket
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)', 'var(--link-other)'];

let prices = {};
let priceError = '';
const state = { days: 30, measure: 'cost', sort: { key: 'cost', dir: -1 }, selected: null, data: null, agg: null };
try { Object.assign(state, JSON.parse(localStorage.getItem('usage-users-view') || '{}'), { selected: null, data: null, agg: null }); } catch {}
const saveView = () => { try { localStorage.setItem('usage-users-view', JSON.stringify({ days: state.days, measure: state.measure, sort: state.sort })); } catch {} };

const label = (p) => (p.user ? p.user : state.data?.login ? 'Unassigned (before per-user tracking)' : 'This install (logins are off)');
const tagFor = (p) => (!p.user ? '' : p.guest ? '<span class="tag">guest</span>' : p.role === 'admin' ? '<span class="tag">admin</span>' : p.role ? '' : '<span class="tag warn" title="No longer an account here">removed</span>');
const showV = (n, m = state.measure) => (m === 'cost' ? usd(n) : short(n));
const nameOf = (key) => (key === NONE ? '' : key);

// ---- svg helpers ------------------------------------------------------------
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

// One stacked bar a day, a band per series, sized by the selected measure
function drawStack(svg, legend, stack, ariaNoun) {
  svg.replaceChildren();
  const { days, series } = stack;
  const totals = days.map((_, i) => series.reduce((n, s) => n + s.values[i], 0));
  const max = Math.max(...totals, 0);
  legend.innerHTML = '';
  if (!max) {
    svg.setAttribute('viewBox', '0 0 720 80');
    text(svg, 360, 45, 'Nothing in this range yet.', { 'text-anchor': 'middle', class: 'muted' });
    return;
  }
  const W = 1120, H = 220, L = 64, B = 26, T = 12;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const step = (W - L - 8) / days.length, bw = Math.max(3, Math.min(42, step * 0.66));
  const y = (v) => H - B - (v / max) * (H - B - T);
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    el('line', { x1: L, x2: W - 4, y1: y(v), y2: y(v), class: 'grid' }, svg);
    text(svg, L - 8, y(v) + 4, showV(v), { 'text-anchor': 'end', class: 'muted' });
  }
  const every = Math.ceil(days.length / 12);
  days.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2;
    let top = H - B;
    series.forEach((s, si) => {
      const v = s.values[i];
      if (!v) return;
      const h = (v / max) * (H - B - T);
      top -= h;
      const rect = el('rect', { x, y: top, width: bw, height: Math.max(0.5, h), rx: 2, fill: COLORS[Math.min(si, COLORS.length - 1)], class: 'day-seg' }, svg);
      const when = new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      el('title', {}, rect).textContent = `${s.label} · ${when}: ${showV(v)}${state.measure === 'cost' ? '' : ` ${state.measure}`}`;
    });
    if (i % every === 0 || i === days.length - 1) {
      text(svg, x + bw / 2, H - 8, new Date(d + 'T12:00').toLocaleDateString(undefined, days.length <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }), { 'text-anchor': 'middle', class: 'muted' });
    }
  });
  svg.setAttribute('aria-label', `${ariaNoun} per day, busiest day ${showV(max)}`);
  legend.innerHTML = series.map((s, si) => `<span><i class="sw" style="background:${COLORS[Math.min(si, COLORS.length - 1)]}"></i>${esc(s.label)} <span class="muted">${showV(s.total)}</span></span>`).join('');
}

// ---- the page ---------------------------------------------------------------
const unit = () => (state.measure === 'cost' ? 'Spend' : state.measure === 'tokens' ? 'Tokens' : 'Requests');
const costCell = (p) => (p.unpriced && !p.cost ? '<span class="muted">?</span>' : p.free === p.requests && p.requests ? '<span class="free">free</span>' : `${usd(p.cost)}${p.unpriced ? ' <span class="muted" title="Some requests were on models with no known price">+ ?</span>' : ''}`);

function renderTiles() {
  const t = state.agg.total;
  const tile = (label, v, sub = '', cls = '') => `<div class="card stat${cls}"><div class="label">${label}</div><div class="num">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('tiles').innerHTML = [
    tile('Spend, everyone', usd(t.cost), t.unpriced ? `+ ${fmt(t.unpriced)} request${t.unpriced === 1 ? '' : 's'} with no known price` : 'cached input at cache prices', ' money'),
    tile('Agent runs', usd(t.agentCost), t.cost > 0 ? `${Math.round(100 * t.agentCost / t.cost)}% of spend` : 'model calls made by runs', ' money'),
    tile('Active people', fmt(t.active), `of ${fmt(state.agg.people.length)} listed`),
    tile('Requests', fmt(t.requests), t.requests ? `${Math.round(100 * t.free / t.requests)}% on free or local models` : ''),
    tile('Tokens', short(t.input + t.output), `${short(t.input)} in · ${short(t.output)} out`),
  ].join('');
}

function renderTable() {
  const { key, dir } = state.sort;
  for (const th of document.querySelectorAll('#people th')) {
    const b = th.querySelector('.sort');
    th.setAttribute('aria-sort', b && b.dataset.k === key ? (dir > 0 ? 'ascending' : 'descending') : 'none');
  }
  const people = UserUsage.sorted(state.agg.people, key, dir);
  if (!people.length) { $('peopleRows').innerHTML = '<tr><td colspan="10" class="muted">Nobody yet.</td></tr>'; $('peopleTotal').innerHTML = ''; return; }
  $('peopleRows').innerHTML = people.map((p) => {
    const slug = p.user || NONE;
    const credit = p.credit ? `<span title="$${p.credit.spentUsd.toFixed(2)} spent of a $${p.credit.capUsd.toFixed(2)} cap${p.credit.reservedUsd ? `, $${p.credit.reservedUsd.toFixed(2)} held for running requests` : ''}">${usd(p.credit.leftUsd)} <span class="muted">of ${usd(p.credit.capUsd)}</span></span>` : '<span class="muted">–</span>';
    const top = p.models.length ? p.models.map((m) => `<code title="${fmt(m.requests)} request${m.requests === 1 ? '' : 's'}, ${short(m.tokens)} tokens">${esc(m.name)}</code>`).join(' ') : '<span class="muted">–</span>';
    return `<tr data-user="${esc(slug)}" class="${state.selected === slug ? 'sel' : ''}${p.requests ? '' : ' idle'}">
      <td class="who"><b>${esc(label(p))}</b>${tagFor(p)}</td>
      <td class="num r">${fmt(p.requests)}</td><td class="num r">${fmt(p.input)}</td><td class="num r">${fmt(p.output)}</td>
      <td class="num r">${costCell(p)}</td><td class="num r">${p.agentRequests ? usd(p.agentCost) : '<span class="muted">–</span>'}</td>
      <td class="models">${top}</td>
      <td title="${p.last ? esc(new Date(p.last).toLocaleString()) : ''}">${p.last ? esc(ago(p.last)) : '<span class="muted">never</span>'}</td>
      <td class="num r">${credit}</td>
      <td class="r"><button class="mini" data-open="${esc(slug)}" aria-label="Details for ${esc(label(p))}">Details</button></td></tr>`;
  }).join('');
  const t = state.agg.total;
  $('peopleTotal').innerHTML = `<tr><td>Total</td><td class="num r">${fmt(t.requests)}</td><td class="num r">${fmt(t.input)}</td><td class="num r">${fmt(t.output)}</td><td class="num r">${usd(t.cost)}${t.unpriced ? ' <span class="muted">+ ?</span>' : ''}</td><td class="num r">${usd(t.agentCost)}</td><td colspan="4"></td></tr>`;
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function renderCharts() {
  const today = new Date().toISOString().slice(0, 10);
  const byPerson = UserUsage.stack(pricedDaily(), { days: state.days, today, measure: state.measure, keyOf: (r) => String(r.user || '').toLowerCase(), labelOf: (k) => { const p = state.agg.people.find((x) => x.user.toLowerCase() === k); return p ? label(p) : k; } });
  $('chartTitle').textContent = `${unit()} per day, everyone`;
  drawStack($('all'), $('legend'), byPerson, 'Usage by person');
}

let dailyCache = null;
function pricedDaily() {
  if (!dailyCache) dailyCache = Costs.priceRows((state.data.daily || []).map((r) => ({ ...r })), prices);
  return dailyCache;
}

function renderDetail() {
  const sel = state.selected;
  $('detail').hidden = sel === null;
  if (sel === null) return;
  const who = nameOf(sel);
  const p = state.agg.people.find((x) => x.user.toLowerCase() === who.toLowerCase());
  if (!p) { state.selected = null; $('detail').hidden = true; return; }
  $('detailName').innerHTML = `${esc(label(p))} ${tagFor(p)}`;
  const bits = [];
  if (p.credit) bits.push(`Guest credit: ${usd(p.credit.leftUsd)} left of ${usd(p.credit.capUsd)} (${usd(p.credit.spentUsd)} spent${p.credit.reservedUsd ? `, ${usd(p.credit.reservedUsd)} held for running requests` : ''})`);
  bits.push(p.last ? `Last active ${new Date(p.last).toLocaleString()}` : 'No requests yet');
  if (!p.user) bits.push(state.data.login ? 'Requests counted before per-user tracking, and any with no signed-in person' : 'Logins are off, so every request is counted here');
  $('detailSub').textContent = bits.join(' · ');
  const tile = (l, v, sub = '', cls = '') => `<div class="card stat${cls}"><div class="label">${l}</div><div class="num">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('detailTiles').innerHTML = [
    tile('Spend', costCell(p) , p.unpriced ? `${fmt(p.unpriced)} request${p.unpriced === 1 ? '' : 's'} with no known price` : '', ' money'),
    tile('Agent runs', p.agentRequests ? usd(p.agentCost) : '–', p.agentRequests ? `${fmt(p.agentRequests)} model call${p.agentRequests === 1 ? '' : 's'}` : 'none', ' money'),
    tile('Requests', fmt(p.requests), p.requests ? `${Math.round(100 * p.free / p.requests)}% free` : ''),
    tile('Tokens', short(p.input + p.output), `${short(p.input)} in · ${short(p.output)} out`),
    tile('Cached input', short(p.cacheRead), p.input ? `${Math.round(100 * p.cacheRead / p.input)}% of input` : ''),
  ].join('');
  const today = new Date().toISOString().slice(0, 10);
  const mine = pricedDaily().filter((r) => String(r.user || '').toLowerCase() === who.toLowerCase());
  $('detailChartTitle').textContent = `${unit()} per day, by model`;
  drawStack($('one'), $('detailLegend'), UserUsage.stack(mine, { days: state.days, today, measure: state.measure, keyOf: (r) => r.servedBy }), 'Usage by model');

  const rows = state.agg.rows.filter((r) => String(r.user || '').toLowerCase() === who.toLowerCase());
  const byModel = new Map();
  for (const r of rows) {
    const key = `${r.servedBy}|${r.provider}`;
    const t = byModel.get(key) || { servedBy: r.servedBy, provider: r.provider, requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, unpriced: 0, free: 0, estimated: 0 };
    for (const k of ['requests', 'input', 'output', 'cacheRead', 'cost', 'unpriced', 'estimated']) t[k] += r[k] || 0;
    t.free += r.freeRequests || 0;
    byModel.set(key, t);
  }
  const models = [...byModel.values()].sort((a, b) => UserUsage.valueOf(b, state.measure) - UserUsage.valueOf(a, state.measure));
  $('detailModels').innerHTML = models.length ? models.map((m) => `<tr><td><code>${esc(m.servedBy)}</code></td><td>${esc(m.provider)}</td><td class="num r">${fmt(m.requests)}</td><td class="num r">${m.estimated ? '~' : ''}${fmt(m.input)}</td><td class="num r">${fmt(m.cacheRead)}</td><td class="num r">${m.estimated ? '~' : ''}${fmt(m.output)}</td><td class="num r">${m.unpriced ? '<span class="muted" title="No known price">?</span>' : m.free === m.requests ? '<span class="free">free</span>' : usd(m.cost)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No requests in this range.</td></tr>';
  const byClient = new Map();
  for (const r of rows) {
    const t = byClient.get(r.client) || { client: r.client, requests: 0, tokens: 0, cost: 0, unpriced: 0 };
    t.requests += r.requests; t.tokens += r.input + r.output; t.cost += r.cost; t.unpriced += r.unpriced;
    byClient.set(r.client, t);
  }
  $('detailClients').innerHTML = byClient.size ? [...byClient.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).map((c) => `<tr><td>${esc(c.client)}</td><td class="num r">${fmt(c.requests)}</td><td class="num r">${short(c.tokens)}</td><td class="num r">${c.unpriced && !c.cost ? '<span class="muted">?</span>' : usd(c.cost)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No requests in this range.</td></tr>';
}

function render() {
  for (const b of $('range').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === state.days);
  for (const b of $('measure').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === state.measure);
  if (!state.data) return;
  dailyCache = null;
  state.agg = UserUsage.aggregate(state.data, prices);
  renderTiles();
  renderCharts();
  renderTable();
  renderDetail();
  const note = state.data.login ? '' : 'Logins are off (HARNESS_REQUIRE_LOGIN), so all usage is counted together. Turn logins on to count each person separately.';
  $('notice').hidden = !note;
  $('notice').textContent = note;
  const noPrices = priceError ? ` · prices unavailable (${priceError}), costs may show ?` : '';
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}${state.data.since ? ` · counting since ${new Date(state.data.since).toLocaleDateString()}` : ''}${noPrices}`;
  $('priceNote').textContent = state.agg.total.unpriced ? `${fmt(state.agg.total.unpriced)} request${state.agg.total.unpriced === 1 ? '' : 's'} used models with no known price, so costs are a minimum. The Usage page explains where prices come from.` : '';
  $('clear').hidden = false;
  if (state.data.creditError) $('priceNote').textContent += ` Guest credit could not be read: ${state.data.creditError}`;
}

async function loadPrices() {
  try {
    const res = await fetch('api/model-info');
    const body = await res.json();
    prices = body.models || {};
    priceError = body.gatewayError && !Object.keys(prices).length ? body.gatewayError : '';
  } catch (err) { priceError = err.message; }
}

async function refresh() {
  try {
    const res = await fetch(`api/admin/usage?days=${state.days}`, { credentials: 'same-origin' });
    if (res.status === 403) { $('updated').textContent = ''; $('notice').hidden = false; $('notice').textContent = 'Only admins can see everyone’s usage.'; $('tiles').innerHTML = ''; $('peopleRows').innerHTML = ''; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    render();
  } catch (err) {
    $('updated').textContent = `Couldn’t load usage: ${err.message}`;
  }
}

function select(slug) {
  state.selected = slug;
  history.replaceState(null, '', slug === null ? location.pathname + location.search : `#user=${encodeURIComponent(slug)}`);
  renderTable();
  renderDetail();
  if (slug !== null) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.days = Number(b.dataset.days); saveView(); refresh(); });
$('measure').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.measure = b.dataset.m; saveView(); render(); });
$('people').addEventListener('click', (e) => {
  const sort = e.target.closest('.sort');
  if (sort) {
    const k = sort.dataset.k;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === 'name' ? 1 : -1 };
    saveView(); renderTable(); return;
  }
  const open = e.target.closest('[data-open]');
  if (open) select(open.dataset.open);
});
$('detailClose').addEventListener('click', () => select(null));
$('clear').addEventListener('click', async () => {
  if (!await ui.confirm('Delete every person’s saved usage totals? This cannot be undone.', { ok: 'Delete totals' })) return;
  const res = await fetch('api/usage/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!res.ok) { ui.toast((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`, { kind: 'error' }); return; }
  ui.toast('Usage totals cleared');
  refresh();
});

const fromHash = /^#user=(.*)$/.exec(location.hash);
if (fromHash) { try { state.selected = decodeURIComponent(fromHash[1]); } catch {} }
if (![7, 30, 0].includes(state.days)) state.days = 30;
if (!['cost', 'tokens', 'requests'].includes(state.measure)) state.measure = 'cost';
render();
setInterval(refresh, 60000);
loadPrices().then(refresh);
